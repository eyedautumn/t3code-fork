// @ts-nocheck
// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSession,
  type ProviderRuntimeEvent,
  ProjectId,
  SWARM_OPERATOR_TARGET_ID,
  type SwarmAgentRole,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  PubSub,
  Scope,
  Stream,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { SwarmCoordinator } from "../Services/SwarmCoordinator.ts";
import { SwarmCoordinatorLive } from "./SwarmCoordinator.ts";
import { encodeSwarmSessionThreadId } from "../SwarmSessionCodec.ts";

const OPENCODE = ProviderDriverKind.make("opencode");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const THREAD_ID = ThreadId.make("thread-opencode-swarm");
const PROJECT_ID = ProjectId.make("project-opencode-swarm");

function makeIsoNow(): string {
  return Effect.runSync(Effect.map(DateTime.now, DateTime.formatIso));
}

type TestSwarmAgent = {
  readonly id: string;
  readonly name: string;
  readonly role: SwarmAgentRole;
};

function makeReadModel(
  workspaceRoot: string,
  agents: ReadonlyArray<TestSwarmAgent> = [
    {
      id: "builder",
      name: "Builder",
      role: "builder",
    },
  ],
): OrchestrationReadModel {
  const now = makeIsoNow();
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: PROJECT_ID,
        title: "Swarm Project",
        workspaceRoot,
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Swarm Thread",
        modelSelection: createModelSelection(OPENCODE_INSTANCE_ID, "opencode/gpt-5.1", []),
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        swarm: {
          config: {
            name: "Swarm",
            mission: "Coordinate the work.",
            agents: agents.map((agent) => ({
              id: agent.id,
              name: agent.name,
              role: agent.role,
              provider: OPENCODE,
              providerInstanceId: OPENCODE_INSTANCE_ID,
              model: "opencode/gpt-5.1",
              runtimeMode: "full-access",
              interactionMode: "default",
            })),
            contextFiles: [],
          },
          agents: agents.map((agent) => ({
            agentId: agent.id,
            status: "idle",
            updatedAt: now,
            lastError: null,
          })),
          messages: [],
          tasks: [],
        },
      },
    ],
  };
}

function makeSwarmReadModelWithAgents(
  workspaceRoot: string,
  agents: ReadonlyArray<TestSwarmAgent>,
): OrchestrationReadModel {
  return makeReadModel(workspaceRoot, agents);
}

function makeProviderServiceHarness(input?: {
  readonly onInterrupt?: (eventPubSub: PubSub.PubSub<ProviderRuntimeEvent>) => Effect.Effect<void>;
}) {
  const providerEvents = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const sendTurnCalls: Array<{ threadId: string; input: string | undefined }> = [];
  const interruptTurnCalls: Array<{ threadId: string; turnId: string | undefined }> = [];

  let providerThreadId = encodeSwarmSessionThreadId(THREAD_ID, "builder");

  const service: ProviderServiceShape = {
    startSession: (threadId, sessionInput) =>
      Effect.sync(() => {
        providerThreadId = threadId;
        return {
          provider: OPENCODE,
          providerInstanceId: sessionInput.providerInstanceId ?? OPENCODE_INSTANCE_ID,
          status: "ready",
          runtimeMode: sessionInput.runtimeMode,
          ...(sessionInput.cwd ? { cwd: sessionInput.cwd } : {}),
          threadId,
          createdAt: makeIsoNow(),
          updatedAt: makeIsoNow(),
          ...(sessionInput.modelSelection?.model
            ? { model: sessionInput.modelSelection.model }
            : {}),
          ...(sessionInput.resumeCursor !== undefined
            ? { resumeCursor: sessionInput.resumeCursor }
            : {}),
        } satisfies ProviderSession;
      }),
    sendTurn: (turnInput) =>
      Effect.sync(() => {
        sendTurnCalls.push({
          threadId: turnInput.threadId,
          input: turnInput.input,
        });
        return {
          threadId: turnInput.threadId,
          turnId: TurnId.make(`${turnInput.threadId}:turn-${sendTurnCalls.length}`),
        };
      }),
    interruptTurn: (turnInput) =>
      Effect.gen(function* () {
        interruptTurnCalls.push({
          threadId: turnInput.threadId,
          turnId: turnInput.turnId,
        });
        if (input?.onInterrupt) {
          yield* input.onInterrupt(providerEvents);
        }
      }),
    respondToRequest: () => Effect.die(new Error("unexpected call")),
    respondToUserInput: () => Effect.die(new Error("unexpected call")),
    stopSession: () => Effect.die(new Error("unexpected call")),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: () =>
      Effect.succeed({
        instanceId: OPENCODE_INSTANCE_ID,
        driverKind: OPENCODE,
        displayName: "OpenCode",
        enabled: true,
        continuationIdentity: {
          driverKind: OPENCODE,
          continuationKey: `${OPENCODE}:instance:${OPENCODE_INSTANCE_ID}`,
        },
      }),
    rollbackConversation: () => Effect.die(new Error("unexpected call")),
    streamEvents: Stream.fromPubSub(providerEvents),
  };

  return {
    service,
    providerEvents,
    sendTurnCalls,
    interruptTurnCalls,
    get providerThreadId() {
      return providerThreadId;
    },
  };
}

function makeOrchestrationEngineHarness(input: {
  readonly workspaceRoot: string;
  readonly agents?: ReadonlyArray<TestSwarmAgent>;
}) {
  const orchestrationEvents = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  const dispatchedCommands: OrchestrationCommand[] = [];
  const orchestrationEngine: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    dispatch: (command) => {
      dispatchedCommands.push(command);
      return Effect.succeed({ sequence: dispatchedCommands.length });
    },
    streamDomainEvents: Stream.fromPubSub(orchestrationEvents),
  };
  const projectionSnapshotQuery: ProjectionSnapshotQueryShape = {
    getCommandReadModel: () =>
      Effect.succeed(
        input.agents
          ? makeSwarmReadModelWithAgents(input.workspaceRoot, input.agents)
          : makeReadModel(input.workspaceRoot),
      ),
    getSnapshot: () =>
      Effect.succeed(
        input.agents
          ? makeSwarmReadModelWithAgents(input.workspaceRoot, input.agents)
          : makeReadModel(input.workspaceRoot),
      ),
    getShellSnapshot: () => Effect.die(new Error("unexpected call")),
    getArchivedShellSnapshot: () => Effect.die(new Error("unexpected call")),
    getSnapshotSequence: () => Effect.die(new Error("unexpected call")),
    getCounts: () => Effect.die(new Error("unexpected call")),
    getActiveProjectByWorkspaceRoot: () => Effect.die(new Error("unexpected call")),
    getProjectShellById: () => Effect.die(new Error("unexpected call")),
    getFirstActiveThreadIdByProjectId: () => Effect.die(new Error("unexpected call")),
    getThreadCheckpointContext: () => Effect.die(new Error("unexpected call")),
    getFullThreadDiffContext: () => Effect.die(new Error("unexpected call")),
    getThreadShellById: () => Effect.die(new Error("unexpected call")),
    getThreadDetailById: () => Effect.die(new Error("unexpected call")),
  };

  return {
    orchestrationEngine,
    projectionSnapshotQuery,
    orchestrationEvents,
    dispatchedCommands,
  };
}

async function startCoordinatorHarness(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerService: ProviderServiceShape;
}) {
  const runtime = ManagedRuntime.make(
    SwarmCoordinatorLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, input.orchestrationEngine)),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, input.projectionSnapshotQuery)),
      Layer.provideMerge(Layer.succeed(ProviderService, input.providerService)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
  const scope: Scope.Closeable = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(coordinator.start.pipe(Effect.provideService(Scope.Scope, scope)));
  await Effect.runPromise(Effect.sleep(Duration.millis(1)));

  return {
    runtime,
    coordinator,
    scope,
  };
}

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Effect.runSync(Clock.currentTimeMillis) + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Effect.runSync(Clock.currentTimeMillis) >= deadline) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      void Effect.runPromise(Effect.sleep(Duration.millis(10))).then(tick);
    };
    tick();
  });
}

describe("SwarmCoordinator", () => {
  let runtime: ManagedRuntime.ManagedRuntime<any, any> | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interrupts a running opencode turn before dispatching a new steering message", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-swarm-coordinator-"));
    tempDirs.push(workspaceRoot);

    const orchestrationEvents = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
    const providerEvents = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

    const sendTurnCalls: Array<{ threadId: string; input: string | undefined }> = [];
    const interruptTurnCalls: Array<{ threadId: string; turnId: string | undefined }> = [];
    const dispatchedCommands: Array<string> = [];

    let providerThreadId = encodeSwarmSessionThreadId(THREAD_ID, "builder");

    const orchestrationEngine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(makeReadModel(workspaceRoot)),
      readEvents: () => Stream.empty,
      dispatch: (command) => {
        dispatchedCommands.push(command.type);
        return Effect.succeed({ sequence: dispatchedCommands.length });
      },
      streamDomainEvents: Stream.fromPubSub(orchestrationEvents),
    };

    const providerService: ProviderServiceShape = {
      startSession: (threadId, input) =>
        Effect.sync(() => {
          providerThreadId = threadId;
          return {
            provider: OPENCODE,
            providerInstanceId: input.providerInstanceId ?? OPENCODE_INSTANCE_ID,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            threadId,
            createdAt: makeIsoNow(),
            updatedAt: makeIsoNow(),
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          } satisfies ProviderSession;
        }),
      sendTurn: (input) =>
        Effect.sync(() => {
          sendTurnCalls.push({
            threadId: input.threadId,
            input: input.input,
          });
          return {
            threadId: input.threadId,
            turnId: TurnId.make(`${input.threadId}:turn-${sendTurnCalls.length}`),
          };
        }),
      interruptTurn: (input) =>
        Effect.gen(function* () {
          interruptTurnCalls.push({
            threadId: input.threadId,
            turnId: input.turnId,
          });
          yield* PubSub.publish(providerEvents, {
            eventId: EventId.make(`evt-aborted-${interruptTurnCalls.length}`),
            provider: OPENCODE,
            threadId: providerThreadId,
            createdAt: makeIsoNow(),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by steering message.",
            },
          });
        }),
      respondToRequest: () => Effect.die(new Error("unexpected call")),
      respondToUserInput: () => Effect.die(new Error("unexpected call")),
      stopSession: () => Effect.die(new Error("unexpected call")),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: () =>
        Effect.succeed({
          instanceId: OPENCODE_INSTANCE_ID,
          driverKind: OPENCODE,
          displayName: "OpenCode",
          enabled: true,
          continuationIdentity: {
            driverKind: OPENCODE,
            continuationKey: `${OPENCODE}:instance:${OPENCODE_INSTANCE_ID}`,
          },
        }),
      rollbackConversation: () => Effect.die(new Error("unexpected call")),
      streamEvents: Stream.fromPubSub(providerEvents),
    };

    runtime = ManagedRuntime.make(
      SwarmCoordinatorLive.pipe(
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
        Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(NodeServices.layer),
      ),
    );

    const runtimeInstance = runtime;
    if (!runtimeInstance) {
      throw new Error("Runtime was not initialized.");
    }
    const coordinator = await runtimeInstance.runPromise(Effect.service(SwarmCoordinator));
    const currentScope: Scope.Closeable = await Effect.runPromise(Scope.make("sequential"));
    scope = currentScope;
    await Effect.runPromise(
      coordinator.start.pipe(Effect.provideService(Scope.Scope, currentScope)),
    );

    await Effect.runPromise(
      coordinator
        .startThreadSwarm(THREAD_ID, makeIsoNow())
        .pipe(Effect.provideService(Scope.Scope, currentScope)),
    );

    await waitFor(() => sendTurnCalls.length === 1);
    expect(interruptTurnCalls).toEqual([]);

    const steeringEvent = {
      eventId: EventId.make("evt-steering-message"),
      sequence: 1,
      aggregateKind: "thread" as const,
      aggregateId: THREAD_ID,
      occurredAt: makeIsoNow(),
      commandId: CommandId.make("cmd-steering-message"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "swarm.agent.message" as const,
      payload: {
        threadId: THREAD_ID,
        messageId: MessageId.make("msg-steering-message"),
        sender: "operator" as const,
        senderAgentId: null,
        targetAgentId: "builder",
        text: "Switch to the new plan.",
        streaming: false,
        createdAt: makeIsoNow(),
      },
    };

    Effect.runSync(PubSub.publish(orchestrationEvents, steeringEvent));

    await waitFor(() => interruptTurnCalls.length === 1);
    await waitFor(() => sendTurnCalls.length === 2);

    assert.equal(interruptTurnCalls[0]?.threadId, providerThreadId);
    assert.equal(sendTurnCalls[1]?.input, "MESSAGE FROM operator: Switch to the new plan.");
  });

  it("routes coordinator swarm messages while opencode output is still streaming", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-swarm-coordinator-"));
    tempDirs.push(workspaceRoot);

    const orchestration = makeOrchestrationEngineHarness({
      workspaceRoot,
      agents: [
        {
          id: "coordinator",
          name: "Coordinator",
          role: "coordinator",
        },
        {
          id: "review-reviewer-1",
          name: "Reviewer",
          role: "scout",
        },
        {
          id: "review-scout-2",
          name: "Scout",
          role: "scout",
        },
      ],
    });
    const provider = makeProviderServiceHarness();
    const started = await startCoordinatorHarness({
      orchestrationEngine: orchestration.orchestrationEngine,
      projectionSnapshotQuery: orchestration.projectionSnapshotQuery,
      providerService: provider.service,
    });
    runtime = started.runtime;
    scope = started.scope;

    Effect.runSync(
      PubSub.publish(provider.providerEvents, {
        eventId: EventId.make("evt-coordinator-streaming-directives"),
        provider: OPENCODE,
        threadId: encodeSwarmSessionThreadId(THREAD_ID, "coordinator"),
        createdAt: makeIsoNow(),
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta:
            "[swarm.message review-reviewer-1] MESSAGE FROM coordinator: Scout 1, explore ServerScriptService.\n\n" +
            "[swarm.message review-scout-2] MESSAGE FROM coordinator: Scout 2, explore ReplicatedStorage.\n\n" +
            "Meanwhile I'll explore ServerStorage and StarterGui myself.",
        },
      }),
    );

    await waitFor(() => provider.sendTurnCalls.length === 2);

    expect(provider.sendTurnCalls).toEqual([
      {
        threadId: encodeSwarmSessionThreadId(THREAD_ID, "review-reviewer-1"),
        input: "MESSAGE FROM coordinator: Scout 1, explore ServerScriptService.",
      },
      {
        threadId: encodeSwarmSessionThreadId(THREAD_ID, "review-scout-2"),
        input: "MESSAGE FROM coordinator: Scout 2, explore ReplicatedStorage.",
      },
    ]);
  });

  it("normalizes cumulative assistant snapshots before routing swarm directives", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-swarm-coordinator-"));
    tempDirs.push(workspaceRoot);

    const orchestration = makeOrchestrationEngineHarness({
      workspaceRoot,
      agents: [
        {
          id: "coordinator",
          name: "Coordinator",
          role: "coordinator",
        },
        {
          id: "squad-builder-3",
          name: "Builder",
          role: "builder",
        },
      ],
    });
    const provider = makeProviderServiceHarness();
    const started = await startCoordinatorHarness({
      orchestrationEngine: orchestration.orchestrationEngine,
      projectionSnapshotQuery: orchestration.projectionSnapshotQuery,
      providerService: provider.service,
    });
    runtime = started.runtime;
    scope = started.scope;

    const providerThreadId = encodeSwarmSessionThreadId(THREAD_ID, "squad-builder-3");
    const fullText =
      "[swarm.message coordinator] MESSAGE FROM squad-builder-3: CosmeticObjectService is close, but I would not mark the plan fully approval-ready yet.";
    const snapshots = [
      "[swarm.message coordinator] MESSAGE",
      "[swarm.message coordinator] MESSAGE FROM",
      "[swarm.message coordinator] MESSAGE FROM squad",
      "[swarm.message coordinator] MESSAGE FROM squad-builder-3:",
      fullText,
    ];

    for (const [index, delta] of snapshots.entries()) {
      Effect.runSync(
        PubSub.publish(provider.providerEvents, {
          eventId: EventId.make(`evt-cumulative-snapshot-${index}`),
          provider: OPENCODE,
          threadId: providerThreadId,
          createdAt: makeIsoNow(),
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta,
          },
        }),
      );
    }
    Effect.runSync(
      PubSub.publish(provider.providerEvents, {
        eventId: EventId.make("evt-cumulative-completed"),
        provider: OPENCODE,
        threadId: providerThreadId,
        createdAt: makeIsoNow(),
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      }),
    );

    await waitFor(() =>
      orchestration.dispatchedCommands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "squad-builder-3" &&
          command.targetAgentId === "coordinator",
      ),
    );

    const routedCommands = orchestration.dispatchedCommands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "swarm.agent.message.append" }> =>
        command.type === "swarm.agent.message.append" &&
        command.senderAgentId === "squad-builder-3" &&
        command.targetAgentId === "coordinator",
    );

    expect(routedCommands.map((command) => command.text)).toEqual([
      "MESSAGE FROM squad-builder-3: CosmeticObjectService is close, but I would not mark the plan fully approval-ready yet.",
    ]);
    expect(provider.sendTurnCalls).toEqual([
      {
        threadId: encodeSwarmSessionThreadId(THREAD_ID, "coordinator"),
        input:
          "MESSAGE FROM squad-builder-3: CosmeticObjectService is close, but I would not mark the plan fully approval-ready yet.",
      },
    ]);
  });

  it("suppresses expected opencode abort errors and restarts the queued steering turn", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-swarm-coordinator-"));
    tempDirs.push(workspaceRoot);

    const builderThreadId = encodeSwarmSessionThreadId(THREAD_ID, "builder");
    const interruptedTurnId = TurnId.make("builder-turn-before-steering");
    const orchestration = makeOrchestrationEngineHarness({ workspaceRoot });
    const provider = makeProviderServiceHarness({
      onInterrupt: (providerEvents) =>
        PubSub.publish(providerEvents, {
          eventId: EventId.make("evt-builder-turn-aborted"),
          provider: OPENCODE,
          threadId: builderThreadId,
          turnId: interruptedTurnId,
          createdAt: makeIsoNow(),
          type: "turn.aborted",
          payload: {
            reason: "Interrupted by steering message.",
          },
        }),
    });
    const started = await startCoordinatorHarness({
      orchestrationEngine: orchestration.orchestrationEngine,
      projectionSnapshotQuery: orchestration.projectionSnapshotQuery,
      providerService: provider.service,
    });
    runtime = started.runtime;
    scope = started.scope;

    await started.runtime.runPromise(
      started.coordinator
        .startThreadSwarm(THREAD_ID, makeIsoNow())
        .pipe(Effect.provideService(Scope.Scope, started.scope)),
    );
    await waitFor(() => provider.sendTurnCalls.length === 1);

    const turnStartedAt = makeIsoNow();
    Effect.runSync(
      PubSub.publish(provider.providerEvents, {
        eventId: EventId.make("evt-builder-turn-started"),
        provider: OPENCODE,
        threadId: builderThreadId,
        turnId: interruptedTurnId,
        createdAt: turnStartedAt,
        type: "turn.started",
        payload: {
          model: "opencode/gpt-5.1",
        },
      }),
    );
    await waitFor(() =>
      orchestration.dispatchedCommands.some(
        (command) =>
          command.type === "swarm.agent.status.set" &&
          command.agentId === "builder" &&
          command.status === "running" &&
          command.createdAt === turnStartedAt,
      ),
    );

    Effect.runSync(
      PubSub.publish(orchestration.orchestrationEvents, {
        eventId: EventId.make("evt-operator-steering"),
        sequence: 1,
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: makeIsoNow(),
        commandId: CommandId.make("cmd-operator-steering"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "swarm.agent.message",
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.make("msg-operator-steering"),
          sender: "operator",
          senderAgentId: null,
          targetAgentId: "builder",
          text: "Use the new context now.",
          streaming: false,
          createdAt: makeIsoNow(),
        },
      }),
    );

    await waitFor(() => provider.interruptTurnCalls.length === 1);
    await waitFor(() => provider.sendTurnCalls.length === 2);

    Effect.runSync(
      PubSub.publish(provider.providerEvents, {
        eventId: EventId.make("evt-builder-turn-completed-aborted"),
        provider: OPENCODE,
        threadId: builderThreadId,
        turnId: interruptedTurnId,
        createdAt: makeIsoNow(),
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: "Aborted",
        },
      }),
    );
    Effect.runSync(
      PubSub.publish(provider.providerEvents, {
        eventId: EventId.make("evt-builder-runtime-error-aborted"),
        provider: OPENCODE,
        threadId: builderThreadId,
        turnId: interruptedTurnId,
        createdAt: makeIsoNow(),
        type: "runtime.error",
        payload: {
          message: "Aborted",
          class: "provider_error",
        },
      }),
    );
    await Effect.runPromise(Effect.sleep(Duration.millis(20)));

    expect(provider.sendTurnCalls[1]).toEqual({
      threadId: builderThreadId,
      input: "MESSAGE FROM operator: Use the new context now.",
    });
    expect(
      orchestration.dispatchedCommands.some(
        (command) =>
          command.type === "swarm.agent.status.set" &&
          command.agentId === "builder" &&
          command.status === "error",
      ),
    ).toBe(false);
    expect(
      orchestration.dispatchedCommands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.targetAgentId === SWARM_OPERATOR_TARGET_ID &&
          command.text.includes("runtime error: Aborted"),
      ),
    ).toBe(false);
  });
});
