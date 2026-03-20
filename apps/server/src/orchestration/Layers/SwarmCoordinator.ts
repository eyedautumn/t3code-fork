import {
  CommandId,
  MessageId,
  ThreadId,
  SWARM_OPERATOR_TARGET_ID,
  type OrchestrationEvent,
  type ProviderKind,
  type ProviderRuntimeEvent,
  DEFAULT_PROVIDER_KIND,
  type SwarmAgent,
  type SwarmAgentStatus,
  type SwarmConfig,
  type SwarmState,
  type SwarmTask,
  type SwarmTaskStatus,
  type RuntimeContentStreamKind,
} from "@t3tools/contracts";
import { getDefaultModel } from "@t3tools/shared/model";
import { Effect, Layer, Option, Queue, Stream } from "effect";
import { safeCauseMessage } from "@t3tools/shared/cause";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  decodeSwarmSessionThreadId,
  encodeSwarmSessionThreadId,
  isSwarmSessionThreadId,
} from "../SwarmSessionCodec.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SwarmCoordinator, type SwarmCoordinatorShape } from "../Services/SwarmCoordinator.ts";
import { ServerConfig } from "../../config.ts";
import { getSwarmRoleInstructions } from "../SwarmInstructions.ts";

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:swarm:${tag}:${crypto.randomUUID()}`);

const RUNTIME_STATE_TO_STATUS: Record<string, SwarmAgentStatus> = {
  starting: "starting",
  ready: "ready",
  running: "running",
  waiting: "running",
  stopped: "stopped",
  error: "error",
};

const DEFAULT_STATUS: SwarmAgentStatus = "idle";

type SwarmRuntimeAgent = {
  providerThreadId: ThreadId;
  status: SwarmAgentStatus;
  lastError: string | null;
  statusUpdatedAt: string;
  replyTargetAgentId?: string | null;
  buffered?: {
    messageId: MessageId;
    turnKey: string;
    createdAt: string;
    text: string;
  };
  reasoningBuffered?: {
    messageId: MessageId;
    turnKey: string;
    createdAt: string;
    text: string;
  };
};

type SwarmRuntime = {
  config: SwarmConfig;
  agents: Map<string, SwarmRuntimeAgent>;
  tasks: Map<string, SwarmTask>;
  started: boolean;
  stopping: boolean;
};

const SWARM_MESSAGE_TOOL_REGEX =
  /\[\[swarm\.message(?:\s+target=(?<targetBracket>[^\]]+))?\]\]\s*/i;
const SWARM_MESSAGE_BRACKET_REGEX = /\[swarm\.message\s+(?<targetSquare>[^\]]+)\]\s*/i;
const SWARM_MESSAGE_CLOSE_REGEX = /\[swarm\.message_close\]\s*/i;
const MESSAGE_SWARM_TOOL_REGEX =
  /\[\[message_swarm(?:\s+target=(?<targetBracketAlias>[^\]]+))?\]\]\s*/i;
const MESSAGE_SWARM_BRACKET_REGEX = /\[message_swarm\s+(?<targetSquareAlias>[^\]]+)\]\s*/i;
const MESSAGE_SWARM_CLOSE_REGEX = /\[message_swarm_close\]\s*/i;
const MESSAGE_SWARM_FUNCTION_REGEX =
  /send_message_swarm\(\s*(?<targetFunction>(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,)]+?))\s*,\s*(?<bodyFunction>[\s\S]*?)\s*\)/i;

type ParsedSwarmMessageTool =
  | { close: true; remainder: string }
  | { close: false; targetRaw: string; body: string; remainder: string };

type ResolvedSwarmTargets = {
  agentIds: string[];
  toOperator: boolean;
};

function normalizeTargetToken(raw: string): string {
  let token = raw.trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  token = token.replace(/^[^\p{L}\p{N}_:-]+|[^\p{L}\p{N}_:-]+$/gu, "");
  return token;
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  const prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  const next = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = 0; i < left.length; i += 1) {
    next[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1;
      const insertCost = (next[j] ?? 0) + 1;
      const deleteCost = (prev[j + 1] ?? 0) + 1;
      const replaceCost = (prev[j] ?? 0) + cost;
      next[j + 1] = Math.min(insertCost, deleteCost, replaceCost);
    }
    for (let j = 0; j <= right.length; j += 1) {
      prev[j] = next[j] ?? 0;
    }
  }
  return prev[right.length] ?? Number.MAX_SAFE_INTEGER;
}

function resolveClosestSwarmAgent(runtime: SwarmRuntime, normalizedTarget: string): string[] {
  if (normalizedTarget.length === 0) return [];
  const aliasTarget =
    normalizedTarget === "coord" ||
    normalizedTarget === "lead" ||
    normalizedTarget === "manager" ||
    normalizedTarget === "teamlead"
      ? "coordinator"
      : normalizedTarget;

  const targetTokens = aliasTarget
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const candidates = runtime.config.agents.map((agent) => ({
    id: agent.id,
    aliases: [agent.id.toLowerCase(), agent.name.toLowerCase(), agent.role.toLowerCase()],
  }));

  const prefixMatches = candidates.filter((candidate) =>
    candidate.aliases.some((alias) => alias.startsWith(aliasTarget) || aliasTarget.startsWith(alias)),
  );
  if (prefixMatches.length > 0) {
    return prefixMatches.map((candidate) => candidate.id);
  }

  if (targetTokens.length > 0) {
    const tokenMatches = candidates
      .map((candidate) => ({
        id: candidate.id,
        score: candidate.aliases.reduce((best, alias) => {
          const aliasTokens = alias
            .split(/[^a-z0-9]+/i)
            .map((token) => token.trim())
            .filter((token) => token.length > 0);
          const exactTokenHits = targetTokens.filter((token) => aliasTokens.includes(token)).length;
          const partialTokenHits = targetTokens.filter((token) =>
            aliasTokens.some((aliasToken) =>
              aliasToken.includes(token) || token.includes(aliasToken),
            ),
          ).length;
          return Math.max(best, exactTokenHits * 10 + partialTokenHits);
        }, 0),
      }))
      .filter((candidate) => candidate.score > 0)
      .toSorted((left, right) => right.score - left.score);

    const bestTokenMatch = tokenMatches[0];
    if (bestTokenMatch) {
      return tokenMatches
        .filter((candidate) => candidate.score === bestTokenMatch.score)
        .map((candidate) => candidate.id);
    }
  }

  const scored = candidates
    .map((candidate) => ({
      id: candidate.id,
      score: Math.min(...candidate.aliases.map((alias) => levenshteinDistance(aliasTarget, alias))),
    }))
    .toSorted((left, right) => left.score - right.score);

  const best = scored[0];
  if (!best) return [];
  if (best.score > 3) return [];
  return scored.filter((entry) => entry.score === best.score).map((entry) => entry.id);
}

function parseSwarmMessageTool(text: string): ParsedSwarmMessageTool | null {
  const closeMatch = SWARM_MESSAGE_CLOSE_REGEX.exec(text);
  const closeAliasMatch = MESSAGE_SWARM_CLOSE_REGEX.exec(text);
  const closeToken = (() => {
    if (closeMatch && closeAliasMatch) {
      return closeMatch.index <= closeAliasMatch.index ? closeMatch : closeAliasMatch;
    }
    return closeMatch ?? closeAliasMatch;
  })();

  const doubleMatch = SWARM_MESSAGE_TOOL_REGEX.exec(text);
  const bracketMatch = SWARM_MESSAGE_BRACKET_REGEX.exec(text);
  const doubleAliasMatch = MESSAGE_SWARM_TOOL_REGEX.exec(text);
  const bracketAliasMatch = MESSAGE_SWARM_BRACKET_REGEX.exec(text);
  const functionMatch = MESSAGE_SWARM_FUNCTION_REGEX.exec(text);
  const match = (() => {
    const allMatches = [doubleMatch, bracketMatch, doubleAliasMatch, bracketAliasMatch, functionMatch].filter(
      (candidate): candidate is RegExpExecArray => candidate !== null,
    );
    if (allMatches.length === 0) {
      return null;
    }
    return allMatches.reduce((earliest, candidate) =>
      candidate.index < earliest.index ? candidate : earliest,
    );
  })();
  if (closeToken && (!match || closeToken.index < match.index)) {
    const beforeClose = text.slice(0, closeToken.index).trim();
    if (beforeClose.length === 0) {
      const remainder = text.slice(closeToken.index + closeToken[0].length);
      return { close: true, remainder };
    }
    return null;
  }
  const targetRaw = (
    match?.groups?.targetBracket ??
    match?.groups?.targetSquare ??
    match?.groups?.targetBracketAlias ??
    match?.groups?.targetSquareAlias ??
    match?.groups?.targetFunction ??
    ""
  ).trim();
  if (!match || targetRaw.length === 0) return null;

  const normalizedTarget = normalizeTargetToken(targetRaw);
  if (normalizedTarget.length === 0) return null;

  const startIndex = match?.index ?? 0;
  const remainder = text.slice(startIndex + match[0].length);
  const functionBody = match?.groups?.bodyFunction?.trim();
  const rawBody = functionBody && functionBody.length > 0 ? functionBody : remainder;
  const closeIndex = (() => {
    const closeIndices = [SWARM_MESSAGE_CLOSE_REGEX.exec(rawBody)?.index, MESSAGE_SWARM_CLOSE_REGEX.exec(rawBody)?.index]
      .filter((index): index is number => index !== undefined);
    if (closeIndices.length === 0) {
      return -1;
    }
    return Math.min(...closeIndices);
  })();
  const body = (closeIndex >= 0 ? rawBody.slice(0, closeIndex) : rawBody).trim();
  if (!body) return null;

  return { close: false, targetRaw: normalizedTarget, body, remainder };
}

function stripSwarmCloseTokens(text: string): { hasClose: boolean; body: string } {
  const hasClose = SWARM_MESSAGE_CLOSE_REGEX.test(text) || MESSAGE_SWARM_CLOSE_REGEX.test(text);
  const body = text
    .replace(SWARM_MESSAGE_CLOSE_REGEX, "")
    .replace(MESSAGE_SWARM_CLOSE_REGEX, "")
    .trim();
  return { hasClose, body };
}

function resolveSwarmMessageTargets(runtime: SwarmRuntime, targetRaw: string | null): ResolvedSwarmTargets {
  if (!targetRaw) {
    return { agentIds: [], toOperator: false };
  }
  const normalized = normalizeTargetToken(targetRaw).toLowerCase();
  if (normalized === "operator" || normalized === "you") {
    return { agentIds: [], toOperator: true };
  }
  const agents = runtime.config.agents;
  const matchById = agents.filter((agent) => agent.id.toLowerCase() === normalized);
  if (matchById.length > 0) {
    return { agentIds: matchById.map((agent) => agent.id), toOperator: false };
  }
  const matchByName = agents.filter((agent) => agent.name.toLowerCase() === normalized);
  if (matchByName.length > 0) {
    return { agentIds: matchByName.map((agent) => agent.id), toOperator: false };
  }
  const matchByRole = agents.filter((agent) => agent.role.toLowerCase() === normalized);
  if (matchByRole.length > 0) {
    return { agentIds: matchByRole.map((agent) => agent.id), toOperator: false };
  }
  if (normalized.includes(":")) {
    const [prefix, rest] = normalized.split(":", 2);
    if (rest) {
      const trimmed = rest.trim();
      if (prefix === "role") {
        const matches = agents.filter((agent) => agent.role.toLowerCase() === trimmed);
        if (matches.length > 0) {
          return { agentIds: matches.map((agent) => agent.id), toOperator: false };
        }
      } else if (prefix === "agent") {
        const matches = agents.filter((agent) => agent.id.toLowerCase() === trimmed);
        if (matches.length > 0) {
          return { agentIds: matches.map((agent) => agent.id), toOperator: false };
        }
      } else if (prefix === "name") {
        const matches = agents.filter((agent) => agent.name.toLowerCase() === trimmed);
        if (matches.length > 0) {
          return { agentIds: matches.map((agent) => agent.id), toOperator: false };
        }
      }
    }
  }
  const closest = resolveClosestSwarmAgent(runtime, normalized);
  return { agentIds: closest, toOperator: false };
}


type RuntimeInput =
  | { source: "domain"; event: OrchestrationEvent }
  | { source: "provider"; event: ProviderRuntimeEvent };

function buildDeveloperInstructions(
  config: SwarmConfig,
  agent: SwarmAgent,
  taskContext: string | null,
  _swarmTasksEnabled: boolean,
  threadId: ThreadId,
): string {
  const roleInstructions = getSwarmRoleInstructions(agent.role);

  const missionContext = [
    `## Mission`,
    config.mission,
    config.targetPath ? `Target path: ${config.targetPath}` : null,
  ].filter(Boolean).join("\n");

  const taskSection = taskContext
    ? [
        "## Your Tasks",
        taskContext,
      ].join("\n")
    : null;

  const rosterSection = [
    "## Swarm Roster",
    ...config.agents.map(
      (member) =>
        `- ${member.id}: ${member.name} (${member.role})${member.id === agent.id ? " [you]" : ""}`,
    ),
    "- When messaging another teammate, prefer the exact agent id from this roster.",
  ].join("\n");

  const lines = [
    roleInstructions,
    "## Coordination Rules",
    "- Act like a disciplined BridgeSwarm team: plan first, assign file ownership, then build/review with zero overlap.",
    "- Each message should move the mission forward (status, decision, assignment, result). Avoid narrative.",
    "- Keep one active task per agent; if you need ownership changes, escalate to coordinator.",
    "- Builders/reviewers must only touch owned files; scouts never edit code.",
    missionContext,
    taskSection,
    rosterSection,
    config.startPrompt ? `## Additional Context\n${config.startPrompt}` : null,
    "## Thread & Communication APIs",
    `Thread ID: ${threadId}`,
    "- Send targeted messages inline in your final response, anytime (mid-turn is fine):",
    "  * Preferred: `[swarm.message <TARGET>] <message>`",
    "  * Also accepted: `[[swarm.message target=<TARGET>]] <message>`, `[message_swarm <TARGET>] <message>`, or `send_message_swarm(<TARGET>, <message>)`",
    "- Close out a conversation thread if you need to signal completion: `[swarm.message_close]` or `[message_swarm_close]`.",
    "- TARGET may be agent id, agent name, role name (`builder`, `reviewer`, `scout`, `coordinator`), or `operator`.",
    "- Use messages to assign tasks, request help, hand off for review, or report completion with verification steps.",
    "## Definition of Done for this mission",
    "- Clear task breakdown with ownership, completed implementation, and review/validation notes.",
    "- No conflicting edits; all tasks reported with status and next action or completion.",
  ];

  return lines.join("\n\n");
}

function buildMinimalStartPrompt(): string {
  return `Start the swarm. Use the instructions to coordinate, message teammates, and ship the mission.`;
}

function mapRuntimeState(state: string | undefined): SwarmAgentStatus {
  if (!state) return DEFAULT_STATUS;
  return RUNTIME_STATE_TO_STATUS[state] ?? DEFAULT_STATUS;
}

function toTurnKey(threadId: ThreadId, agentId: string, turnId?: string): string {
  return `${threadId}:${agentId}:${turnId ?? "unknown"}`;
}

const ACTIVE_TASK_STATUSES = new Set<SwarmTaskStatus>(["queued", "building", "review"]);
const sortTasks = (tasks: Iterable<SwarmTask>): SwarmTask[] =>
  Array.from(tasks).toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

function tasksForAgent(runtime: SwarmRuntime, agent: SwarmAgent): SwarmTask[] {
  const tasks = sortTasks(runtime.tasks.values());
  switch (agent.role) {
    case "coordinator":
      return tasks;
    case "builder":
      return tasks.filter((task) => task.ownerAgentId === agent.id);
    case "reviewer":
      return tasks.filter((task) => task.status === "review" && task.ownerAgentId !== agent.id).slice(0, 1);
    case "scout":
      return tasks.filter((task) => task.ownerAgentId === agent.id || task.status === "queued").slice(0, 1);
    default:
      return [];
  }
}

function renderTaskContext(runtime: SwarmRuntime, agent: SwarmAgent): string | null {
  if (runtime.tasks.size === 0) return null;
  const relevantTasks = tasksForAgent(runtime, agent);
  if (relevantTasks.length === 0) return null;
  const lines = relevantTasks.map(
    (task) =>
      `- [${task.status}] ${task.id}: ${task.goal} (owner: ${task.ownerAgentId ?? "unassigned"}; files: ${
        task.ownedFiles.length > 0 ? task.ownedFiles.join(", ") : "none"
      }; deps: ${task.dependsOnTaskIds.join(", ") || "none"})`,
  );
  return [`[TaskContext]`, ...lines].join("\n");
}

const isTaskModeEnabled = (runtime: SwarmRuntime, enableFromServer: boolean): boolean =>
  enableFromServer || runtime.config.enableTasks === true;

export const makeSwarmCoordinator = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const serverConfig = yield* ServerConfig;
  const serverSwarmTasksEnabled = serverConfig.enableSwarmTasks;

  const swarmByThreadId = new Map<string, SwarmRuntime>();

  const dispatchStatus = (
    threadId: ThreadId,
    agentId: string,
    status: SwarmAgentStatus,
    updatedAt: string,
    lastError: string | null = null,
  ) =>
    orchestrationEngine
      .dispatch({
        type: "swarm.agent.status.set",
        commandId: serverCommandId("status"),
        threadId,
        agentId,
        status,
        lastError,
        updatedAt,
        createdAt: updatedAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("swarm status dispatch failed", {
            cause: safeCauseMessage(cause),
            threadId,
            agentId,
          }),
        ),
        Effect.asVoid,
      );

  const dispatchMessageAppend = (input: {
    threadId: ThreadId;
    messageId: MessageId;
    sender: "agent" | "operator";
    senderAgentId: string | null;
    targetAgentId: string | null;
    text: string;
    streaming: boolean;
    createdAt: string;
    updatedAt: string;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "swarm.agent.message.append",
        commandId: serverCommandId("message"),
        threadId: input.threadId,
        messageId: input.messageId,
        sender: input.sender,
        senderAgentId: input.senderAgentId,
        targetAgentId: input.targetAgentId,
        text: input.text,
        streaming: input.streaming,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("swarm message dispatch failed", {
            cause: safeCauseMessage(cause),
            threadId: input.threadId,
            agentId: input.senderAgentId,
          }),
        ),
        Effect.asVoid,
      );

  const dispatchSystemNotice = (input: {
    threadId: ThreadId;
    text: string;
    createdAt: string;
    targetAgentId?: string | null;
  }) =>
    dispatchMessageAppend({
      threadId: input.threadId,
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      sender: "operator",
      senderAgentId: null,
      targetAgentId: input.targetAgentId ?? SWARM_OPERATOR_TARGET_ID,
      text: input.text,
      streaming: false,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });

  const upsertRuntimeTask = (threadId: ThreadId, task: SwarmTask) =>
    Effect.sync(() => {
      const runtime = swarmByThreadId.get(String(threadId));
      if (!runtime) return;
      runtime.tasks.set(task.id, task);
    });

  const dispatchTaskCreated = (input: { threadId: ThreadId; task: SwarmTask }) =>
    orchestrationEngine
      .dispatch({
        type: "swarm.task.created",
        commandId: serverCommandId("task-create"),
        threadId: input.threadId,
        task: input.task,
        createdAt: input.task.createdAt,
      })
      .pipe(
        Effect.tap(() => upsertRuntimeTask(input.threadId, input.task)),
        Effect.catchCause((cause) =>
          Effect.logWarning("swarm task create dispatch failed", {
            cause: safeCauseMessage(cause),
            threadId: input.threadId,
            taskId: input.task.id,
          }),
        ),
        Effect.asVoid,
      );

  const dispatchTaskUpdated = (input: { threadId: ThreadId; task: SwarmTask }) =>
    orchestrationEngine
      .dispatch({
        type: "swarm.task.updated",
        commandId: serverCommandId("task-update"),
        threadId: input.threadId,
        task: input.task,
        createdAt: input.task.updatedAt,
      })
      .pipe(
        Effect.tap(() => upsertRuntimeTask(input.threadId, input.task)),
        Effect.catchCause((cause) =>
          Effect.logWarning("swarm task update dispatch failed", {
            cause: safeCauseMessage(cause),
            threadId: input.threadId,
            taskId: input.task.id,
          }),
        ),
        Effect.asVoid,
      );

  const dispatchTaskBlocked = (input: {
    threadId: ThreadId;
    taskId: SwarmTask["id"];
    updatedAt: string;
    reason: string;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "swarm.task.blocked",
        commandId: serverCommandId("task-block"),
        threadId: input.threadId,
        taskId: input.taskId,
        updatedAt: input.updatedAt,
        reason: input.reason,
        createdAt: input.updatedAt,
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const runtime = swarmByThreadId.get(String(input.threadId));
            const existing = runtime?.tasks.get(input.taskId);
            if (runtime && existing) {
              runtime.tasks.set(input.taskId, {
                ...existing,
                status: "blocked",
                updatedAt: input.updatedAt,
              });
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("swarm task block dispatch failed", {
            cause: safeCauseMessage(cause),
            threadId: input.threadId,
            taskId: input.taskId,
          }),
        ),
        Effect.asVoid,
      );

  const dispatchTaskCompleted = (input: {
    threadId: ThreadId;
    taskId: SwarmTask["id"];
    updatedAt: string;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "swarm.task.completed",
        commandId: serverCommandId("task-complete"),
        threadId: input.threadId,
        taskId: input.taskId,
        updatedAt: input.updatedAt,
        createdAt: input.updatedAt,
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const runtime = swarmByThreadId.get(String(input.threadId));
            const existing = runtime?.tasks.get(input.taskId);
            if (runtime && existing) {
              runtime.tasks.set(input.taskId, {
                ...existing,
                status: "done",
                updatedAt: input.updatedAt,
              });
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("swarm task complete dispatch failed", {
            cause: safeCauseMessage(cause),
            threadId: input.threadId,
            taskId: input.taskId,
          }),
        ),
        Effect.asVoid,
      );

  const setTaskStatus = (
    threadId: ThreadId,
    task: SwarmTask,
    status: SwarmTaskStatus,
    updatedAt: string,
    reason?: string,
  ) => {
    if (task.status === status) {
      return Effect.void;
    }
    if (status === "blocked") {
      return dispatchTaskBlocked({
        threadId,
        taskId: task.id,
        updatedAt,
        reason: reason ?? "blocked by coordinator",
      });
    }
    if (status === "done") {
      return dispatchTaskCompleted({ threadId, taskId: task.id, updatedAt });
    }
    const nextTask: SwarmTask = { ...task, status, updatedAt };
    return dispatchTaskUpdated({ threadId, task: nextTask });
  };

  const resolveSwarmState = Effect.fnUntraced(function* (threadId: ThreadId) {
    const existing = swarmByThreadId.get(String(threadId));
    if (existing) {
      return {
        config: existing.config,
        tasks: Array.from(existing.tasks.values()),
      } satisfies Pick<SwarmState, "config" | "tasks">;
    }
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId && entry.swarm);
    if (!thread?.swarm) {
      return null;
    }
    return {
      config: thread.swarm.config,
      tasks: thread.swarm.tasks,
    } satisfies Pick<SwarmState, "config" | "tasks">;
  });

  const ensureSwarmRuntime = (threadId: ThreadId) =>
    Effect.gen(function* () {
      let retries = 0;
      const maxRetries = 10;
      while (retries < maxRetries) {
        const swarmState = yield* resolveSwarmState(threadId);
        if (swarmState) {
          const existing = swarmByThreadId.get(String(threadId));
          if (existing) {
            return Option.some(existing);
          }
          const runtime: SwarmRuntime = {
            config: swarmState.config,
            agents: new Map(),
            tasks: new Map((swarmState.tasks ?? []).map((task) => [task.id, task])),
            started: false,
            stopping: false,
          };
          swarmByThreadId.set(String(threadId), runtime);
          return Option.some(runtime);
        }
        retries++;
        if (retries < maxRetries) {
          yield* Effect.sleep(100);
        }
      }
      yield* Effect.logWarning("ensureSwarmRuntime: failed after max retries", { threadId });
      return Option.none<SwarmRuntime>();
    });

  const startAgentSession = (input: {
    threadId: ThreadId;
    agent: SwarmAgent;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const runtime = swarmByThreadId.get(String(input.threadId));
      if (!runtime) {
        yield* Effect.logWarning("startAgentSession skipped: no runtime", { threadId: input.threadId, agentId: input.agent.id });
        return;
      }
      const providerThreadId = encodeSwarmSessionThreadId(input.threadId, input.agent.id);
      const agentState: SwarmRuntimeAgent = {
        providerThreadId,
        status: "starting",
        lastError: null,
        statusUpdatedAt: input.createdAt,
      };
      runtime.agents.set(input.agent.id, agentState);
      yield* dispatchStatus(input.threadId, input.agent.id, "starting", input.createdAt);

      const explicitModel = input.agent.model;
      const providerFromModel =
        typeof explicitModel === "string" && explicitModel.startsWith("opencode/")
          ? "opencode"
          : typeof explicitModel === "string" && explicitModel.includes("/")
            ? (explicitModel.split("/")[0] as ProviderKind)
            : undefined;
      const provider: ProviderKind = input.agent.provider ?? providerFromModel ?? DEFAULT_PROVIDER_KIND;
      const model = typeof explicitModel === "string" && explicitModel.trim().length > 0
        ? explicitModel
        : getDefaultModel(provider);
      yield* Effect.logDebug("starting agent session", { threadId: input.threadId, agentId: input.agent.id, provider, model });

      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === input.threadId);
      const cwd = thread ? resolveThreadWorkspaceCwd({ thread, projects: readModel.projects }) : null;

      const session = yield* providerService.startSession(providerThreadId, {
        threadId: providerThreadId,
        provider,
        model,
        modelOptions: input.agent.modelOptions,
        serviceTier: input.agent.serviceTier === "flex" ? null : input.agent.serviceTier ?? null,
        runtimeMode: input.agent.runtimeMode,
        providerOptions: undefined,
        cwd: cwd ?? undefined,
      });

      agentState.status = mapRuntimeState(session.status);
      agentState.lastError = session.lastError ?? null;
      agentState.statusUpdatedAt = session.updatedAt ?? input.createdAt;
      yield* dispatchStatus(
        input.threadId,
        input.agent.id,
        agentState.status,
        agentState.statusUpdatedAt,
        agentState.lastError,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const runtime = swarmByThreadId.get(String(input.threadId));
          if (runtime) {
            runtime.agents.delete(input.agent.id);
          }
          const failedAt = new Date().toISOString();
          const detail = safeCauseMessage(cause);
          yield* dispatchStatus(
            input.threadId,
            input.agent.id,
            "error",
            failedAt,
            detail,
          );
          yield* dispatchSystemNotice({
            threadId: input.threadId,
            createdAt: failedAt,
            targetAgentId: SWARM_OPERATOR_TARGET_ID,
            text: `Failed to start swarm agent '${input.agent.name}' (${input.agent.id}): ${detail}`,
          });
        }),
      ),
    );

  const sendTurnToAgent = (input: {
    threadId: ThreadId;
    agent: SwarmAgent;
    text: string;
    createdAt: string;
    includeTaskContext?: boolean;
    replyTargetAgentId?: string | null;
  }) =>
    Effect.gen(function* () {
      const runtime = swarmByThreadId.get(String(input.threadId));
      if (!runtime) {
        yield* Effect.logWarning("swarm sendTurn skipped: no runtime", { threadId: input.threadId, agentId: input.agent.id });
        return;
      }
      const agentState = runtime.agents.get(input.agent.id);
      if (!agentState) {
        yield* Effect.logDebug("swarm sendTurn: starting agent session", { threadId: input.threadId, agentId: input.agent.id });
        yield* startAgentSession({ threadId: input.threadId, agent: input.agent, createdAt: input.createdAt });
      }
      const providerThreadId = runtime.agents.get(input.agent.id)?.providerThreadId;
      if (!providerThreadId) {
        yield* Effect.logWarning("swarm sendTurn skipped: no provider thread id", { threadId: input.threadId, agentId: input.agent.id });
        return;
      }
      const activeAgentState = runtime.agents.get(input.agent.id);
      if (activeAgentState) {
        activeAgentState.replyTargetAgentId = input.replyTargetAgentId ?? null;
      }
      const taskModeEnabled = isTaskModeEnabled(runtime, serverSwarmTasksEnabled);
      const taskContext =
        taskModeEnabled && input.includeTaskContext !== false
          ? renderTaskContext(runtime, input.agent)
          : null;
      const developerInstructions = buildDeveloperInstructions(
        runtime.config,
        input.agent,
        taskContext,
        taskModeEnabled,
        input.threadId,
      );
      const textWithContext = taskContext ? `${taskContext}\n\n${input.text}` : input.text;
      yield* providerService
        .sendTurn({
          threadId: providerThreadId,
          input: textWithContext,
          model: input.agent.model,
          serviceTier: input.agent.serviceTier === "flex" ? null : input.agent.serviceTier ?? null,
          modelOptions: input.agent.modelOptions,
          interactionMode: input.agent.interactionMode,
          developerInstructions,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const detail = safeCauseMessage(cause);
              const failedAt = new Date().toISOString();
              yield* Effect.logWarning("swarm sendTurn failed", {
                cause: detail,
                threadId: input.threadId,
                agentId: input.agent.id,
              });
              const runtime = swarmByThreadId.get(String(input.threadId));
              const agentState = runtime?.agents.get(input.agent.id);
              if (agentState) {
                agentState.status = "error";
                agentState.lastError = detail;
                agentState.statusUpdatedAt = failedAt;
              }
              yield* dispatchStatus(input.threadId, input.agent.id, "error", failedAt, detail);
              yield* dispatchSystemNotice({
                threadId: input.threadId,
                createdAt: failedAt,
                targetAgentId: SWARM_OPERATOR_TARGET_ID,
                text: `Failed to send swarm prompt to '${input.agent.name}' (${input.agent.id}): ${detail}`,
              });
            }),
          ),
          Effect.asVoid,
        );
    });

  const tryHandleAgentDirectedMessage = (
    runtime: SwarmRuntime,
    threadId: ThreadId,
    agentId: string,
    messageId: MessageId,
    bufferedCreatedAt: string,
    eventCreatedAt: string,
    bufferedText: string,
  ) =>
    Effect.gen(function* () {
      const parsed = parseSwarmMessageTool(bufferedText);
      if (!parsed) {
        return false;
      }
      if (parsed.close) {
        return true;
      }
      const resolved = resolveSwarmMessageTargets(runtime, parsed.targetRaw);
      if (!resolved.toOperator && resolved.agentIds.length === 0) {
        yield* dispatchSystemNotice({
          threadId,
          createdAt: eventCreatedAt,
          targetAgentId: SWARM_OPERATOR_TARGET_ID,
          text: `Unresolved swarm target '${parsed.targetRaw}' from ${agentId}. Known agents: ${runtime.config.agents.map((entry) => entry.id).join(", ")}`,
        });
        return false;
      }
      const logTargets = resolved.toOperator
        ? [SWARM_OPERATOR_TARGET_ID]
        : resolved.agentIds.length > 0
          ? resolved.agentIds
          : [parsed.targetRaw];
      for (const targetAgentId of logTargets) {
        yield* dispatchMessageAppend({
          threadId,
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          sender: "agent",
          senderAgentId: agentId,
          targetAgentId,
          text: parsed.body,
          streaming: false,
          createdAt: bufferedCreatedAt,
          updatedAt: eventCreatedAt,
        });
      }
      if (!resolved.toOperator && resolved.agentIds.length > 0) {
        const targetAgents = runtime.config.agents.filter((entry) =>
          resolved.agentIds.includes(entry.id),
        );
        if (targetAgents.length > 0) {
          yield* Effect.forEach(
            targetAgents,
            (targetAgent) =>
              sendTurnToAgent({
                threadId,
                agent: targetAgent,
                text: parsed.body,
                createdAt: eventCreatedAt,
                includeTaskContext: false,
                replyTargetAgentId: agentId,
              }),
            { concurrency: 4 },
          );
        }
      }
      return true;
    });

  const broadcastStartPrompt = (threadId: ThreadId, createdAt: string) =>
    Effect.gen(function* () {
      const runtime = swarmByThreadId.get(String(threadId));
      if (!runtime) return;

      yield* Effect.forEach(
        runtime.config.agents,
        (agent) => {
          const promptText = buildMinimalStartPrompt();
          const messageId = MessageId.makeUnsafe(crypto.randomUUID());
          return dispatchMessageAppend({
            threadId,
            messageId,
            sender: "operator",
            senderAgentId: null,
            targetAgentId: agent.id,
            text: promptText,
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          }).pipe(
            Effect.flatMap(() =>
              sendTurnToAgent({
                threadId,
                agent,
                text: promptText,
                createdAt,
                includeTaskContext: true,
              }),
            ),
          );
        },
        { concurrency: 4 },
      );
    });

  const maybeBootstrapTasks = (
    threadId: ThreadId,
    runtime: SwarmRuntime,
    occurredAt: string,
  ) => {
    const taskModeEnabled = isTaskModeEnabled(runtime, serverSwarmTasksEnabled);
    if (!taskModeEnabled) {
      return Effect.void;
    }
    if (runtime.tasks.size > 0) {
      return Effect.void;
    }
    return Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((t) => t.id === threadId && t.swarm);
      if (thread?.swarm?.tasks && thread.swarm.tasks.length > 0) {
        return;
      }
      const scout = runtime.config.agents.find((agent) => agent.role === "scout");
      const builder = runtime.config.agents.find((agent) => agent.role === "builder");
      const reviewer = runtime.config.agents.find((agent) => agent.role === "reviewer");

      const tasks: SwarmTask[] = [];
      if (scout) {
        tasks.push({
          id: `swarm-scout`,
          goal: `Scout the codebase for mission: ${runtime.config.mission}`,
          status: "queued",
          ownerAgentId: scout.id,
          ownedFiles: [],
          dependsOnTaskIds: [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
      }
      if (builder) {
        tasks.push({
          id: `swarm-build-${builder.id}`,
          goal: `Implement mission: ${runtime.config.mission}`,
          status: "queued",
          ownerAgentId: builder.id,
          ownedFiles: runtime.config.targetPath ? [runtime.config.targetPath] : [],
          dependsOnTaskIds: [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
      }
      if (reviewer) {
        const builderTaskIds = tasks
          .filter((task) => task.id.startsWith("swarm-build"))
          .map((task) => task.id);
        tasks.push({
          id: `swarm-review`,
          goal: `Review and harden the mission output`,
          status: "queued",
          ownerAgentId: reviewer.id,
          ownedFiles: [],
          dependsOnTaskIds: builderTaskIds,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
      }

      yield* Effect.forEach(
        tasks,
        (task) =>
          dispatchTaskCreated({
            threadId,
            task,
          }),
        { concurrency: 1 },
      );
    });
  };

  const startSwarm = (threadId: ThreadId, createdAt: string) =>
    ensureSwarmRuntime(threadId).pipe(
      Effect.flatMap((option) =>
        Option.match(option, {
          onNone: () => Effect.logWarning("swarm start skipped: runtime not found", { threadId }),
          onSome: (runtime) =>
            Effect.gen(function* () {
              if (runtime.started) {
                yield* dispatchSystemNotice({
                  threadId,
                  createdAt,
                  text: "Swarm is already running. Ignoring duplicate start request.",
                });
                return;
              }
              runtime.started = true;
              runtime.stopping = false;
              if (isTaskModeEnabled(runtime, serverSwarmTasksEnabled)) {
                yield* maybeBootstrapTasks(threadId, runtime, createdAt);
              }
              yield* Effect.forEach(
                runtime.config.agents,
                (agent) => startAgentSession({ threadId, agent, createdAt }),
                { concurrency: 4 },
              );
              yield* broadcastStartPrompt(threadId, createdAt);
            }),
        }),
      ),
    );

  const stopSwarm = (threadId: ThreadId, createdAt: string) =>
    Effect.gen(function* () {
      const runtime = swarmByThreadId.get(String(threadId));
      if (!runtime) return;
      runtime.stopping = true;
      yield* Effect.forEach(runtime.agents.values(), (agent) =>
        providerService
          .stopSession({ threadId: agent.providerThreadId })
          .pipe(Effect.catchCause((cause) => Effect.logWarning("swarm stop failed", { cause: safeCauseMessage(cause) })), Effect.asVoid),
      );
      yield* Effect.forEach(runtime.config.agents, (agent) =>
        dispatchStatus(threadId, agent.id, "stopped", createdAt),
      );
      runtime.started = false;
    });

  const ensureRuntimeFromReadModel = Effect.gen(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    const activeSessions = yield* providerService.listSessions();
    const swarms = readModel.threads.filter((thread) => thread.swarm);
    const now = new Date().toISOString();

    for (const thread of swarms) {
      const runtimeConfig: SwarmRuntime = {
        config: thread.swarm!.config,
        agents: new Map<string, SwarmRuntimeAgent>(),
        tasks: new Map((thread.swarm?.tasks ?? []).map((task) => [task.id, task])),
        started: false,
        stopping: false,
      };

      // SET RUNTIME FIRST so startAgentSession can find it
      swarmByThreadId.set(String(thread.id), runtimeConfig);

      for (const agent of thread.swarm!.config.agents) {
        const providerThreadId = encodeSwarmSessionThreadId(thread.id, agent.id);
        const existingSession = activeSessions.find(
          (s) => s.threadId === providerThreadId,
        );
        if (existingSession) {
          runtimeConfig.agents.set(agent.id, {
            providerThreadId,
            status: mapRuntimeState(existingSession.status),
            lastError: null,
            statusUpdatedAt: now,
          });
          runtimeConfig.started = true;
          yield* dispatchStatus(thread.id, agent.id, mapRuntimeState(existingSession.status), now);
        } else {
          yield* dispatchStatus(thread.id, agent.id, "idle", now);
        }
      }
    }
  });

  const handleOperatorMessage = (event: Extract<OrchestrationEvent, { type: "swarm.agent.message" }>) =>
    Effect.gen(function* () {
      if (event.payload.sender !== "operator") return;
      const parentThreadId = event.payload.threadId;
      const runtimeOption = yield* ensureSwarmRuntime(parentThreadId);
      if (Option.isNone(runtimeOption)) return;
      const runtime = runtimeOption.value;
      const targets = runtime.config.agents.filter((agent) =>
        event.payload.targetAgentId ? agent.id === event.payload.targetAgentId : true,
      );
      yield* Effect.forEach(
        targets,
        (agent) =>
          sendTurnToAgent({
            threadId: parentThreadId,
            agent,
            text: event.payload.text,
            createdAt: event.occurredAt,
          }),
        { concurrency: 4 },
      );
    });

  const handleProviderEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const decoded = decodeSwarmSessionThreadId(event.threadId);
      if (!decoded) return;
      const { threadId, agentId } = decoded;
      const runtime = swarmByThreadId.get(String(threadId));
      if (!runtime) return;
      const agent = runtime.config.agents.find((entry) => entry.id === agentId);
      if (!agent) return;
      const agentState = runtime.agents.get(agentId) ?? {
        providerThreadId: event.threadId,
        status: DEFAULT_STATUS,
        lastError: null,
        statusUpdatedAt: "",
      };
      runtime.agents.set(agentId, agentState);
      const taskModeEnabled = isTaskModeEnabled(runtime, serverSwarmTasksEnabled);
      const isStaleStatusEvent =
        agentState.statusUpdatedAt.length > 0 && event.createdAt < agentState.statusUpdatedAt;

      const updateStatus = (status: SwarmAgentStatus, lastError: string | null = null) =>
        dispatchStatus(threadId, agentId, status, event.createdAt, lastError);
      const syncTasksForAgentStatus = (status: SwarmAgentStatus, reason?: string) =>
        taskModeEnabled
          ? Effect.forEach(
              tasksForAgent(runtime, agent),
              (task) => {
                if (agent.role === "builder") {
                  if (status === "running" && task.status === "queued") {
                    return setTaskStatus(threadId, task, "building", event.createdAt);
                  }
                  if (status === "ready" && task.status === "building") {
                    return setTaskStatus(threadId, task, "review", event.createdAt);
                  }
                  if (status === "error") {
                    return setTaskStatus(
                      threadId,
                      task,
                      "blocked",
                      event.createdAt,
                      reason ?? "builder runtime error",
                    );
                  }
                }
                if (agent.role === "reviewer") {
                  if (status === "running" && task.status === "queued") {
                    return setTaskStatus(threadId, task, "review", event.createdAt);
                  }
                  if (status === "ready" && task.status === "review") {
                    return setTaskStatus(threadId, task, "done", event.createdAt);
                  }
                }
                if (agent.role === "scout") {
                  if (status === "running" && task.status === "queued") {
                    return setTaskStatus(threadId, task, "building", event.createdAt);
                  }
                  if (status === "ready" && ACTIVE_TASK_STATUSES.has(task.status)) {
                    return setTaskStatus(threadId, task, "done", event.createdAt);
                  }
                }
                return Effect.void;
              },
              { concurrency: 1 },
            )
          : Effect.void;

      switch (event.type) {
        case "session.started":
        case "session.state.changed": {
          if (isStaleStatusEvent) {
            break;
          }
          const status = mapRuntimeState(
            event.type === "session.started" ? "ready" : event.payload.state,
          );
          const reason =
            event.type === "session.state.changed" && "reason" in event.payload
              ? (event.payload as { reason?: string }).reason
              : undefined;
          agentState.status = status;
          agentState.lastError =
            status === "error" ? reason ?? agentState.lastError ?? null : null;
          agentState.statusUpdatedAt = event.createdAt;
          yield* updateStatus(status, agentState.lastError);
          yield* syncTasksForAgentStatus(status, reason);
          break;
        }
        case "session.exited": {
          if (isStaleStatusEvent) {
            break;
          }
          if (runtime.stopping) {
            agentState.status = "stopped";
            agentState.statusUpdatedAt = event.createdAt;
            yield* updateStatus("stopped");
            break;
          }
          const hasPendingTasks = Array.from(runtime.tasks.values()).some(
            (t) => t.status === "queued" || t.status === "building" || t.status === "review",
          );
          if (hasPendingTasks || agent.role === "coordinator") {
            yield* Effect.logDebug("swarm agent session exited with pending tasks or is coordinator, restarting", {
              threadId,
              agentId,
              role: agent.role,
            });
            const prompt =
              agent.role === "coordinator"
                ? "Coordinate the swarm. Ensure all tasks are progressing and assign work to agents."
                : "Tasks remain. Continue working on your assigned tasks.";
            yield* startAgentSession({ threadId, agent, createdAt: event.createdAt });
            yield* sendTurnToAgent({
              threadId,
              agent,
              text: prompt,
              createdAt: event.createdAt,
              includeTaskContext: true,
            });
          } else {
            agentState.status = "stopped";
            agentState.statusUpdatedAt = event.createdAt;
            yield* updateStatus("stopped");
          }
          break;
        }
        case "turn.started": {
          if (isStaleStatusEvent) {
            break;
          }
          agentState.status = "running";
          agentState.statusUpdatedAt = event.createdAt;
          yield* updateStatus("running");
          break;
        }
        case "content.delta": {
          const nonAssistantStreams = new Set<RuntimeContentStreamKind>([
            "command_output",
            "file_change_output",
          ]);
          if (nonAssistantStreams.has(event.payload.streamKind)) {
            break;
          }
          const isReasoning =
            event.payload.streamKind === "reasoning_text" ||
            event.payload.streamKind === "reasoning_summary_text";
          const isAssistant =
            event.payload.streamKind === "assistant_text" ||
            event.payload.streamKind === "unknown";
          if (!isReasoning && !isAssistant) break;

          if (agentState.status !== "running") {
            agentState.status = "running";
            agentState.statusUpdatedAt = event.createdAt;
            yield* updateStatus("running");
            yield* syncTasksForAgentStatus("running");
          }
          const turnKey = toTurnKey(threadId, agentId, event.turnId);
          const existingBuffer = isReasoning ? agentState.reasoningBuffered : agentState.buffered;
          const messageId = existingBuffer?.messageId ?? MessageId.makeUnsafe(crypto.randomUUID());
          const createdAt = existingBuffer?.createdAt ?? event.createdAt;
          const prefix = isReasoning && !existingBuffer ? "[thinking] " : "";
          const deltaText = `${prefix}${event.payload.delta ?? ""}`;
          const text = existingBuffer ? `${existingBuffer.text}${deltaText}` : deltaText;
          const nextBuffer = {
            messageId,
            turnKey,
            createdAt,
            text,
          };
          if (isReasoning) {
            agentState.reasoningBuffered = nextBuffer;
          } else {
            agentState.buffered = nextBuffer;
          }
          if (deltaText.length > 0) {
            yield* dispatchMessageAppend({
              threadId,
              messageId,
              sender: "agent",
              senderAgentId: agentId,
              targetAgentId: null,
              text: deltaText,
              streaming: true,
              createdAt,
              updatedAt: event.createdAt,
            });
          }
          break;
        }
        case "turn.completed": {
          if (isStaleStatusEvent) {
            break;
          }
          const turnKey = toTurnKey(threadId, agentId, event.turnId);
          const buffered = agentState.buffered;
          if (buffered && buffered.turnKey === turnKey) {
            const handledByTool = yield* tryHandleAgentDirectedMessage(
              runtime,
              threadId,
              agentId,
              buffered.messageId,
              buffered.createdAt,
              event.createdAt,
              buffered.text,
            );
            if (!handledByTool) {
              const stripped = stripSwarmCloseTokens(buffered.text);
              const replyTargetAgentId = agentState.replyTargetAgentId ?? null;
              if (stripped.hasClose && stripped.body.length > 0 && replyTargetAgentId) {
                yield* dispatchMessageAppend({
                  threadId,
                  messageId: MessageId.makeUnsafe(crypto.randomUUID()),
                  sender: "agent",
                  senderAgentId: agentId,
                  targetAgentId: replyTargetAgentId,
                  text: stripped.body,
                  streaming: false,
                  createdAt: buffered.createdAt,
                  updatedAt: event.createdAt,
                });
                const targetAgent = runtime.config.agents.find((entry) => entry.id === replyTargetAgentId);
                if (targetAgent) {
                  yield* sendTurnToAgent({
                    threadId,
                    agent: targetAgent,
                    text: stripped.body,
                    createdAt: event.createdAt,
                    includeTaskContext: false,
                    replyTargetAgentId: agentId,
                  });
                }
              } else if (stripped.body.length > 0 || !stripped.hasClose) {
                yield* dispatchMessageAppend({
                  threadId,
                  messageId: buffered.messageId,
                  sender: "agent",
                  senderAgentId: agentId,
                  targetAgentId: null,
                  text: stripped.hasClose ? stripped.body : buffered.text,
                  streaming: false,
                  createdAt: buffered.createdAt,
                  updatedAt: event.createdAt,
                });
              }
            }
            delete agentState.buffered;
          }
          const reasoningBuffered = agentState.reasoningBuffered;
          if (reasoningBuffered && reasoningBuffered.turnKey === turnKey) {
            yield* dispatchMessageAppend({
              threadId,
              messageId: reasoningBuffered.messageId,
              sender: "agent",
              senderAgentId: agentId,
              targetAgentId: null,
              text: reasoningBuffered.text,
              streaming: false,
              createdAt: reasoningBuffered.createdAt,
              updatedAt: event.createdAt,
            });
            delete agentState.reasoningBuffered;
          }
          const status = event.payload.state === "failed" ? "error" : "ready";
          agentState.status = status;
          const lastError = event.payload.state === "failed" ? event.payload.errorMessage ?? null : null;
          agentState.lastError = lastError;
          agentState.statusUpdatedAt = event.createdAt;
          yield* updateStatus(status, lastError);
          yield* syncTasksForAgentStatus(status, lastError ?? undefined);
          if (agent.role === "coordinator" && status === "ready") {
            const builders = runtime.config.agents.filter((a) => a.role === "builder");
            for (const builder of builders) {
              const builderState = runtime.agents.get(builder.id);
              const builderTasks = Array.from(runtime.tasks.values()).filter(
                (t) => t.ownerAgentId === builder.id && (t.status === "queued" || t.status === "building"),
              );
              if (builderTasks.length > 0 && (!builderState || builderState.status === "idle" || builderState.status === "ready")) {
                const task = builderTasks[0]!;
                yield* Effect.logDebug("auto-starting builder task", { threadId, builderId: builder.id, taskId: task.id });
                yield* startAgentSession({ threadId, agent: builder, createdAt: event.createdAt });
                yield* sendTurnToAgent({
                  threadId,
                  agent: builder,
                  text: `Your task: ${task.goal}\n\nWork on this task now.`,
                  createdAt: event.createdAt,
                  includeTaskContext: true,
                });
              }
            }
          }
          if (agent.role !== "coordinator" && status === "ready") {
            const pendingTasks = Array.from(runtime.tasks.values()).filter(
              (t) => t.status === "queued" || t.status === "building" || t.status === "review",
            );
            if (pendingTasks.length > 0) {
              const coordinatorAgent = runtime.config.agents.find((a) => a.role === "coordinator");
              if (coordinatorAgent) {
                const coordinatorState = runtime.agents.get(coordinatorAgent.id);
                if (!coordinatorState || coordinatorState.status === "ready" || coordinatorState.status === "idle") {
                  const taskSummary = pendingTasks
                    .map((t) => `[${t.status}] ${t.id}: ${t.goal}`)
                    .join("\n");
                  const prompt = `Agent ${agentId} completed their turn. Pending tasks remain:\n${taskSummary}\n\nCoordinate the next steps.`;
                  yield* sendTurnToAgent({
                    threadId,
                    agent: coordinatorAgent,
                    text: prompt,
                    createdAt: event.createdAt,
                    includeTaskContext: true,
                  });
                }
              }
            }
          }
          break;
        }
        case "runtime.error": {
          if (isStaleStatusEvent) {
            break;
          }
          const message = typeof event.payload.message === "string" ? event.payload.message : "Provider runtime error";
          agentState.status = "error";
          agentState.lastError = message;
          agentState.statusUpdatedAt = event.createdAt;
          yield* updateStatus("error", message);
          yield* syncTasksForAgentStatus("error", message);
          break;
        }
        default:
          break;
      }
    });

   const handleDomainEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
      switch (event.type) {
        case "swarm.started":
          return startSwarm(event.payload.threadId, event.occurredAt);
        case "swarm.created":
          return Effect.void;
       case "thread.session-stop-requested":
         return stopSwarm(event.payload.threadId, event.occurredAt);
       case "swarm.agent.message":
         return handleOperatorMessage(event);
       case "swarm.task.created":
         return Effect.sync(() => {
           const runtime = swarmByThreadId.get(String(event.payload.threadId));
           if (!runtime) return;
           runtime.tasks.set(event.payload.task.id, event.payload.task);
         });
       case "swarm.task.updated":
         return Effect.sync(() => {
           const runtime = swarmByThreadId.get(String(event.payload.threadId));
           if (!runtime) return;
           runtime.tasks.set(event.payload.task.id, event.payload.task);
         });
       case "swarm.task.blocked":
         return Effect.sync(() => {
           const runtime = swarmByThreadId.get(String(event.payload.threadId));
           const existing = runtime?.tasks.get(event.payload.taskId);
           if (!runtime || !existing) return;
           runtime.tasks.set(event.payload.taskId, {
             ...existing,
             status: "blocked",
             updatedAt: event.payload.updatedAt,
           });
         });
       case "swarm.task.completed":
         return Effect.sync(() => {
           const runtime = swarmByThreadId.get(String(event.payload.threadId));
           const existing = runtime?.tasks.get(event.payload.taskId);
           if (!runtime || !existing) return;
           runtime.tasks.set(event.payload.taskId, {
             ...existing,
             status: "done",
             updatedAt: event.payload.updatedAt,
           });
         });
       default:
         return Effect.void;
     }
   };

  const processInput = (input: RuntimeInput): Effect.Effect<void> =>
    input.source === "domain" ? handleDomainEvent(input.event) : handleProviderEvent(input.event);

  const processSafely = (input: RuntimeInput): Effect.Effect<void> =>
    processInput(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("swarm coordinator failed", {
          source: input.source,
          cause: safeCauseMessage(cause),
        }),
      ),
      Effect.asVoid,
    );

  const start: SwarmCoordinatorShape["start"] = Effect.gen(function* () {
    yield* ensureRuntimeFromReadModel;
    const queue = yield* Queue.unbounded<RuntimeInput>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(queue).pipe(Effect.flatMap(processSafely)),
      ),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        Queue.offer(queue, { source: "domain", event }).pipe(Effect.asVoid),
      ),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        isSwarmSessionThreadId(event.threadId)
          ? Queue.offer(queue, { source: "provider", event }).pipe(Effect.asVoid)
          : Effect.void,
      ),
    );
  });

  return {
    start,
  } satisfies SwarmCoordinatorShape;
});

export const SwarmCoordinatorLive = Layer.effect(SwarmCoordinator, makeSwarmCoordinator);
