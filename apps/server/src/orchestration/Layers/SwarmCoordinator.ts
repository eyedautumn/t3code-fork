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
  type RuntimeErrorClass,
} from "@t3tools/contracts";
import { getDefaultModel } from "@t3tools/shared/model";
import { Effect, Layer, Option, Queue, Stream, Scope } from "effect";
import { safeCauseMessage } from "@t3tools/shared/cause";
import { normalizeSwarmTargetToken, parseSwarmMessage } from "@t3tools/shared/swarmMessaging";
import fs from "node:fs/promises";
import path from "node:path";

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

console.log("[SWARM] SwarmCoordinator module loaded - TEST BUILD");

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
  pendingTurns?: Array<{
    text: string;
    createdAt: string;
    includeTaskContext?: boolean;
    replyTargetAgentId?: string | null;
  }>;
  buffered?: {
    messageId: MessageId;
    turnKey: string;
    createdAt: string;
    text: string;
    processedDirectiveSignatures?: Set<string>;
    finalRenderedText?: string | undefined;
    forceHandleDirectives?: boolean;
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
  boardPath?: string;
};

const SWARM_MESSAGE_CLOSE_REGEX = /\[swarm\.message_close\]\s*/i;
const MESSAGE_SWARM_CLOSE_REGEX = /\[message_swarm_close\]\s*/i;
const SWARM_BOARD_FILENAME = "SWARM_BOARD.md";
const SWARM_BOARD_SECTION_PREFIX = "SWARM_BOARD:BEGIN";
const SWARM_BOARD_SECTION_SUFFIX = "SWARM_BOARD:END";

type ResolvedSwarmTargets = {
  agentIds: string[];
  toOperator: boolean;
};

function formatDirectMessageBody(senderLabel: string, body: string): string {
  const trimmed = body.trim();
  if (/^MESSAGE FROM\s+/i.test(trimmed)) {
    return trimmed;
  }
  return `MESSAGE FROM ${senderLabel}: ${trimmed}`;
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
    candidate.aliases.some(
      (alias) => alias.startsWith(aliasTarget) || aliasTarget.startsWith(alias),
    ),
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
            aliasTokens.some(
              (aliasToken) => aliasToken.includes(token) || token.includes(aliasToken),
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

function stripSwarmCloseTokens(text: string): { hasClose: boolean; body: string } {
  const hasClose = SWARM_MESSAGE_CLOSE_REGEX.test(text) || MESSAGE_SWARM_CLOSE_REGEX.test(text);
  const body = text
    .replace(SWARM_MESSAGE_CLOSE_REGEX, "")
    .replace(MESSAGE_SWARM_CLOSE_REGEX, "")
    .trim();
  return { hasClose, body };
}

function resolveSwarmMessageTargets(
  runtime: SwarmRuntime,
  targetRaw: string | null,
): ResolvedSwarmTargets {
  if (!targetRaw) {
    return { agentIds: [], toOperator: false };
  }
  const normalized = normalizeSwarmTargetToken(targetRaw).toLowerCase();
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
  boardPath: string | null,
): string {
  const roleInstructions = getSwarmRoleInstructions(agent.role);
  const isCodexAgent = agent.provider === "codex";

  const missionContext = [
    `## Mission`,
    config.mission,
    config.targetPath ? `Target path: ${config.targetPath}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const taskSection = taskContext ? ["## Your Tasks", taskContext].join("\n") : null;

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
    "## Shared Board",
    `- Use \`${SWARM_BOARD_FILENAME}\` as the shared project board for this swarm.`,
    boardPath ? `- Board path: \`${boardPath}\`` : "- Board path: project workspace root.",
    "- The board may contain multiple swarms; only edit your swarm section (match by Swarm ID).",
    "- Keep assignment status, findings, implementation notes, and review outcomes in the board.",
    "- Coordinator rule: every new assignment must update task ownership/status in the board in the same turn.",
    "- Scout/Builder/Reviewer rule: post your findings or completion report in your section before handoff.",
    "- Agent messaging still works: use literal `[swarm.message <TARGET>] <message>` for direct handoffs.",
    "## Thread & Literal Messaging Markers",
    `Thread ID: ${threadId}`,
    "- To message another swarm member, write a literal inline text marker in your assistant response. It is not a tool call:",
    "  * Use exactly: `[swarm.message <TARGET>] <message>`",
    "  * Close a thread with exactly: `[swarm.message_close]`",
    "- Do NOT call a tool, function, XML tag, or API named `swarm.message`.",
    "- Do NOT use the `task` tool, sub-agent tools, or any other tool as a replacement for swarm messaging.",
    "- TARGET may be agent id, agent name, role name (`builder`, `reviewer`, `scout`, `coordinator`), or `operator`.",
    "- The operator is the human. Use `[swarm.message operator]` for final reports or critical updates.",
    "- Prefix direct messages with `MESSAGE FROM <your-id-or-role>: <message>`.",
    "- Example: `[swarm.message squad-scout-5] MESSAGE FROM coordinator: Scout apps/server and summarize the routing flow.`",
    "- Use these literal markers to assign tasks, request help, hand off for review, or report completion with verification steps.",
    isCodexAgent
      ? [
          "## Codex Swarm Guidance",
          "- Keep `SWARM_BOARD.md` current, but do not let it block communication.",
          "- Coordinator: whenever you assign or change ownership, update the board in the same turn.",
          "- Reviewer/Builder/Scout: add findings or completion notes to the board before handoff when possible.",
          "- You MAY include a brief summary in chat (1-3 lines) plus `[swarm.message <TARGET>] <message>` handoffs.",
          "- If you cannot edit files, message the Coordinator with the exact text to insert into `SWARM_BOARD.md`.",
        ].join("\n")
      : null,
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

function reconcileStreamText(existing: string, incoming: string): { text: string; delta: string } {
  if (incoming.length === 0) return { text: existing, delta: "" };
  if (existing.length === 0) return { text: incoming, delta: incoming };

  // Some providers emit cumulative snapshots instead of strict deltas.
  if (incoming.startsWith(existing)) {
    return { text: incoming, delta: incoming.slice(existing.length) };
  }
  if (existing.startsWith(incoming)) {
    return { text: existing, delta: "" };
  }

  // Merge on suffix/prefix overlap when possible.
  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      const delta = incoming.slice(overlap);
      return { text: existing + delta, delta };
    }
  }

  // Handle reordered/rewritten snapshots where the new text still contains the old.
  if (incoming.length >= existing.length && incoming.includes(existing)) {
    return { text: incoming, delta: "" };
  }

  // Fallback: treat as append-only delta.
  return { text: existing + incoming, delta: incoming };
}

function toMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function boardSectionMarkers(threadId: ThreadId): { begin: string; end: string } {
  const id = String(threadId);
  return {
    begin: `<!-- ${SWARM_BOARD_SECTION_PREFIX} ${id} -->`,
    end: `<!-- ${SWARM_BOARD_SECTION_SUFFIX} ${id} -->`,
  };
}

function renderSwarmBoardHeader(): string {
  return [
    "# SWARM_BOARD",
    "",
    "- Shared board for all swarms in this workspace.",
    "- Each swarm writes to its own section below.",
    "",
  ].join("\n");
}

function upsertSwarmBoardSection(
  existing: string,
  section: string,
  markers: { begin: string; end: string },
): string {
  const normalized = existing.trim().length === 0 ? "" : existing;
  const header = normalized.includes("# SWARM_BOARD")
    ? normalized
    : `${renderSwarmBoardHeader()}${normalized ? `\n\n${normalized}` : ""}`;
  const beginIndex = header.indexOf(markers.begin);
  const endIndex = header.indexOf(markers.end);

  if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
    const before = header.slice(0, beginIndex);
    const after = header.slice(endIndex + markers.end.length);
    return `${before}${section}${after}`.trimEnd() + "\n";
  }

  const separator = header.trim().length > 0 ? "\n\n" : "";
  return `${header}${separator}${section}`.trimEnd() + "\n";
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
      return tasks
        .filter((task) => task.status === "review" && task.ownerAgentId !== agent.id)
        .slice(0, 1);
    case "scout":
      return tasks
        .filter((task) => task.ownerAgentId === agent.id || task.status === "queued")
        .slice(0, 1);
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

  const ensureRuntimeBoardPath = (threadId: ThreadId, runtime: SwarmRuntime) =>
    Effect.gen(function* () {
      if (typeof runtime.boardPath === "string" && runtime.boardPath.trim().length > 0) {
        return runtime.boardPath;
      }
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      const workspaceCwd = thread
        ? resolveThreadWorkspaceCwd({ thread, projects: readModel.projects })
        : undefined;
      const baseDir = workspaceCwd ?? serverConfig.cwd;
      const boardPath = path.join(baseDir, SWARM_BOARD_FILENAME);
      runtime.boardPath = boardPath;
      return boardPath;
    });

  const renderSwarmBoardSection = (
    threadId: ThreadId,
    runtime: SwarmRuntime,
    boardPath: string,
    updatedAt: string,
  ): string => {
    const tasks = sortTasks(runtime.tasks.values());
    const mission = toMarkdownTableCell(runtime.config.mission);
    const targetPath = runtime.config.targetPath
      ? toMarkdownTableCell(runtime.config.targetPath)
      : "(not set)";

    const agentRows = runtime.config.agents
      .map((agent) => {
        const runtimeAgent = runtime.agents.get(agent.id);
        const status = runtimeAgent?.status ?? "idle";
        const updated = runtimeAgent?.statusUpdatedAt ?? "-";
        return `| ${toMarkdownTableCell(agent.id)} | ${toMarkdownTableCell(agent.name)} | ${toMarkdownTableCell(agent.role)} | ${toMarkdownTableCell(status)} | ${toMarkdownTableCell(updated)} |`;
      })
      .join("\n");

    const taskRows =
      tasks.length === 0
        ? "| - | - | - | - | - | - | - |\n"
        : tasks
            .map(
              (task) =>
                `| ${toMarkdownTableCell(task.id)} | ${toMarkdownTableCell(task.status)} | ${toMarkdownTableCell(task.ownerAgentId ?? "unassigned")} | ${toMarkdownTableCell(task.goal)} | ${toMarkdownTableCell(task.ownedFiles.join(", ") || "-")} | ${toMarkdownTableCell(task.dependsOnTaskIds.join(", ") || "-")} | ${toMarkdownTableCell(task.updatedAt)} |`,
            )
            .join("\n");

    const markers = boardSectionMarkers(threadId);
    return [
      markers.begin,
      `## Swarm: ${runtime.config.name}`,
      "",
      `- Swarm ID: \`swarm:${threadId}\``,
      `- Thread ID: \`${threadId}\``,
      `- Name: ${runtime.config.name}`,
      `- Mission: ${mission}`,
      `- Target Path: ${targetPath}`,
      `- Board Updated At: ${updatedAt}`,
      `- Board File: \`${boardPath}\``,
      "",
      "### Agents",
      "| Agent ID | Name | Role | Status | Status Updated |",
      "| --- | --- | --- | --- | --- |",
      agentRows,
      "",
      "### Tasks",
      "| Task ID | Status | Owner | Goal | Owned Files | Depends On | Updated At |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      taskRows,
      "",
      "### Coordinator Log",
      "- Add assignment decisions and ownership changes here.",
      "- REQUIRED: whenever assigning a new task, update this board in the same turn.",
      "",
      "### Scout Reports",
      "- Add scouting notes and risk findings here.",
      "",
      "### Builder Reports",
      "- Add implementation updates, changed files, and verification notes here.",
      "",
      "### Reviewer Reports",
      "- Add approval/rejection decisions and follow-up actions here.",
      "",
      "### Messaging",
      "- Agents can still directly message each other with literal inline markers:",
      "  `[swarm.message <TARGET>] <message>`",
      "- Close a messaging thread with `[swarm.message_close]`.",
      markers.end,
    ].join("\n");
  };

  const syncSwarmBoard = (threadId: ThreadId, updatedAt: string) =>
    Effect.gen(function* () {
      const runtime = swarmByThreadId.get(String(threadId));
      if (!runtime) return;
      const boardPath = yield* ensureRuntimeBoardPath(threadId, runtime);
      const section = renderSwarmBoardSection(threadId, runtime, boardPath, updatedAt);
      yield* Effect.tryPromise(async () => {
        await fs.mkdir(path.dirname(boardPath), { recursive: true });
        let existing = "";
        try {
          existing = await fs.readFile(boardPath, "utf8");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code !== "ENOENT") {
            throw error;
          }
        }
        const next = upsertSwarmBoardSection(existing, section, boardSectionMarkers(threadId));
        await fs.writeFile(boardPath, next, "utf8");
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("swarm board write failed", {
          cause: safeCauseMessage(cause),
          threadId,
        }),
      ),
      Effect.asVoid,
    );

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
        Effect.tap(() => syncSwarmBoard(threadId, updatedAt)),
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
        Effect.tap(() => syncSwarmBoard(input.threadId, input.task.updatedAt)),
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
        Effect.tap(() => syncSwarmBoard(input.threadId, input.task.updatedAt)),
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
        Effect.tap(() => syncSwarmBoard(input.threadId, input.updatedAt)),
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
        Effect.tap(() => syncSwarmBoard(input.threadId, input.updatedAt)),
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

  const startAgentSession = (input: { threadId: ThreadId; agent: SwarmAgent; createdAt: string }) =>
    Effect.gen(function* () {
      const runtime = swarmByThreadId.get(String(input.threadId));
      if (!runtime) {
        yield* Effect.logWarning("startAgentSession skipped: no runtime", {
          threadId: input.threadId,
          agentId: input.agent.id,
        });
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
      const provider: ProviderKind =
        input.agent.provider ?? providerFromModel ?? DEFAULT_PROVIDER_KIND;
      const model =
        typeof explicitModel === "string" && explicitModel.trim().length > 0
          ? explicitModel
          : getDefaultModel(provider);
      yield* Effect.logDebug("starting agent session", {
        threadId: input.threadId,
        agentId: input.agent.id,
        provider,
        model,
      });

      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === input.threadId);
      const cwd = thread
        ? resolveThreadWorkspaceCwd({ thread, projects: readModel.projects })
        : null;

      const session = yield* providerService.startSession(providerThreadId, {
        threadId: providerThreadId,
        provider,
        model,
        modelOptions: input.agent.modelOptions,
        serviceTier: input.agent.serviceTier === "flex" ? null : (input.agent.serviceTier ?? null),
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
          yield* dispatchStatus(input.threadId, input.agent.id, "error", failedAt, detail);
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
        yield* Effect.logWarning("swarm sendTurn skipped: no runtime", {
          threadId: input.threadId,
          agentId: input.agent.id,
        });
        return;
      }
      const agentState = runtime.agents.get(input.agent.id);
      if (!agentState) {
        yield* Effect.logDebug("swarm sendTurn: starting agent session", {
          threadId: input.threadId,
          agentId: input.agent.id,
        });
        yield* startAgentSession({
          threadId: input.threadId,
          agent: input.agent,
          createdAt: input.createdAt,
        });
      }
      const activeAgentState = runtime.agents.get(input.agent.id);
      if (
        activeAgentState &&
        (activeAgentState.status === "running" || activeAgentState.status === "starting")
      ) {
        activeAgentState.pendingTurns = activeAgentState.pendingTurns ?? [];
        activeAgentState.pendingTurns.push({
          text: input.text,
          createdAt: input.createdAt,
          replyTargetAgentId: input.replyTargetAgentId ?? null,
          ...(input.includeTaskContext !== undefined
            ? { includeTaskContext: input.includeTaskContext }
            : {}),
        });
        yield* Effect.logDebug("swarm sendTurn queued while agent busy", {
          threadId: input.threadId,
          agentId: input.agent.id,
          pendingTurns: activeAgentState.pendingTurns.length,
        });
        return;
      }

      const providerThreadId = activeAgentState?.providerThreadId;
      if (!providerThreadId) {
        yield* Effect.logWarning("swarm sendTurn skipped: no provider thread id", {
          threadId: input.threadId,
          agentId: input.agent.id,
        });
        return;
      }
      if (activeAgentState) {
        activeAgentState.replyTargetAgentId = input.replyTargetAgentId ?? null;
      }
      const taskModeEnabled = isTaskModeEnabled(runtime, serverSwarmTasksEnabled);
      const taskContext =
        taskModeEnabled && input.includeTaskContext !== false
          ? renderTaskContext(runtime, input.agent)
          : null;
      const boardPath = yield* ensureRuntimeBoardPath(input.threadId, runtime).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      const developerInstructions = buildDeveloperInstructions(
        runtime.config,
        input.agent,
        taskContext,
        taskModeEnabled,
        input.threadId,
        boardPath,
      );
      const textWithContext = taskContext ? `${taskContext}\n\n${input.text}` : input.text;
      const sendWithRetry = (allowRetry: boolean): Effect.Effect<void, never, Scope.Scope> =>
        providerService
          .sendTurn({
            threadId: providerThreadId,
            input: textWithContext,
            model: input.agent.model,
            serviceTier:
              input.agent.serviceTier === "flex" ? null : (input.agent.serviceTier ?? null),
            modelOptions: input.agent.modelOptions,
            interactionMode: input.agent.interactionMode,
            developerInstructions,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const detail = safeCauseMessage(cause);
                const failedAt = new Date().toISOString();
                const missingBinding =
                  detail.includes("no persisted provider binding exists") && allowRetry;
                if (missingBinding) {
                  yield* Effect.logWarning("swarm sendTurn missing binding, restarting session", {
                    threadId: input.threadId,
                    agentId: input.agent.id,
                  });
                  yield* startAgentSession({
                    threadId: input.threadId,
                    agent: input.agent,
                    createdAt: failedAt,
                  });
                  return yield* sendWithRetry(false);
                }
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
      yield* Effect.forkScoped(sendWithRetry(true));
    });

  const flushQueuedTurnForAgent = (input: {
    threadId: ThreadId;
    runtime: SwarmRuntime;
    agent: SwarmAgent;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const agentState = input.runtime.agents.get(input.agent.id);
      if (!agentState) return;
      if (agentState.status === "running" || agentState.status === "starting") {
        return;
      }
      const nextTurn = agentState.pendingTurns?.shift();
      if (!nextTurn) {
        return;
      }
      yield* sendTurnToAgent({
        threadId: input.threadId,
        agent: input.agent,
        text: nextTurn.text,
        createdAt: nextTurn.createdAt,
        replyTargetAgentId: nextTurn.replyTargetAgentId ?? null,
        ...(nextTurn.includeTaskContext !== undefined
          ? { includeTaskContext: nextTurn.includeTaskContext }
          : {}),
      });
    });

  const tryHandleAgentDirectedMessage = (
    runtime: SwarmRuntime,
    threadId: ThreadId,
    agentId: string,
    bufferedCreatedAt: string,
    eventCreatedAt: string,
    bufferedText: string,
    processedDirectiveSignatures?: Set<string>,
  ) =>
    Effect.gen(function* () {
      console.log(
        `[SWARM DEBUG] tryHandleAgentDirectedMessage called for agent ${agentId} thread ${threadId}`,
      );
      console.log(`[SWARM DEBUG] bufferedText: ${bufferedText.slice(0, 200)}`);
      const parsed = parseSwarmMessage(bufferedText);
      console.log(`[SWARM DEBUG] parsed directives count: ${parsed.directives.length}`);
      console.log(
        `[SWARM DEBUG] parsed directives: ${JSON.stringify(parsed.directives.map((d) => ({ targetRaw: d.targetRaw, body: d.body.slice(0, 50) })))}`,
      );
      console.log(
        `[SWARM DEBUG] known agents in runtime: ${runtime.config.agents.map((a) => a.id).join(", ")}`,
      );
      yield* Effect.logDebug("swarm: parseSwarmMessage result", {
        threadId,
        agentId,
        directivesCount: parsed.directives.length,
        publicText: parsed.publicText.slice(0, 100),
        hasCloseToken: parsed.hasCloseToken,
        directives: parsed.directives.map((d) => ({
          targetRaw: d.targetRaw,
          body: d.body.slice(0, 50),
        })),
      });
      if (parsed.directives.length === 0) {
        console.log(`[SWARM DEBUG] NO DIRECTIVES FOUND - returning handled=false`);
        return { handled: false as const, publicText: "", deliverySummary: "" };
      }
      const compactedDirectives = parsed.directives.reduce<typeof parsed.directives>(
        (acc, current) => {
          const previous = acc[acc.length - 1];
          if (!previous) {
            acc.push(current);
            return acc;
          }
          const sameTarget =
            normalizeSwarmTargetToken(previous.targetRaw).toLowerCase() ===
            normalizeSwarmTargetToken(current.targetRaw).toLowerCase();
          if (!sameTarget) {
            acc.push(current);
            return acc;
          }

          const previousBody = previous.body.trim();
          const currentBody = current.body.trim();
          const isPrefixVariant =
            currentBody.startsWith(previousBody) || previousBody.startsWith(currentBody);
          if (!isPrefixVariant) {
            acc.push(current);
            return acc;
          }

          // Keep the newer/longer prefix variant so partial streaming slices
          // collapse into the final directive body.
          if (currentBody.length >= previousBody.length) {
            acc[acc.length - 1] = current;
          }
          return acc;
        },
        [],
      );
      const deliveredTargets = new Set<string>();
      let deliveredDirectiveCount = 0;
      const processed = processedDirectiveSignatures ?? new Set<string>();

      for (const directive of compactedDirectives) {
        const signature = `${directive.targetRaw}::${directive.body}`;
        if (processed.has(signature)) {
          continue;
        }
        console.log(
          `[SWARM DEBUG] processing directive: targetRaw=${directive.targetRaw}, body=${directive.body.slice(0, 50)}`,
        );
        const resolved = resolveSwarmMessageTargets(runtime, directive.targetRaw);
        console.log(
          `[SWARM DEBUG] resolved: agentIds=${resolved.agentIds.join(",")}, toOperator=${resolved.toOperator}`,
        );
        yield* Effect.logDebug("swarm: resolveSwarmMessageTargets result", {
          threadId,
          agentId,
          targetRaw: directive.targetRaw,
          resolvedAgentIds: resolved.agentIds,
          toOperator: resolved.toOperator,
          knownAgents: runtime.config.agents.map((a) => a.id),
        });
        if (!resolved.toOperator && resolved.agentIds.length === 0) {
          console.log(`[SWARM DEBUG] UNRESOLVED TARGET: ${directive.targetRaw}`);
          yield* dispatchSystemNotice({
            threadId,
            createdAt: eventCreatedAt,
            targetAgentId: SWARM_OPERATOR_TARGET_ID,
            text: `Unresolved swarm target '${directive.targetRaw}' from ${agentId}. Known agents: ${runtime.config.agents.map((entry) => entry.id).join(", ")}`,
          });
          continue;
        }

        const logTargets = resolved.toOperator
          ? [SWARM_OPERATOR_TARGET_ID]
          : resolved.agentIds.length > 0
            ? resolved.agentIds
            : [directive.targetRaw];
        console.log(`[SWARM DEBUG] DISPATCHING to targets: ${logTargets.join(",")}`);
        const deliveredBody = directive.body;
        for (const targetAgentId of logTargets) {
          deliveredDirectiveCount += 1;
          deliveredTargets.add(targetAgentId);
          processed.add(signature);
          console.log(
            `[SWARM DEBUG] dispatchMessageAppend: senderAgentId=${agentId}, targetAgentId=${targetAgentId}, text=${directive.body.slice(0, 50)}`,
          );
          yield* dispatchMessageAppend({
            threadId,
            messageId: MessageId.makeUnsafe(crypto.randomUUID()),
            sender: "agent",
            senderAgentId: agentId,
            targetAgentId,
            text: deliveredBody,
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
                  text: deliveredBody,
                  createdAt: eventCreatedAt,
                  includeTaskContext: false,
                  replyTargetAgentId: agentId,
                }),
              { concurrency: 4 },
            );
          }
        }
      }

      const deliverySummary =
        deliveredTargets.size > 0
          ? `Sent swarm message to ${Array.from(deliveredTargets)
              .map((targetAgentId) =>
                targetAgentId === SWARM_OPERATOR_TARGET_ID ? "operator" : targetAgentId,
              )
              .join(", ")}.`
          : "";

      return {
        handled: deliveredDirectiveCount > 0,
        publicText: parsed.publicText,
        deliverySummary,
      };
    });

  const broadcastStartPrompt = (
    threadId: ThreadId,
    createdAt: string,
    targetAgents?: ReadonlyArray<SwarmAgent>,
  ) =>
    Effect.gen(function* () {
      const runtime = swarmByThreadId.get(String(threadId));
      if (!runtime) return;
      const agents = targetAgents ?? runtime.config.agents;

      yield* Effect.forEach(
        agents,
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

  const maybeBootstrapTasks = (threadId: ThreadId, runtime: SwarmRuntime, occurredAt: string) => {
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
              const missingAgents = runtime.config.agents.filter(
                (agent) => !runtime.agents.has(agent.id),
              );
              if (runtime.started) {
                if (missingAgents.length > 0) {
                  yield* Effect.logWarning(
                    "swarm start requested while partially initialized; starting missing agents",
                    {
                      threadId,
                      missingAgentIds: missingAgents.map((agent) => agent.id),
                    },
                  );
                  yield* Effect.forEach(
                    missingAgents,
                    (agent) => startAgentSession({ threadId, agent, createdAt }),
                    { concurrency: 4 },
                  );
                  yield* broadcastStartPrompt(threadId, createdAt, missingAgents);
                  return;
                }
                yield* dispatchSystemNotice({
                  threadId,
                  createdAt,
                  text: "Swarm is already running. Ignoring duplicate start request.",
                });
                return;
              }
              runtime.started = true;
              runtime.stopping = false;
              yield* syncSwarmBoard(threadId, createdAt);
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
        providerService.stopSession({ threadId: agent.providerThreadId }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("swarm stop failed", { cause: safeCauseMessage(cause) }),
          ),
          Effect.asVoid,
        ),
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
        const existingSession = activeSessions.find((s) => s.threadId === providerThreadId);
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
      yield* syncSwarmBoard(thread.id, now);
    }
  });

  const handleOperatorMessage = (
    event: Extract<OrchestrationEvent, { type: "swarm.agent.message" }>,
  ) =>
    Effect.gen(function* () {
      if (event.payload.sender !== "operator") return;
      const parentThreadId = event.payload.threadId;
      const runtimeOption = yield* ensureSwarmRuntime(parentThreadId);
      if (Option.isNone(runtimeOption)) return;
      const runtime = runtimeOption.value;
      const targets = runtime.config.agents.filter((agent) =>
        event.payload.targetAgentId ? agent.id === event.payload.targetAgentId : true,
      );
      const operatorLabel = "operator";
      const deliveredBody = formatDirectMessageBody(operatorLabel, event.payload.text);
      yield* Effect.forEach(
        targets,
        (agent) =>
          sendTurnToAgent({
            threadId: parentThreadId,
            agent,
            text: deliveredBody,
            createdAt: event.occurredAt,
            replyTargetAgentId:
              event.payload.sender === "operator"
                ? SWARM_OPERATOR_TARGET_ID
                : (event.payload.senderAgentId ?? null),
          }),
        { concurrency: 4 },
      );
    });

  const handleProviderEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      console.warn(`[SWARM DEBUG] handleProviderEvent: ${event.type} for ${event.threadId}`);
      const decoded = decodeSwarmSessionThreadId(event.threadId);
      if (!decoded) {
        console.warn(
          `[SWARM DEBUG] decodeSwarmSessionThreadId returned null - not a swarm thread?`,
        );
        return;
      }
      const { threadId, agentId } = decoded;
      console.warn(`[SWARM DEBUG] decoded: threadId=${threadId}, agentId=${agentId}`);
      const runtime = swarmByThreadId.get(String(threadId));
      if (!runtime) {
        console.log(`[SWARM DEBUG] NO RUNTIME found for thread ${threadId}`);
        console.log(
          `[SWARM DEBUG] available threads: ${Array.from(swarmByThreadId.keys()).join(", ")}`,
        );
        return;
      }
      console.log(
        `[SWARM DEBUG] runtime found, agents: ${runtime.config.agents.map((a) => a.id).join(", ")}`,
      );
      const agent = runtime.config.agents.find((entry) => entry.id === agentId);
      if (!agent) {
        console.log(`[SWARM DEBUG] agent ${agentId} NOT FOUND in runtime config`);
        return;
      }
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
      const flushBufferedTurnOutput = (input: {
        turnKey: string;
        updatedAt: string;
        includeReasoning: boolean;
        forceHandleDirectives?: boolean;
      }) =>
        Effect.gen(function* () {
          const buffered = agentState.buffered;
          if (buffered && buffered.turnKey === input.turnKey) {
            if (input.forceHandleDirectives) {
              buffered.forceHandleDirectives = true;
            }
            const processedSignatures = buffered.processedDirectiveSignatures ?? new Set<string>();
            if (!buffered.processedDirectiveSignatures) {
              buffered.processedDirectiveSignatures = processedSignatures;
            }
            const hasDeliveredDirectives = processedSignatures.size > 0;
            console.warn(
              `[SWARM] flushBufferedTurnOutput: processedDirectives=${hasDeliveredDirectives}, finalRenderedText="${buffered.finalRenderedText}", text="${buffered.text.slice(
                0,
                100,
              )}"`,
            );
            if (hasDeliveredDirectives) {
              const textToSend = buffered.finalRenderedText ?? buffered.text;
              console.warn(
                `[SWARM] dispatching final message with text: "${textToSend.slice(0, 50)}"`,
              );
              yield* dispatchMessageAppend({
                threadId,
                messageId: buffered.messageId,
                sender: "agent",
                senderAgentId: agentId,
                targetAgentId: null,
                text: textToSend,
                streaming: false,
                createdAt: buffered.createdAt,
                updatedAt: input.updatedAt,
              });
            } else if (buffered.text.length > 0) {
              const handledDirectedMessage = yield* tryHandleAgentDirectedMessage(
                runtime,
                threadId,
                agentId,
                buffered.createdAt,
                input.updatedAt,
                buffered.text,
                processedSignatures,
              );
              if (handledDirectedMessage.handled) {
                yield* dispatchMessageAppend({
                  threadId,
                  messageId: buffered.messageId,
                  sender: "agent",
                  senderAgentId: agentId,
                  targetAgentId: null,
                  text:
                    handledDirectedMessage.publicText.length > 0
                      ? handledDirectedMessage.publicText
                      : handledDirectedMessage.deliverySummary,
                  streaming: false,
                  createdAt: buffered.createdAt,
                  updatedAt: input.updatedAt,
                });
              } else {
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
                    updatedAt: input.updatedAt,
                  });
                  const targetAgent = runtime.config.agents.find(
                    (entry) => entry.id === replyTargetAgentId,
                  );
                  if (targetAgent) {
                    yield* sendTurnToAgent({
                      threadId,
                      agent: targetAgent,
                      text: stripped.body,
                      createdAt: input.updatedAt,
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
                    updatedAt: input.updatedAt,
                  });
                }
              }
            }
            delete agentState.buffered;
          }
          if (input.includeReasoning) {
            const reasoningBuffered = agentState.reasoningBuffered;
            if (reasoningBuffered && reasoningBuffered.turnKey === input.turnKey) {
              yield* dispatchMessageAppend({
                threadId,
                messageId: reasoningBuffered.messageId,
                sender: "agent",
                senderAgentId: agentId,
                targetAgentId: null,
                text: reasoningBuffered.text,
                streaming: false,
                createdAt: reasoningBuffered.createdAt,
                updatedAt: input.updatedAt,
              });
              delete agentState.reasoningBuffered;
            }
          }
        });
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
            status === "error" ? (reason ?? agentState.lastError ?? null) : null;
          agentState.statusUpdatedAt = event.createdAt;
          yield* updateStatus(status, agentState.lastError);
          yield* syncTasksForAgentStatus(status, reason);
          if (status === "ready" || status === "idle") {
            yield* flushQueuedTurnForAgent({
              threadId,
              runtime,
              agent,
              createdAt: event.createdAt,
            });
          }
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
            yield* Effect.logDebug(
              "swarm agent session exited with pending tasks or is coordinator, restarting",
              {
                threadId,
                agentId,
                role: agent.role,
              },
            );
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
          console.log(`[SWARM DEBUG] content.delta streamKind: ${event.payload.streamKind}`);
          const isReasoning =
            event.payload.streamKind === "reasoning_text" ||
            event.payload.streamKind === "reasoning_summary_text";
          const isAssistant =
            event.payload.streamKind === "assistant_text" || event.payload.streamKind === "unknown";
          console.log(`[SWARM DEBUG] isReasoning=${isReasoning}, isAssistant=${isAssistant}`);
          if (!isReasoning && !isAssistant) {
            console.log(`[SWARM DEBUG] breaking - not reasoning or assistant stream`);
            break;
          }

          if (agentState.status !== "running") {
            agentState.status = "running";
            agentState.statusUpdatedAt = event.createdAt;
            yield* updateStatus("running");
            yield* syncTasksForAgentStatus("running");
          }
          const turnKey = toTurnKey(threadId, agentId, event.turnId);
          if (isReasoning) {
            const existingBuffer = agentState.reasoningBuffered;
            const messageId =
              existingBuffer?.messageId ?? MessageId.makeUnsafe(crypto.randomUUID());
            const createdAt = existingBuffer?.createdAt ?? event.createdAt;
            const prefix = !existingBuffer ? "[thinking] " : "";
            const deltaText = `${prefix}${event.payload.delta ?? ""}`;
            const reconciled = existingBuffer
              ? reconcileStreamText(existingBuffer.text, deltaText)
              : { text: deltaText, delta: deltaText };
            agentState.reasoningBuffered = {
              messageId,
              turnKey,
              createdAt,
              text: reconciled.text,
            };
            if (reconciled.delta.length > 0) {
              yield* dispatchMessageAppend({
                threadId,
                messageId,
                sender: "agent",
                senderAgentId: agentId,
                targetAgentId: null,
                text: reconciled.delta,
                streaming: true,
                createdAt,
                updatedAt: event.createdAt,
              });
            }
            break;
          }

          const existingBuffer = agentState.buffered;
          const messageId = existingBuffer?.messageId ?? MessageId.makeUnsafe(crypto.randomUUID());
          const createdAt = existingBuffer?.createdAt ?? event.createdAt;
          const prefix = "";
          const deltaText = `${prefix}${event.payload.delta ?? ""}`;
          const reconciled = existingBuffer
            ? reconcileStreamText(existingBuffer.text, deltaText)
            : { text: deltaText, delta: deltaText };
          agentState.buffered = {
            messageId,
            turnKey,
            createdAt,
            text: reconciled.text,
            ...(existingBuffer?.processedDirectiveSignatures
              ? { processedDirectiveSignatures: existingBuffer.processedDirectiveSignatures }
              : {}),
            finalRenderedText: existingBuffer?.finalRenderedText,
            forceHandleDirectives: existingBuffer?.forceHandleDirectives ?? false,
          };
          if (reconciled.delta.length > 0) {
            yield* dispatchMessageAppend({
              threadId,
              messageId,
              sender: "agent",
              senderAgentId: agentId,
              targetAgentId: null,
              text: reconciled.delta,
              streaming: true,
              createdAt,
              updatedAt: event.createdAt,
            });
          }
          const latestBuffer = agentState.buffered;
          if (latestBuffer) {
            const latestTextLower = latestBuffer.text.toLowerCase();
            const hasCloseToken =
              latestTextLower.includes("[swarm.message_close]") ||
              latestTextLower.includes("[message_swarm_close]");
            const hasSwarmDirective =
              latestTextLower.includes("[swarm.message ") ||
              latestTextLower.includes("[swarm.message]") ||
              latestTextLower.includes("[[swarm.message") ||
              latestTextLower.includes("[message_swarm ") ||
              latestTextLower.includes("swarm.message ") ||
              latestTextLower.includes("swarm.message]") ||
              latestTextLower.includes("message_swarm ");
            console.log(
              `[SWARM DEBUG] hasCloseToken=${hasCloseToken}, hasSwarmDirective=${hasSwarmDirective}`,
            );
            console.log(`[SWARM DEBUG] latestBuffer.text: ${latestBuffer.text.slice(0, 150)}`);
            const processedSignatures =
              latestBuffer.processedDirectiveSignatures ?? new Set<string>();
            latestBuffer.processedDirectiveSignatures = processedSignatures;
            const shouldHandleDirectiveNow =
              hasCloseToken || Boolean(latestBuffer.forceHandleDirectives);
            if (hasSwarmDirective && shouldHandleDirectiveNow) {
              yield* Effect.logDebug("swarm: detected directive pattern in content.delta", {
                threadId,
                agentId,
                hasCloseToken,
                hasSwarmDirective,
                textLength: latestBuffer.text.length,
                textPreview: latestBuffer.text.slice(0, 200),
              });
              yield* Effect.logDebug("swarm: runtime config agents", {
                threadId,
                agentId,
                agents: runtime.config.agents.map((a) => a.id),
              });
              const handledDirectedMessage = yield* tryHandleAgentDirectedMessage(
                runtime,
                threadId,
                agentId,
                latestBuffer.createdAt,
                event.createdAt,
                latestBuffer.text,
                processedSignatures,
              );
              yield* Effect.logDebug("swarm: tryHandleAgentDirectedMessage result", {
                threadId,
                agentId,
                handled: handledDirectedMessage.handled,
                publicText: handledDirectedMessage.publicText.slice(0, 100),
                deliverySummary: handledDirectedMessage.deliverySummary,
              });
              if (!handledDirectedMessage.handled && hasSwarmDirective) {
                yield* Effect.logDebug("swarm: message NOT handled - will retry on flush", {
                  threadId,
                  agentId,
                  textPreview: latestBuffer.text.slice(0, 200),
                });
              }
              if (handledDirectedMessage.handled) {
                const finalText =
                  handledDirectedMessage.publicText.length > 0
                    ? handledDirectedMessage.publicText
                    : handledDirectedMessage.deliverySummary;
                if (finalText) {
                  latestBuffer.finalRenderedText = finalText;
                } else {
                  delete latestBuffer.finalRenderedText;
                }
              }
            } else if (hasSwarmDirective) {
              // Defer directive parsing until flush/turn completion so partial
              // streaming bodies do not emit duplicated incremental direct messages.
              yield* Effect.logDebug("swarm: deferring directive parse until flush", {
                threadId,
                agentId,
                textLength: latestBuffer.text.length,
              });
            }
          }
          break;
        }
        case "item.completed": {
          const turnKey = toTurnKey(threadId, agentId, event.turnId);
          yield* flushBufferedTurnOutput({
            turnKey,
            updatedAt: event.createdAt,
            includeReasoning: false,
            forceHandleDirectives: true,
          });
          break;
        }
        case "turn.completed": {
          if (isStaleStatusEvent) {
            break;
          }
          const turnKey = toTurnKey(threadId, agentId, event.turnId);
          yield* flushBufferedTurnOutput({
            turnKey,
            updatedAt: event.createdAt,
            includeReasoning: true,
            forceHandleDirectives: true,
          });
          const status = event.payload.state === "failed" ? "error" : "ready";
          agentState.status = status;
          const lastError =
            event.payload.state === "failed" ? (event.payload.errorMessage ?? null) : null;
          agentState.lastError = lastError;
          agentState.statusUpdatedAt = event.createdAt;
          yield* updateStatus(status, lastError);
          yield* syncTasksForAgentStatus(status, lastError ?? undefined);
          if (status === "ready") {
            yield* flushQueuedTurnForAgent({
              threadId,
              runtime,
              agent,
              createdAt: event.createdAt,
            });
          }
          if (agent.role === "coordinator" && status === "ready") {
            const builders = runtime.config.agents.filter((a) => a.role === "builder");
            for (const builder of builders) {
              const builderState = runtime.agents.get(builder.id);
              const builderTasks = Array.from(runtime.tasks.values()).filter(
                (t) =>
                  t.ownerAgentId === builder.id &&
                  (t.status === "queued" || t.status === "building"),
              );
              if (
                builderTasks.length > 0 &&
                (!builderState || builderState.status === "idle" || builderState.status === "ready")
              ) {
                const task = builderTasks[0]!;
                yield* Effect.logDebug("auto-starting builder task", {
                  threadId,
                  builderId: builder.id,
                  taskId: task.id,
                });
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
                if (
                  !coordinatorState ||
                  coordinatorState.status === "ready" ||
                  coordinatorState.status === "idle"
                ) {
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
          const message =
            typeof event.payload.message === "string"
              ? event.payload.message
              : "Provider runtime error";
          let detailText: string | null = null;
          if (event.payload.detail !== undefined) {
            try {
              detailText = JSON.stringify(event.payload.detail);
            } catch {
              detailText = String(event.payload.detail);
            }
          }
          const combined = detailText ? `${message} | detail: ${detailText}` : message;
          const summarized = combined.length > 800 ? `${combined.slice(0, 800)}…` : combined;
          const isToolError = /apply_patch verification failed|codex_core::tools::router/i.test(
            summarized,
          );
          const errorClass = (event.payload.class ?? null) as RuntimeErrorClass | null;
          const fatalErrorClasses: RuntimeErrorClass[] = [
            "provider_error",
            "transport_error",
            "permission_error",
          ];
          const isFatal = errorClass ? fatalErrorClasses.includes(errorClass) : false;
          yield* Effect.logWarning("swarm runtime error", {
            threadId,
            agentId,
            message,
            detail: detailText ?? undefined,
            class: errorClass ?? undefined,
          });
          if (isToolError) {
            agentState.lastError = summarized;
            agentState.statusUpdatedAt = event.createdAt;
            break;
          }
          if (!isFatal) {
            agentState.lastError = summarized;
            agentState.statusUpdatedAt = event.createdAt;
            break;
          }
          agentState.status = "error";
          agentState.lastError = summarized;
          agentState.statusUpdatedAt = event.createdAt;
          yield* updateStatus("error", summarized);
          yield* syncTasksForAgentStatus("error", summarized);
          yield* dispatchSystemNotice({
            threadId,
            createdAt: event.createdAt,
            text: `Swarm agent ${agentId} hit runtime.error: ${summarized}`,
          });
          break;
        }
        default:
          break;
      }
    });

  const handleDomainEvent = (event: OrchestrationEvent) => {
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
        }).pipe(
          Effect.tap(() => syncSwarmBoard(event.payload.threadId, event.payload.task.updatedAt)),
        );
      case "swarm.task.updated":
        return Effect.sync(() => {
          const runtime = swarmByThreadId.get(String(event.payload.threadId));
          if (!runtime) return;
          runtime.tasks.set(event.payload.task.id, event.payload.task);
        }).pipe(
          Effect.tap(() => syncSwarmBoard(event.payload.threadId, event.payload.task.updatedAt)),
        );
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
        }).pipe(Effect.tap(() => syncSwarmBoard(event.payload.threadId, event.payload.updatedAt)));
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
        }).pipe(Effect.tap(() => syncSwarmBoard(event.payload.threadId, event.payload.updatedAt)));
      default:
        return Effect.void;
    }
  };

  const processInput = (input: RuntimeInput) =>
    input.source === "domain" ? handleDomainEvent(input.event) : handleProviderEvent(input.event);

  const processSafely = (input: RuntimeInput) =>
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
    console.log("[SWARM] SwarmCoordinator starting...");
    yield* ensureRuntimeFromReadModel;
    const queue = yield* Queue.unbounded<RuntimeInput>();
    console.log("[SWARM] SwarmCoordinator started, listening for provider events...");
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processSafely))));

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        Queue.offer(queue, { source: "domain", event }).pipe(Effect.asVoid),
      ),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        const isSwarm = isSwarmSessionThreadId(event.threadId);
        console.log(
          `[SWARM] provider event: type=${event.type}, threadId=${event.threadId}, isSwarm=${isSwarm}`,
        );
        return isSwarm
          ? Queue.offer(queue, { source: "provider", event }).pipe(Effect.asVoid)
          : Effect.void;
      }),
    );
  });

  return {
    start,
  } satisfies SwarmCoordinatorShape;
});

export const SwarmCoordinatorLive = Layer.effect(SwarmCoordinator, makeSwarmCoordinator);
