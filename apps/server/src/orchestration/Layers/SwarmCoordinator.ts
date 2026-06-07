// @ts-nocheck
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ProviderDriverKind,
  SWARM_OPERATOR_TARGET_ID,
  type ThreadId,
  type TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type SwarmAgent,
  type SwarmAgentStatus,
  type SwarmConfig,
} from "@t3tools/contracts";
import { parseSwarmMessage } from "@t3tools/shared/swarmMessaging";
import type { ParsedSwarmDirective } from "@t3tools/shared/swarmMessaging";
import { resolveSwarmTarget } from "@t3tools/shared/swarmTargets";
import { Cause, Effect, Layer, Option, Queue, Stream } from "effect";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { SwarmCoordinator, type SwarmCoordinatorShape } from "../Services/SwarmCoordinator.ts";
import { getSwarmRoleInstructions } from "../SwarmInstructions.ts";
import {
  decodeSwarmSessionThreadId,
  encodeSwarmSessionThreadId,
  isSwarmSessionThreadId,
} from "../SwarmSessionCodec.ts";

type RuntimeInput =
  | { readonly source: "domain"; readonly event: OrchestrationEvent }
  | { readonly source: "provider"; readonly event: ProviderRuntimeEvent };

type RuntimeAgent = {
  readonly agent: SwarmAgent;
  readonly providerThreadId: ReturnType<typeof encodeSwarmSessionThreadId>;
  status: SwarmAgentStatus;
  buffer: string;
  activeTranscriptMessageId: MessageId | null;
  reasoningBuffer: string;
  activeReasoningMessageId: MessageId | null;
  toolBuffer: string;
  activeToolMessageId: MessageId | null;
  turnInFlight: boolean;
  activeProviderTurnId: TurnId | null;
  preemptionRequested: boolean;
  abortSendFailuresToSuppress: number;
  preemptedProviderTurnIds: Set<string>;
  preemptionsAwaitingRestart: Set<string>;
  routedDirectiveKeys: Set<string>;
  routedDirectiveMessageIds: Map<string, MessageId>;
  pendingTurns: Array<{ readonly text: string; readonly createdAt: string }>;
};

type RuntimeSwarm = {
  readonly config: SwarmConfig;
  readonly agents: Map<string, RuntimeAgent>;
  started: boolean;
};

const BUSY_AGENT_STATUSES = new Set<SwarmAgentStatus>(["starting", "running"]);
const OPENCODE_PROVIDER = ProviderDriverKind.make("opencode");

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const serverCommandId = (tag: string, randomUUID: string): CommandId =>
  CommandId.make(`server:swarm:${tag}:${randomUUID}`);

const serverMessageId = (tag: string, randomUUID: string): MessageId =>
  MessageId.make(`server:swarm:${tag}:${randomUUID}`);

const RUNTIME_STATE_TO_STATUS: Record<string, SwarmAgentStatus> = {
  starting: "starting",
  ready: "ready",
  running: "running",
  waiting: "ready",
  stopped: "stopped",
  error: "error",
};

function mapRuntimeStatus(state: string): SwarmAgentStatus {
  return RUNTIME_STATE_TO_STATUS[state] ?? "ready";
}

function getAgentProviderInstanceId(agent: SwarmAgent): ProviderInstanceId {
  return agent.providerInstanceId ?? ProviderInstanceId.make(String(agent.provider));
}

function formatCause(cause: Cause.Cause<unknown>): string {
  return Cause.pretty(cause).slice(0, 2_000);
}

function isAbortLikeText(text: string | null | undefined): boolean {
  return /\babort(?:ed)?\b/i.test(text ?? "");
}

function isAbortLikeCause(cause: Cause.Cause<unknown>): boolean {
  return isAbortLikeText(formatCause(cause));
}

function swarmDirectiveKey(directive: ParsedSwarmDirective): string {
  return `${directive.targetRaw}\u0000${directive.body}`;
}

function parseSwarmDirectiveKey(key: string): { targetRaw: string; body: string } | null {
  const separatorIndex = key.indexOf("\u0000");
  if (separatorIndex < 0) {
    return null;
  }
  return {
    targetRaw: key.slice(0, separatorIndex),
    body: key.slice(separatorIndex + 1),
  };
}

function resolveStreamingDelta(existingText: string, nextChunk: string): string {
  if (existingText.length > 0 && nextChunk.startsWith(existingText)) {
    return nextChunk.slice(existingText.length);
  }
  return nextChunk;
}

function findRoutedDirectiveSupersetKey(
  runtimeAgent: RuntimeAgent,
  directive: ParsedSwarmDirective,
): string | null {
  for (const existingKey of runtimeAgent.routedDirectiveKeys) {
    const existing = parseSwarmDirectiveKey(existingKey);
    if (!existing || existing.targetRaw !== directive.targetRaw) {
      continue;
    }
    if (existing.body.startsWith(directive.body) && existing.body !== directive.body) {
      return existingKey;
    }
  }
  return null;
}

function takeReusableRoutedDirectiveMessageId(
  runtimeAgent: RuntimeAgent,
  directive: ParsedSwarmDirective,
): MessageId | undefined {
  for (const existingKey of runtimeAgent.routedDirectiveKeys) {
    const existing = parseSwarmDirectiveKey(existingKey);
    if (!existing || existing.targetRaw !== directive.targetRaw) {
      continue;
    }
    if (directive.body.startsWith(existing.body) && directive.body !== existing.body) {
      const messageId = runtimeAgent.routedDirectiveMessageIds.get(existingKey);
      runtimeAgent.routedDirectiveKeys.delete(existingKey);
      runtimeAgent.routedDirectiveMessageIds.delete(existingKey);
      return messageId;
    }
  }
  return undefined;
}

function isStreamingDirectiveBounded(text: string, directive: ParsedSwarmDirective): boolean {
  const directiveIndex = text.indexOf(directive.rawText);
  if (directiveIndex < 0) {
    return false;
  }
  const afterDirective = text.slice(directiveIndex + directive.rawText.length);
  return /^[ \t]*(?:\r?\n[ \t]*\r?\n|\[swarm\.message_close\]|\[message_swarm_close\]|\[\[?swarm\.message\b|\[\[?message_swarm\b)/i.test(
    afterDirective,
  );
}

function firstAwaitingPreemptionKey(runtimeAgent: RuntimeAgent): string | null {
  return runtimeAgent.preemptionsAwaitingRestart.values().next().value ?? null;
}

function registerPreemption(runtimeAgent: RuntimeAgent, randomUUID: string): string {
  const key = runtimeAgent.activeProviderTurnId
    ? String(runtimeAgent.activeProviderTurnId)
    : `unknown:${randomUUID}`;
  runtimeAgent.preemptedProviderTurnIds.add(key);
  runtimeAgent.preemptionsAwaitingRestart.add(key);
  runtimeAgent.abortSendFailuresToSuppress += 1;
  return key;
}

function preemptionKeyForProviderEvent(
  runtimeAgent: RuntimeAgent,
  event: ProviderRuntimeEvent,
  isAbortLike: boolean,
): string | null {
  const turnKey = event.turnId ? String(event.turnId) : null;
  if (turnKey && runtimeAgent.preemptedProviderTurnIds.has(turnKey)) {
    return turnKey;
  }

  const awaitingKey = firstAwaitingPreemptionKey(runtimeAgent);
  if (!isAbortLike || !awaitingKey) {
    return null;
  }

  if (turnKey) {
    runtimeAgent.preemptedProviderTurnIds.add(turnKey);
  }
  return awaitingKey;
}

function mapSessionStatusForAgent(
  runtimeAgent: RuntimeAgent,
  status: SwarmAgentStatus,
): SwarmAgentStatus {
  return runtimeAgent.turnInFlight && status === "ready" ? "running" : status;
}

function formatAgentPrompt(config: SwarmConfig, agent: SwarmAgent): string {
  const roster = config.agents
    .map((entry) => `- ${entry.id}: ${entry.name} (${entry.role})`)
    .join("\n");
  const startPrompt = config.startPrompt?.trim();
  const skills =
    config.skills && config.skills.length > 0
      ? `\n\nMission skills:\n${config.skills.map((skill) => `- ${skill}`).join("\n")}`
      : "";
  const uploadedSkills =
    config.uploadedSkills && config.uploadedSkills.length > 0
      ? `\n\nUploaded swarm skills (required):\nEvery agent in this swarm has these uploaded skills. You MUST use the relevant guidance from these skills for this task.\n${config.uploadedSkills
          .map((skill) => {
            const details = [
              `- ${skill.name}`,
              `  path: ${skill.path}`,
              `  source: ${skill.sourceType}`,
              skill.content
                ? `  content:\n${skill.content}`
                : "  content: read this path if needed.",
            ];
            return details.join("\n");
          })
          .join("\n\n")}`
      : "";

  return `${getSwarmRoleInstructions(agent.role)}

Swarm mission:
${config.mission}

You are:
- id: ${agent.id}
- name: ${agent.name}
- role: ${agent.role}

Swarm roster:
${roster}
${skills}
${uploadedSkills}
${startPrompt ? `\n\nOperator start prompt:\n${startPrompt}` : ""}

Start now. Coordinate only through literal [swarm.message <target>] markers when talking to the operator or another swarm agent.`;
}

export const makeSwarmCoordinator = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const swarms = new Map<string, RuntimeSwarm>();

  const dispatchStatus = (input: {
    readonly threadId: ThreadId;
    readonly agentId: string;
    readonly status: SwarmAgentStatus;
    readonly createdAt: string;
    readonly lastError?: string | null;
  }) =>
    randomUUID.pipe(
      Effect.flatMap((id) =>
        orchestrationEngine.dispatch({
          type: "swarm.agent.status.set",
          commandId: serverCommandId("status", id),
          threadId: input.threadId,
          agentId: input.agentId,
          status: input.status,
          lastError: input.lastError ?? null,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.warn("failed to dispatch swarm status", formatCause(cause));
        }),
      ),
      Effect.asVoid,
    );

  const dispatchMessage = (input: {
    readonly threadId: ThreadId;
    readonly messageId?: MessageId;
    readonly senderAgentId: string | null;
    readonly targetAgentId: string | null;
    readonly text: string;
    readonly streaming?: boolean;
    readonly createdAt: string;
  }) =>
    randomUUID.pipe(
      Effect.flatMap((id) =>
        orchestrationEngine.dispatch({
          type: "swarm.agent.message.append",
          commandId: serverCommandId("message", id),
          threadId: input.threadId,
          messageId:
            input.messageId ??
            serverMessageId(
              "message",
              // Reuse the same random source so command and message IDs stay aligned.
              id,
            ),
          sender: input.senderAgentId === null ? "operator" : "agent",
          senderAgentId: input.senderAgentId,
          targetAgentId: input.targetAgentId,
          text: input.text,
          streaming: input.streaming ?? false,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.warn("failed to dispatch swarm message", formatCause(cause));
        }),
      ),
      Effect.asVoid,
    );

  const ensureRuntime = Effect.fnUntraced(function* (threadId: ThreadId) {
    const existing = swarms.get(String(threadId));
    if (existing) return Option.some(existing);

    const readModel = yield* projectionSnapshotQuery.getSnapshot().pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.warn("failed to load swarm runtime snapshot", formatCause(cause));
          return null as const;
        }),
      ),
    );
    if (readModel === null) return Option.none<RuntimeSwarm>();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread?.swarm) return Option.none<RuntimeSwarm>();

    const runtime: RuntimeSwarm = {
      config: thread.swarm.config,
      agents: new Map(
        thread.swarm.config.agents.map((agent) => [
          agent.id,
          {
            agent,
            providerThreadId: encodeSwarmSessionThreadId(thread.id, agent.id),
            status: "idle" as SwarmAgentStatus,
            buffer: "",
            activeTranscriptMessageId: null,
            reasoningBuffer: "",
            activeReasoningMessageId: null,
            toolBuffer: "",
            activeToolMessageId: null,
            turnInFlight: false,
            activeProviderTurnId: null,
            preemptionRequested: false,
            abortSendFailuresToSuppress: 0,
            preemptedProviderTurnIds: new Set(),
            preemptionsAwaitingRestart: new Set(),
            routedDirectiveKeys: new Set(),
            routedDirectiveMessageIds: new Map(),
            pendingTurns: [],
          },
        ]),
      ),
      started: false,
    };
    swarms.set(String(threadId), runtime);
    return Option.some(runtime);
  });

  const sendTurn = (input: {
    readonly threadId: ThreadId;
    readonly runtime: RuntimeSwarm;
    readonly runtimeAgent: RuntimeAgent;
    readonly text: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      if (input.runtimeAgent.turnInFlight) {
        input.runtimeAgent.pendingTurns.push({
          text: input.text,
          createdAt: input.createdAt,
        });
        if (
          !input.runtimeAgent.preemptionRequested &&
          input.runtimeAgent.agent.provider === OPENCODE_PROVIDER
        ) {
          input.runtimeAgent.preemptionRequested = true;
          const preemptionKey = registerPreemption(input.runtimeAgent, yield* randomUUID);
          yield* providerService
            .interruptTurn({ threadId: input.runtimeAgent.providerThreadId })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  input.runtimeAgent.preemptionRequested = false;
                  input.runtimeAgent.preemptionsAwaitingRestart.delete(preemptionKey);
                  input.runtimeAgent.preemptedProviderTurnIds.delete(preemptionKey);
                  input.runtimeAgent.abortSendFailuresToSuppress = Math.max(
                    0,
                    input.runtimeAgent.abortSendFailuresToSuppress - 1,
                  );
                  yield* Effect.sync(() => {
                    console.warn("failed to preempt running swarm turn", {
                      threadId: input.threadId,
                      agentId: input.runtimeAgent.agent.id,
                      cause: formatCause(cause),
                    });
                  });
                }),
              ),
              Effect.asVoid,
            );
        }
        return;
      }

      input.runtimeAgent.preemptionRequested = false;
      input.runtimeAgent.status = "running";
      input.runtimeAgent.turnInFlight = true;
      yield* dispatchStatus({
        threadId: input.threadId,
        agentId: input.runtimeAgent.agent.id,
        status: "running",
        createdAt: input.createdAt,
      });

      const providerInstanceId = getAgentProviderInstanceId(input.runtimeAgent.agent);
      yield* providerService
        .sendTurn({
          threadId: input.runtimeAgent.providerThreadId,
          input: input.text,
          attachments: [],
          modelSelection: {
            instanceId: providerInstanceId,
            model: input.runtimeAgent.agent.model,
            options: input.runtimeAgent.agent.modelOptions ?? [],
          },
          interactionMode: input.runtimeAgent.agent.interactionMode,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (
                input.runtimeAgent.agent.provider === OPENCODE_PROVIDER &&
                input.runtimeAgent.abortSendFailuresToSuppress > 0 &&
                isAbortLikeCause(cause)
              ) {
                input.runtimeAgent.abortSendFailuresToSuppress -= 1;
                const preemptionKey = firstAwaitingPreemptionKey(input.runtimeAgent);
                if (preemptionKey) {
                  yield* handleExpectedPreemptionSignal({
                    threadId: input.threadId,
                    runtime: input.runtime,
                    runtimeAgent: input.runtimeAgent,
                    preemptionKey,
                    createdAt: yield* nowIso,
                  });
                }
                return;
              }

              const detail = formatCause(cause);
              input.runtimeAgent.status = "error";
              input.runtimeAgent.turnInFlight = false;
              input.runtimeAgent.activeProviderTurnId = null;
              input.runtimeAgent.preemptionRequested = false;
              yield* dispatchStatus({
                threadId: input.threadId,
                agentId: input.runtimeAgent.agent.id,
                status: "error",
                lastError: detail,
                createdAt: yield* nowIso,
              });
              yield* dispatchMessage({
                threadId: input.threadId,
                senderAgentId: null,
                targetAgentId: SWARM_OPERATOR_TARGET_ID,
                text: `Failed to send turn to ${input.runtimeAgent.agent.name}: ${detail}`,
                createdAt: yield* nowIso,
              });
            }),
          ),
          Effect.asVoid,
          Effect.forkDetach,
          Effect.asVoid,
        );
    });

  const sendNextPendingTurn = (input: {
    readonly threadId: ThreadId;
    readonly runtime: RuntimeSwarm;
    readonly runtimeAgent: RuntimeAgent;
  }) =>
    Effect.gen(function* () {
      if (input.runtimeAgent.status !== "ready" || input.runtimeAgent.turnInFlight) return;
      const next = input.runtimeAgent.pendingTurns.shift();
      if (!next) return;
      yield* sendTurn({
        threadId: input.threadId,
        runtime: input.runtime,
        runtimeAgent: input.runtimeAgent,
        text: next.text,
        createdAt: next.createdAt,
      });
    });

  const handleExpectedPreemptionSignal = (input: {
    readonly threadId: ThreadId;
    readonly runtime: RuntimeSwarm;
    readonly runtimeAgent: RuntimeAgent;
    readonly preemptionKey: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      if (!input.runtimeAgent.preemptionsAwaitingRestart.delete(input.preemptionKey)) {
        return;
      }

      input.runtimeAgent.turnInFlight = false;
      input.runtimeAgent.activeProviderTurnId = null;
      input.runtimeAgent.preemptionRequested = false;
      input.runtimeAgent.status = "ready";
      yield* finalizeActivityMessages({
        threadId: input.threadId,
        agentId: input.runtimeAgent.agent.id,
        runtimeAgent: input.runtimeAgent,
        createdAt: input.createdAt,
      });
      yield* dispatchStatus({
        threadId: input.threadId,
        agentId: input.runtimeAgent.agent.id,
        status: "ready",
        createdAt: input.createdAt,
      });
      yield* sendNextPendingTurn({
        threadId: input.threadId,
        runtime: input.runtime,
        runtimeAgent: input.runtimeAgent,
      });
    });

  const startAgent = (input: {
    readonly threadId: ThreadId;
    readonly runtime: RuntimeSwarm;
    readonly runtimeAgent: RuntimeAgent;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const readModel = yield* projectionSnapshotQuery.getSnapshot().pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.warn("failed to load swarm runtime snapshot", formatCause(cause));
            return null as const;
          }),
        ),
      );
      if (readModel === null) {
        input.runtimeAgent.status = "error";
        yield* dispatchStatus({
          threadId: input.threadId,
          agentId: input.runtimeAgent.agent.id,
          status: "error",
          createdAt: input.createdAt,
          lastError: "Failed to load swarm read model.",
        });
        return;
      }
      const thread = readModel.threads.find((entry) => entry.id === input.threadId);
      const cwd = thread
        ? resolveThreadWorkspaceCwd({ thread, projects: readModel.projects })
        : null;

      input.runtimeAgent.status = "starting";
      yield* dispatchStatus({
        threadId: input.threadId,
        agentId: input.runtimeAgent.agent.id,
        status: "starting",
        createdAt: input.createdAt,
      });

      const providerInstanceId = getAgentProviderInstanceId(input.runtimeAgent.agent);
      const session = yield* providerService.startSession(input.runtimeAgent.providerThreadId, {
        threadId: input.runtimeAgent.providerThreadId,
        provider: input.runtimeAgent.agent.provider,
        providerInstanceId,
        modelSelection: {
          instanceId: providerInstanceId,
          model: input.runtimeAgent.agent.model,
          options: input.runtimeAgent.agent.modelOptions ?? [],
        },
        ...(cwd ? { cwd } : {}),
        runtimeMode: input.runtimeAgent.agent.runtimeMode,
      });

      input.runtimeAgent.status = mapRuntimeStatus(session.status);
      yield* dispatchStatus({
        threadId: input.threadId,
        agentId: input.runtimeAgent.agent.id,
        status: input.runtimeAgent.status,
        createdAt: session.updatedAt,
        lastError: session.lastError ?? null,
      });

      yield* sendTurn({
        threadId: input.threadId,
        runtime: input.runtime,
        runtimeAgent: input.runtimeAgent,
        text: formatAgentPrompt(input.runtime.config, input.runtimeAgent.agent),
        createdAt: input.createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const detail = formatCause(cause);
          input.runtimeAgent.status = "error";
          yield* dispatchStatus({
            threadId: input.threadId,
            agentId: input.runtimeAgent.agent.id,
            status: "error",
            lastError: detail,
            createdAt: yield* nowIso,
          });
          yield* dispatchMessage({
            threadId: input.threadId,
            senderAgentId: null,
            targetAgentId: SWARM_OPERATOR_TARGET_ID,
            text: `Failed to start ${input.runtimeAgent.agent.name}: ${detail}`,
            createdAt: yield* nowIso,
          });
        }),
      ),
    );

  const startSwarm = (threadId: ThreadId, createdAt: string) =>
    ensureRuntime(threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.sync(() => {
              console.warn("swarm start skipped: runtime not found", { threadId });
            }),
          onSome: (runtime) =>
            Effect.gen(function* () {
              const agents = Array.from(runtime.agents.values());
              if (
                runtime.started &&
                agents.some((agent) => BUSY_AGENT_STATUSES.has(agent.status))
              ) {
                yield* Effect.sync(() => {
                  console.debug("swarm start ignored: runtime already active", { threadId });
                });
                return;
              }

              runtime.started = true;
              yield* Effect.forEach(
                agents,
                (runtimeAgent) =>
                  runtimeAgent.status === "ready"
                    ? sendTurn({
                        threadId,
                        runtime,
                        runtimeAgent,
                        text: formatAgentPrompt(runtime.config, runtimeAgent.agent),
                        createdAt,
                      })
                    : startAgent({ threadId, runtime, runtimeAgent, createdAt }),
                { concurrency: 4 },
              );
            }),
        }),
      ),
    );

  const resolveTarget = (runtime: RuntimeSwarm, targetRaw: string): string | null => {
    return resolveSwarmTarget(runtime.config.agents, targetRaw).targetAgentId;
  };

  const routeAgentText = (input: {
    readonly threadId: ThreadId;
    readonly runtime: RuntimeSwarm;
    readonly senderAgentId: string;
    readonly runtimeAgent: RuntimeAgent;
    readonly transcriptMessageId: MessageId | null;
    readonly text: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const parsed = parseSwarmMessage(input.text);
      const visibleText = parsed.publicText || input.text.trim();
      if (visibleText.length > 0) {
        yield* dispatchMessage({
          threadId: input.threadId,
          ...(input.transcriptMessageId ? { messageId: input.transcriptMessageId } : {}),
          senderAgentId: input.senderAgentId,
          targetAgentId: null,
          text: visibleText,
          createdAt: input.createdAt,
        });
      } else if (input.transcriptMessageId && input.text.trim().length > 0) {
        yield* dispatchMessage({
          threadId: input.threadId,
          messageId: input.transcriptMessageId,
          senderAgentId: input.senderAgentId,
          targetAgentId: null,
          text: input.text.trim(),
          createdAt: input.createdAt,
        });
      }

      yield* routeAgentDirectives({
        threadId: input.threadId,
        runtime: input.runtime,
        senderAgentId: input.senderAgentId,
        runtimeAgent: input.runtimeAgent,
        directives: parsed.directives,
        createdAt: input.createdAt,
      });
    });

  const routeAgentDirectives = (input: {
    readonly threadId: ThreadId;
    readonly runtime: RuntimeSwarm;
    readonly senderAgentId: string;
    readonly runtimeAgent: RuntimeAgent;
    readonly directives: ReadonlyArray<ParsedSwarmDirective>;
    readonly createdAt: string;
  }) =>
    Effect.forEach(
      input.directives,
      (directive) =>
        Effect.gen(function* () {
          const key = swarmDirectiveKey(directive);
          if (input.runtimeAgent.routedDirectiveKeys.has(key)) {
            return;
          }
          if (findRoutedDirectiveSupersetKey(input.runtimeAgent, directive)) {
            return;
          }
          const messageId = takeReusableRoutedDirectiveMessageId(input.runtimeAgent, directive);
          input.runtimeAgent.routedDirectiveKeys.add(key);
          if (messageId) {
            input.runtimeAgent.routedDirectiveMessageIds.set(key, messageId);
          }

          const targetAgentId = resolveTarget(input.runtime, directive.targetRaw);
          if (!targetAgentId) {
            yield* dispatchMessage({
              threadId: input.threadId,
              senderAgentId: null,
              targetAgentId: SWARM_OPERATOR_TARGET_ID,
              text: `Swarm could not resolve target '${directive.targetRaw}' from ${input.senderAgentId}.`,
              createdAt: input.createdAt,
            });
            return;
          }

          const routedMessageId = messageId ?? serverMessageId("routed", yield* randomUUID);
          input.runtimeAgent.routedDirectiveMessageIds.set(key, routedMessageId);
          yield* dispatchMessage({
            threadId: input.threadId,
            messageId: routedMessageId,
            senderAgentId: input.senderAgentId,
            targetAgentId,
            text: directive.body,
            createdAt: input.createdAt,
          });

          if (targetAgentId !== SWARM_OPERATOR_TARGET_ID) {
            const target = input.runtime.agents.get(targetAgentId);
            if (target) {
              yield* sendTurn({
                threadId: input.threadId,
                runtime: input.runtime,
                runtimeAgent: target,
                text: directive.body,
                createdAt: input.createdAt,
              });
            }
          }
        }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);

  const routeStreamingAgentDirectives = (input: {
    readonly threadId: ThreadId;
    readonly runtime: RuntimeSwarm;
    readonly senderAgentId: string;
    readonly runtimeAgent: RuntimeAgent;
    readonly text: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const parsed = parseSwarmMessage(input.text);
      const completeDirectives = parsed.directives.filter((directive) => {
        return isStreamingDirectiveBounded(input.text, directive);
      });
      if (completeDirectives.length === 0) {
        return;
      }
      yield* routeAgentDirectives({
        threadId: input.threadId,
        runtime: input.runtime,
        senderAgentId: input.senderAgentId,
        runtimeAgent: input.runtimeAgent,
        directives: completeDirectives,
        createdAt: input.createdAt,
      });
    });

  const appendReasoningActivity = (input: {
    readonly threadId: ThreadId;
    readonly agentId: string;
    readonly runtimeAgent: RuntimeAgent;
    readonly delta: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      if (input.delta.length === 0) return;
      const isNewMessage = input.runtimeAgent.activeReasoningMessageId === null;
      input.runtimeAgent.activeReasoningMessageId ??= serverMessageId(
        "thinking",
        yield* randomUUID,
      );
      input.runtimeAgent.reasoningBuffer += input.delta;
      yield* dispatchMessage({
        threadId: input.threadId,
        messageId: input.runtimeAgent.activeReasoningMessageId,
        senderAgentId: input.agentId,
        targetAgentId: null,
        text: `${isNewMessage ? "[thinking]\n" : ""}${input.delta}`,
        streaming: true,
        createdAt: input.createdAt,
      });
    });

  const appendToolActivity = (input: {
    readonly threadId: ThreadId;
    readonly agentId: string;
    readonly runtimeAgent: RuntimeAgent;
    readonly delta: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      if (input.delta.length === 0) return;
      const isNewMessage = input.runtimeAgent.activeToolMessageId === null;
      input.runtimeAgent.activeToolMessageId ??= serverMessageId("tool", yield* randomUUID);
      input.runtimeAgent.toolBuffer += input.delta;
      yield* dispatchMessage({
        threadId: input.threadId,
        messageId: input.runtimeAgent.activeToolMessageId,
        senderAgentId: input.agentId,
        targetAgentId: null,
        text: `${isNewMessage ? "[tool]\n" : ""}${input.delta}`,
        streaming: true,
        createdAt: input.createdAt,
      });
    });

  const finalizeActivityMessages = (input: {
    readonly threadId: ThreadId;
    readonly agentId: string;
    readonly runtimeAgent: RuntimeAgent;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const reasoningText = input.runtimeAgent.reasoningBuffer.trim();
      const reasoningMessageId = input.runtimeAgent.activeReasoningMessageId;
      input.runtimeAgent.reasoningBuffer = "";
      input.runtimeAgent.activeReasoningMessageId = null;
      if (reasoningMessageId && reasoningText.length > 0) {
        yield* dispatchMessage({
          threadId: input.threadId,
          messageId: reasoningMessageId,
          senderAgentId: input.agentId,
          targetAgentId: null,
          text: `[thinking]\n${reasoningText}`,
          createdAt: input.createdAt,
        });
      }

      const toolText = input.runtimeAgent.toolBuffer.trim();
      const toolMessageId = input.runtimeAgent.activeToolMessageId;
      input.runtimeAgent.toolBuffer = "";
      input.runtimeAgent.activeToolMessageId = null;
      if (toolMessageId && toolText.length > 0) {
        yield* dispatchMessage({
          threadId: input.threadId,
          messageId: toolMessageId,
          senderAgentId: input.agentId,
          targetAgentId: null,
          text: `[tool]\n${toolText}`,
          createdAt: input.createdAt,
        });
      }
    });

  const handleOperatorMessage = (
    event: Extract<OrchestrationEvent, { type: "swarm.agent.message" }>,
  ) =>
    Effect.gen(function* () {
      if (event.payload.sender !== "operator") return;
      const runtimeOption = yield* ensureRuntime(event.payload.threadId);
      if (Option.isNone(runtimeOption)) return;
      const runtime = runtimeOption.value;
      const agents = event.payload.targetAgentId
        ? [runtime.agents.get(event.payload.targetAgentId)].filter(
            (entry): entry is RuntimeAgent => entry !== undefined,
          )
        : Array.from(runtime.agents.values());

      yield* Effect.forEach(
        agents,
        (runtimeAgent) =>
          sendTurn({
            threadId: event.payload.threadId,
            runtime,
            runtimeAgent,
            text: `MESSAGE FROM operator: ${event.payload.text}`,
            createdAt: event.occurredAt,
          }),
        { concurrency: 4 },
      );
    });

  const handleProviderEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const decoded = decodeSwarmSessionThreadId(event.threadId);
      if (!decoded) return;
      const runtimeOption = yield* ensureRuntime(decoded.threadId);
      if (Option.isNone(runtimeOption)) return;
      const runtime = runtimeOption.value;
      const runtimeAgent = runtime.agents.get(decoded.agentId);
      if (!runtimeAgent) return;

      switch (event.type) {
        case "session.state.changed": {
          runtimeAgent.status = mapSessionStatusForAgent(
            runtimeAgent,
            mapRuntimeStatus(event.payload.state),
          );
          const lastError =
            typeof event.payload.detail === "string" ? event.payload.detail : event.payload.reason;
          yield* dispatchStatus({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            status: runtimeAgent.status,
            createdAt: event.createdAt,
            lastError: lastError ?? null,
          });
          yield* sendNextPendingTurn({
            threadId: decoded.threadId,
            runtime,
            runtimeAgent,
          });
          break;
        }
        case "content.delta": {
          if (event.payload.streamKind === "assistant_text") {
            const delta = resolveStreamingDelta(runtimeAgent.buffer, event.payload.delta);
            runtimeAgent.buffer += delta;
            if (delta.length > 0) {
              runtimeAgent.activeTranscriptMessageId ??= serverMessageId(
                "transcript",
                yield* randomUUID,
              );
              yield* dispatchMessage({
                threadId: decoded.threadId,
                messageId: runtimeAgent.activeTranscriptMessageId,
                senderAgentId: decoded.agentId,
                targetAgentId: null,
                text: delta,
                streaming: true,
                createdAt: event.createdAt,
              });
              yield* routeStreamingAgentDirectives({
                threadId: decoded.threadId,
                runtime,
                senderAgentId: decoded.agentId,
                runtimeAgent,
                text: runtimeAgent.buffer,
                createdAt: event.createdAt,
              });
            }
          } else if (
            event.payload.streamKind === "reasoning_text" ||
            event.payload.streamKind === "reasoning_summary_text" ||
            event.payload.streamKind === "plan_text"
          ) {
            yield* appendReasoningActivity({
              threadId: decoded.threadId,
              agentId: decoded.agentId,
              runtimeAgent,
              delta: event.payload.delta,
              createdAt: event.createdAt,
            });
          } else if (
            event.payload.streamKind === "command_output" ||
            event.payload.streamKind === "file_change_output"
          ) {
            yield* appendToolActivity({
              threadId: decoded.threadId,
              agentId: decoded.agentId,
              runtimeAgent,
              delta: event.payload.delta,
              createdAt: event.createdAt,
            });
          }
          break;
        }
        case "item.completed": {
          if (
            event.payload.itemType === "assistant_message" &&
            event.payload.detail &&
            runtimeAgent.buffer.trim().length === 0
          ) {
            runtimeAgent.buffer = event.payload.detail;
          }
          break;
        }
        case "turn.started": {
          runtimeAgent.status = "running";
          runtimeAgent.turnInFlight = true;
          runtimeAgent.activeProviderTurnId = event.turnId ?? null;
          runtimeAgent.preemptionRequested = false;
          runtimeAgent.buffer = "";
          runtimeAgent.activeTranscriptMessageId = null;
          runtimeAgent.reasoningBuffer = "";
          runtimeAgent.activeReasoningMessageId = null;
          runtimeAgent.toolBuffer = "";
          runtimeAgent.activeToolMessageId = null;
          runtimeAgent.routedDirectiveKeys.clear();
          runtimeAgent.routedDirectiveMessageIds.clear();
          yield* dispatchStatus({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            status: "running",
            createdAt: event.createdAt,
          });
          yield* appendReasoningActivity({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            runtimeAgent,
            delta: "Turn started. Waiting for provider output...\n",
            createdAt: event.createdAt,
          });
          break;
        }
        case "turn.completed": {
          const preemptionKey = preemptionKeyForProviderEvent(
            runtimeAgent,
            event,
            event.payload.state === "failed" && isAbortLikeText(event.payload.errorMessage),
          );
          if (preemptionKey) {
            yield* handleExpectedPreemptionSignal({
              threadId: decoded.threadId,
              runtime,
              runtimeAgent,
              preemptionKey,
              createdAt: event.createdAt,
            });
            break;
          }

          runtimeAgent.turnInFlight = false;
          runtimeAgent.activeProviderTurnId = null;
          runtimeAgent.preemptionRequested = false;
          runtimeAgent.status = event.payload.state === "failed" ? "error" : "ready";
          yield* dispatchStatus({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            status: runtimeAgent.status,
            createdAt: event.createdAt,
            lastError: event.payload.errorMessage ?? null,
          });
          const text = runtimeAgent.buffer.trim();
          const transcriptMessageId = runtimeAgent.activeTranscriptMessageId;
          runtimeAgent.buffer = "";
          runtimeAgent.activeTranscriptMessageId = null;
          yield* finalizeActivityMessages({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            runtimeAgent,
            createdAt: event.createdAt,
          });
          if (text.length > 0) {
            yield* routeAgentText({
              threadId: decoded.threadId,
              runtime,
              senderAgentId: decoded.agentId,
              runtimeAgent,
              transcriptMessageId,
              text,
              createdAt: event.createdAt,
            });
          } else if (event.payload.state === "failed") {
            yield* dispatchMessage({
              threadId: decoded.threadId,
              senderAgentId: null,
              targetAgentId: SWARM_OPERATOR_TARGET_ID,
              text: `${runtimeAgent.agent.name} failed: ${event.payload.errorMessage ?? "Provider turn failed."}`,
              createdAt: event.createdAt,
            });
          }
          yield* sendNextPendingTurn({
            threadId: decoded.threadId,
            runtime,
            runtimeAgent,
          });
          break;
        }
        case "turn.aborted": {
          const preemptionKey = preemptionKeyForProviderEvent(runtimeAgent, event, true);
          if (preemptionKey) {
            yield* handleExpectedPreemptionSignal({
              threadId: decoded.threadId,
              runtime,
              runtimeAgent,
              preemptionKey,
              createdAt: event.createdAt,
            });
            break;
          }

          runtimeAgent.turnInFlight = false;
          runtimeAgent.activeProviderTurnId = null;
          runtimeAgent.preemptionRequested = false;
          runtimeAgent.status = "ready";
          yield* finalizeActivityMessages({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            runtimeAgent,
            createdAt: event.createdAt,
          });
          yield* dispatchStatus({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            status: "ready",
            createdAt: event.createdAt,
          });
          yield* sendNextPendingTurn({
            threadId: decoded.threadId,
            runtime,
            runtimeAgent,
          });
          break;
        }
        case "session.exited": {
          runtimeAgent.turnInFlight = false;
          runtimeAgent.activeProviderTurnId = null;
          runtimeAgent.preemptionRequested = false;
          runtimeAgent.status = "stopped";
          yield* finalizeActivityMessages({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            runtimeAgent,
            createdAt: event.createdAt,
          });
          yield* dispatchStatus({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            status: "stopped",
            createdAt: event.createdAt,
          });
          break;
        }
        case "thread.state.changed": {
          if (event.payload.state === "error") {
            const detail =
              typeof event.payload.detail === "string" ? event.payload.detail : "Thread errored.";
            const preemptionKey = preemptionKeyForProviderEvent(
              runtimeAgent,
              event,
              isAbortLikeText(detail),
            );
            if (preemptionKey) {
              yield* handleExpectedPreemptionSignal({
                threadId: decoded.threadId,
                runtime,
                runtimeAgent,
                preemptionKey,
                createdAt: event.createdAt,
              });
              break;
            }

            runtimeAgent.status = "error";
            runtimeAgent.turnInFlight = false;
            runtimeAgent.activeProviderTurnId = null;
            runtimeAgent.preemptionRequested = false;
            yield* finalizeActivityMessages({
              threadId: decoded.threadId,
              agentId: decoded.agentId,
              runtimeAgent,
              createdAt: event.createdAt,
            });
            yield* dispatchStatus({
              threadId: decoded.threadId,
              agentId: decoded.agentId,
              status: "error",
              createdAt: event.createdAt,
              lastError: detail,
            });
            yield* dispatchMessage({
              threadId: decoded.threadId,
              senderAgentId: null,
              targetAgentId: SWARM_OPERATOR_TARGET_ID,
              text: `${runtimeAgent.agent.name} thread error: ${detail}`,
              createdAt: event.createdAt,
            });
          }
          break;
        }
        case "runtime.error": {
          const preemptionKey = preemptionKeyForProviderEvent(
            runtimeAgent,
            event,
            isAbortLikeText(event.payload.message),
          );
          if (preemptionKey) {
            yield* handleExpectedPreemptionSignal({
              threadId: decoded.threadId,
              runtime,
              runtimeAgent,
              preemptionKey,
              createdAt: event.createdAt,
            });
            break;
          }

          runtimeAgent.status = "error";
          runtimeAgent.turnInFlight = false;
          runtimeAgent.activeProviderTurnId = null;
          runtimeAgent.preemptionRequested = false;
          yield* finalizeActivityMessages({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            runtimeAgent,
            createdAt: event.createdAt,
          });
          yield* dispatchStatus({
            threadId: decoded.threadId,
            agentId: decoded.agentId,
            status: "error",
            createdAt: event.createdAt,
            lastError: event.payload.message,
          });
          yield* dispatchMessage({
            threadId: decoded.threadId,
            senderAgentId: null,
            targetAgentId: SWARM_OPERATOR_TARGET_ID,
            text: `${runtimeAgent.agent.name} runtime error: ${event.payload.message}`,
            createdAt: event.createdAt,
          });
          break;
        }
        default:
          break;
      }
    });

  const handleDomainEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "swarm.created":
        return ensureRuntime(event.payload.threadId).pipe(Effect.asVoid);
      case "swarm.started":
        return startSwarm(event.payload.threadId, event.payload.startedAt);
      case "swarm.agent.message":
        return handleOperatorMessage(event);
      case "swarm.agent.stop-requested":
        return ensureRuntime(event.payload.threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (runtime) => {
                const agent = runtime.agents.get(event.payload.agentId);
                return agent
                  ? providerService.stopSession({ threadId: agent.providerThreadId }).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          agent.status = "stopped";
                        }),
                      ),
                    )
                  : Effect.void;
              },
            }),
          ),
        );
      case "thread.deleted":
        swarms.delete(String(event.payload.threadId));
        return Effect.void;
      default:
        return Effect.void;
    }
  };

  const processSafely = (input: RuntimeInput) =>
    (input.source === "domain"
      ? handleDomainEvent(input.event)
      : handleProviderEvent(input.event)
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.warn("swarm coordinator failed", {
            source: input.source,
            cause: formatCause(cause),
          });
        }),
      ),
      Effect.asVoid,
    );

  const hydrate = Effect.gen(function* () {
    const readModel = yield* projectionSnapshotQuery.getSnapshot().pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.warn("failed to load swarm runtime snapshot", formatCause(cause));
          return null as const;
        }),
      ),
    );
    if (readModel === null) {
      return;
    }
    const activeSessions = yield* providerService.listSessions();
    const now = yield* nowIso;
    yield* Effect.forEach(
      readModel.threads.filter((thread) => thread.swarm),
      (thread) =>
        ensureRuntime(thread.id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (runtime) =>
                Effect.forEach(
                  runtime.agents.values(),
                  (runtimeAgent) => {
                    const session = activeSessions.find(
                      (entry) => entry.threadId === runtimeAgent.providerThreadId,
                    );
                    runtimeAgent.status = session ? mapRuntimeStatus(session.status) : "idle";
                    return dispatchStatus({
                      threadId: thread.id,
                      agentId: runtimeAgent.agent.id,
                      status: runtimeAgent.status,
                      createdAt: session?.updatedAt ?? now,
                      lastError: session?.lastError ?? null,
                    });
                  },
                  { concurrency: 4 },
                ),
            }),
          ),
        ),
      { concurrency: 1 },
    );
  });

  const start: SwarmCoordinatorShape["start"] = Effect.gen(function* () {
    yield* hydrate;
    const queue = yield* Queue.unbounded<RuntimeInput>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processSafely))));

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
    startThreadSwarm: startSwarm,
  } satisfies SwarmCoordinatorShape;
});

export const SwarmCoordinatorLive = Layer.effect(SwarmCoordinator, makeSwarmCoordinator);
