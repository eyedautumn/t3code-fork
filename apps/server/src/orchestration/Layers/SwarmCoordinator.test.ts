import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProviderRuntimeEvent,
  ProviderSession,
  SwarmState,
  ThreadId,
} from "@t3tools/contracts";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  SWARM_OPERATOR_TARGET_ID,
  ThreadId as ThreadIdType,
  TurnId,
} from "@t3tools/contracts";

import { OrchestrationEngineService, type OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { ProviderService, type ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { SwarmCoordinator } from "../Services/SwarmCoordinator.ts";
import { SwarmCoordinatorLive } from "./SwarmCoordinator.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { encodeSwarmSessionThreadId } from "../SwarmSessionCodec.ts";

const asThreadId = (value: string): ThreadId => ThreadIdType.makeUnsafe(value);
const asProjectId = (value: string) => ProjectId.makeUnsafe(value);
const asEventId = (value: string) => EventId.makeUnsafe(value);
const asMessageId = (value: string) => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function buildReadModel(swarm: SwarmState): OrchestrationReadModel {
  const now = new Date().toISOString();
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: asProjectId("project-1"),
        title: "Project",
        workspaceRoot: "/tmp",
        defaultModel: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: asThreadId("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Swarm thread",
        model: "codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        swarm,
      },
    ],
  } as OrchestrationReadModel;
}

function createSwarm(): SwarmState {
  return {
    config: {
      name: "Demo Swarm",
      mission: "Ship the feature",
      targetPath: "apps/web",
      startPrompt: "Kick off",
      agents: [
        {
          id: "coord-1",
          name: "Coordinator",
          role: "coordinator",
          provider: "codex",
          model: "claude-code",
          runtimeMode: "full-access",
          interactionMode: "default",
          serviceTier: "flex",
          modelOptions: {},
        },
        {
          id: "builder-1",
          name: "Builder",
          role: "builder",
          provider: "codex",
          model: "claude-code",
          runtimeMode: "full-access",
          interactionMode: "default",
          serviceTier: "flex",
          modelOptions: {},
        },
        {
          id: "explore-scout-2",
          name: "Scout",
          role: "scout",
          provider: "opencode",
          model: "opencode/big-pickle",
          runtimeMode: "full-access",
          interactionMode: "default",
          serviceTier: "flex",
          modelOptions: {},
        },
    ],
  },
  agents: [],
  messages: [],
  tasks: [],
} satisfies SwarmState;
}

function createHarness(swarm: SwarmState) {
  const commands: OrchestrationCommand[] = [];
  const providerStarts: ProviderSession[] = [];
  const sendTurns: Array<{ threadId: ThreadId; text?: string; developerInstructions?: string }> = [];
  const domainEvents = Effect.runSync(Queue.unbounded<OrchestrationEvent>());
  const providerEvents = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const readModel = buildReadModel(swarm);

  const orchestrationService: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(readModel),
    readEvents: () => Stream.empty,
    dispatch: (command) => {
      commands.push(command);
      return Effect.succeed({ sequence: 1 });
    },
    streamDomainEvents: Stream.fromQueue(domainEvents),
  };

  const providerService: ProviderServiceShape = {
    startSession: (_threadId, input) => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        threadId: input.threadId,
        provider: input.provider ?? "codex",
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd ?? undefined,
        createdAt: now,
        updatedAt: now,
      };
      providerStarts.push(session);
      return Effect.succeed(session);
    },
    sendTurn: (input) => {
      const record: { threadId: ThreadId; text?: string; developerInstructions?: string } = {
        threadId: input.threadId,
      };
      if (input.input !== undefined) {
        record.text = input.input;
      }
      if (input.developerInstructions !== undefined) {
        record.developerInstructions = input.developerInstructions;
      }
      sendTurns.push(record);
      return Effect.succeed({ threadId: input.threadId, turnId: asTurnId("turn") });
    },
    interruptTurn: () => Effect.die(new Error("not implemented")),
    respondToRequest: () => Effect.die(new Error("not implemented")),
    respondToUserInput: () => Effect.die(new Error("not implemented")),
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation: () => Effect.die(new Error("not implemented")),
    streamEvents: Stream.fromQueue(providerEvents),
  };

  const orchestrationLayer = Layer.succeed(OrchestrationEngineService, orchestrationService);
  const providerLayer = Layer.succeed(ProviderService, providerService);
  const serverConfigLayer = Layer.succeed(ServerConfig, {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: "/tmp",
    keybindingsConfigPath: "/tmp/keybindings.json",
    stateDir: "/tmp",
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    enableSwarmTasks: true,
  } satisfies ServerConfigShape);
  const layer = SwarmCoordinatorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(serverConfigLayer),
  );

  const emitDomain = (event: OrchestrationEvent) => Effect.runPromise(Queue.offer(domainEvents, event));
  const emitProvider = (event: ProviderRuntimeEvent) =>
    Effect.runPromise(Queue.offer(providerEvents, event));

  return {
    commands,
    providerStarts,
    sendTurns,
    emitDomain,
    emitProvider,
    layer,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("SwarmCoordinator", () => {
  const swarm = createSwarm();
  let scope: Scope.Closeable | null = null;
  let runtime: ManagedRuntime.ManagedRuntime<SwarmCoordinator, never> | null = null;

  afterEach(async () => {
    if (scope && runtime) {
      await runtime.runPromise(Scope.close(scope, Exit.void));
    }
    runtime = null;
    scope = null;
  });

  it("does not auto-start agent sessions on coordinator startup", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.providerStarts).toHaveLength(0);
    expect(
      harness.commands.filter((command) => command.type === "swarm.agent.status.set").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("starts agent sessions on swarm.started and emits status + prompt", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedEvent: OrchestrationEvent = {
      eventId: asEventId("evt-1"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
      },
      occurredAt: new Date().toISOString(),
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-1"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };

    await harness.emitDomain(startedEvent);

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);
    expect(harness.commands.some((c) => c.type === "swarm.agent.status.set")).toBe(true);
    expect(harness.commands.some((c) => c.type === "swarm.agent.message.append")).toBe(true);
  });

  it("routes operator messages to targeted agent sessions", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const opEvent: OrchestrationEvent = {
      eventId: asEventId("evt-2"),
      type: "swarm.agent.message",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        messageId: asMessageId("msg-1"),
        sender: "operator",
        senderAgentId: null,
        targetAgentId: "builder-1",
        text: "build please",
        streaming: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      occurredAt: new Date().toISOString(),
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-2"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };

    await harness.emitDomain(opEvent);

    await waitFor(() =>
      harness.sendTurns.some((turn) => turn.text?.includes("build please")),
    );
    const operatorTurn = harness.sendTurns.find((turn) =>
      turn.text?.includes("build please"),
    );
    expect(operatorTurn?.threadId).toBeDefined();
    expect(operatorTurn?.text).toContain("build please");
  });

  it("seeds bridge-style task commands when feature flag enabled", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedEvent: OrchestrationEvent = {
      eventId: asEventId("evt-3"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
      },
      occurredAt: new Date().toISOString(),
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-bridge"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };

    await harness.emitDomain(startedEvent);

    await waitFor(() =>
      harness.commands.some((command) => command.type === "swarm.task.created"),
    );
  });

  it("routes final swarm.message directives from streamed agent output to the closest swarm target", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    const createdAt = new Date().toISOString();
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-agent-delta"),
      provider: "opencode",
      createdAt,
      threadId: builderThreadId,
      turnId: asTurnId("turn-agent-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "[swarm.message swarm-scout-5] Scout the codebase for swarm-related bugs and report back.",
      },
    });
    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-agent-complete"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-agent-1"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    await waitFor(() =>
      harness.sendTurns.some(
        (turn) =>
          turn.threadId === encodeSwarmSessionThreadId(asThreadId("thread-1"), "explore-scout-2") &&
          turn.text?.includes("Scout the codebase for swarm-related bugs"),
      ),
    );

    expect(
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "explore-scout-2" &&
          command.text.includes("Scout the codebase for swarm-related bugs"),
      ),
    ).toBe(true);
  });

  it("routes swarm.message directives even when a message_close marker is present later in the same response", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-close"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-close"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-agent-delta-close"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-agent-close"),
      payload: {
        streamKind: "assistant_text",
        delta:
          "[swarm.message explore-coordinator-1] Scout task complete. Found and fixed bug. [swarm.message_close]",
      },
    });
    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-agent-complete-close"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-agent-close"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    await waitFor(() =>
      harness.sendTurns.some(
        (turn) =>
          turn.threadId === encodeSwarmSessionThreadId(asThreadId("thread-1"), "coord-1") &&
          turn.text?.includes("Scout task complete. Found and fixed bug."),
      ),
    );

    expect(
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "coord-1" &&
          command.text === "Scout task complete. Found and fixed bug.",
      ),
    ).toBe(true);
  });

  it("routes close-marked plain replies to the active interlocutor when no explicit swarm.message target is provided", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-implicit-close"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-implicit-close"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const operatorToBuilderEvent: OrchestrationEvent = {
      eventId: asEventId("evt-operator-builder"),
      type: "swarm.agent.message",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        messageId: asMessageId("msg-operator-builder"),
        sender: "operator",
        senderAgentId: null,
        targetAgentId: "builder-1",
        text: "Please report your completion status.",
        streaming: false,
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-operator-builder"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };
    await harness.emitDomain(operatorToBuilderEvent);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    const completedAt = new Date().toISOString();
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-builder-implicit-close-delta"),
      provider: "opencode",
      createdAt: completedAt,
      threadId: builderThreadId,
      turnId: asTurnId("turn-builder-implicit-close"),
      payload: {
        streamKind: "assistant_text",
        delta:
          "Task already complete. The swarm bug was fixed - ensureRuntimeFromReadModel now calls broadcastStartPrompt when recovering swarms. [swarm.message_close]",
      },
    });
    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-builder-implicit-close-complete"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-builder-implicit-close"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    await waitFor(() =>
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === SWARM_OPERATOR_TARGET_ID &&
          command.text.includes("Task already complete."),
      ),
    );
  });

  it("includes the exact swarm roster in developer instructions", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-roster"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-roster"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() =>
      harness.sendTurns.some((turn) => turn.developerInstructions?.includes("## Swarm Roster")),
    );

    const scoutTurn = harness.sendTurns.find((turn) =>
      turn.threadId === encodeSwarmSessionThreadId(asThreadId("thread-1"), "explore-scout-2"),
    );
    expect(scoutTurn?.developerInstructions).toContain("explore-scout-2: Scout (scout) [you]");
    expect(scoutTurn?.developerInstructions).toContain("builder-1: Builder (builder)");
    expect(scoutTurn?.developerInstructions).toContain("When messaging another teammate, prefer the exact agent id");
  });
});
