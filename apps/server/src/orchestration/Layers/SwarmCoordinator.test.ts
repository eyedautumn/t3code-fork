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

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
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

function createHarness(
  swarm: SwarmState,
  options?: {
    sendTurnImpl?: ProviderServiceShape["sendTurn"];
    listSessionsImpl?: ProviderServiceShape["listSessions"];
  },
) {
  const commands: OrchestrationCommand[] = [];
  const providerStarts: ProviderSession[] = [];
  const sendTurns: Array<{ threadId: ThreadId; text?: string; developerInstructions?: string }> =
    [];
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
      if (options?.sendTurnImpl) {
        return options.sendTurnImpl(input);
      }
      return Effect.succeed({ threadId: input.threadId, turnId: asTurnId("turn") });
    },
    interruptTurn: () => Effect.die(new Error("not implemented")),
    respondToRequest: () => Effect.die(new Error("not implemented")),
    respondToUserInput: () => Effect.die(new Error("not implemented")),
    stopSession: () => Effect.void,
    listSessions: () =>
      options?.listSessionsImpl ? options.listSessionsImpl() : Effect.succeed([]),
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

  const emitDomain = (event: OrchestrationEvent) =>
    Effect.runPromise(Queue.offer(domainEvents, event));
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
    await waitFor(() => harness.commands.some((c) => c.type === "swarm.agent.message.append"));
    expect(harness.commands.some((c) => c.type === "swarm.agent.status.set")).toBe(true);
    expect(harness.commands.some((c) => c.type === "swarm.agent.message.append")).toBe(true);
  });

  it("starts missing agent sessions when a recovered swarm is only partially initialized", async () => {
    const parentThreadId = asThreadId("thread-1");
    const coordinatorThreadId = encodeSwarmSessionThreadId(parentThreadId, "coord-1");
    const recoveredSession: ProviderSession = {
      threadId: coordinatorThreadId,
      provider: "codex",
      status: "ready",
      runtimeMode: "full-access",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const harness = createHarness(swarm, {
      listSessionsImpl: () => Effect.succeed([recoveredSession]),
    });
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    await harness.emitDomain({
      eventId: asEventId("evt-start-partial-init"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: parentThreadId,
      payload: {
        threadId: parentThreadId,
        createdAt: new Date().toISOString(),
      },
      occurredAt: new Date().toISOString(),
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-start-partial-init"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length - 1);

    const startedThreadIds = harness.providerStarts.map((session) => session.threadId);
    expect(startedThreadIds).toContain(encodeSwarmSessionThreadId(parentThreadId, "builder-1"));
    expect(startedThreadIds).toContain(
      encodeSwarmSessionThreadId(parentThreadId, "explore-scout-2"),
    );
    expect(startedThreadIds).not.toContain(coordinatorThreadId);
  });

  it("continues processing provider events while opencode sendTurn is still in flight", async () => {
    const harness = createHarness(swarm, {
      sendTurnImpl: () => Effect.never,
    });
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-start-blocked-sendturn"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-start-blocked-sendturn"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const scoutThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "explore-scout-2");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-blocked-sendturn-delta"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: scoutThreadId,
      turnId: asTurnId("turn-blocked-sendturn"),
      payload: {
        streamKind: "assistant_text",
        delta:
          "[swarm.message coord-1] The swarm needs you to assign tasks. Please start scout and builder on bug finding mission. I'm ready to review once their work is complete.",
      },
    });

    await waitFor(() =>
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "explore-scout-2" &&
          command.targetAgentId === "coord-1" &&
          command.text.includes("Please start scout and builder on bug finding mission."),
      ),
    );
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

    await waitFor(() => harness.sendTurns.some((turn) => turn.text?.includes("build please")));
    const operatorTurn = harness.sendTurns.find((turn) => turn.text?.includes("build please"));
    expect(operatorTurn?.threadId).toBeDefined();
    expect(operatorTurn?.text).toContain("build please");
  });

  it("queues targeted messages when the agent is already running and flushes them after turn completion", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-queue-start"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-queue-start"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);
    const initialTurnCount = harness.sendTurns.length;
    const coordinatorThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "coord-1");

    await harness.emitProvider({
      type: "turn.started",
      eventId: asEventId("evt-coord-running"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: coordinatorThreadId,
      turnId: asTurnId("turn-coord-running"),
      itemId: undefined,
      payload: {
        model: "claude-code",
        effort: undefined,
      },
    });

    await harness.emitDomain({
      eventId: asEventId("evt-queue-op"),
      type: "swarm.agent.message",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        messageId: asMessageId("msg-queue-op"),
        sender: "operator",
        senderAgentId: null,
        targetAgentId: "coord-1",
        text: "queued coordinator message",
        streaming: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      occurredAt: new Date().toISOString(),
      sequence: 1,
      commandId: CommandId.makeUnsafe("cmd-queue-op"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.sendTurns).toHaveLength(initialTurnCount);

    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-coord-ready"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: coordinatorThreadId,
      turnId: asTurnId("turn-coord-running"),
      itemId: undefined,
      payload: {
        state: "completed",
        stopReason: "end_turn",
        usage: null,
      },
    });

    await waitFor(() =>
      harness.sendTurns.some((turn) => turn.text?.includes("queued coordinator message")),
    );
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

    await waitFor(() => harness.commands.some((command) => command.type === "swarm.task.created"));
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
        delta:
          "[swarm.message swarm-scout-5] Scout the codebase for swarm-related bugs and report back.",
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

  it("delivers close-bounded swarm messages immediately during streaming before turn completion", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-early-close"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-early-close"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-agent-delta-early-close"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-agent-early-close"),
      payload: {
        streamKind: "unknown",
        delta:
          "[swarm.message coord-1] Immediate handoff while stream is still active. [swarm.message_close]",
      },
    });

    await waitFor(() =>
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "coord-1" &&
          command.text === "Immediate handoff while stream is still active.",
      ),
    );

    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-agent-complete-early-close"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-agent-early-close"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    expect(
      harness.commands.filter(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "coord-1" &&
          command.text === "Immediate handoff while stream is still active.",
      ),
    ).toHaveLength(1);
  });

  it("routes explicit directives on item.completed even before turn.completed arrives", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-item-complete-route"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-item-complete-route"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-item-complete-route-delta"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-item-complete-route"),
      payload: {
        streamKind: "unknown",
        delta:
          "[swarm.message coord-1] I need an assignment. I'm blocked waiting. Please assign me a task.",
      },
    });
    await harness.emitProvider({
      type: "item.completed",
      eventId: asEventId("evt-item-complete-route-item"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-item-complete-route"),
      payload: {
        itemType: "assistant_message",
      },
    });

    await waitFor(() =>
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "coord-1" &&
          command.text.includes("I need an assignment. I'm blocked waiting."),
      ),
    );

    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-item-complete-route-complete"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-item-complete-route"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });
  });

  it("routes multiline markdown swarm bug reports closed with swarm.message_close", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-bug-report"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-bug-report"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const scoutThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "explore-scout-2");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-bug-report-delta"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: scoutThreadId,
      turnId: asTurnId("turn-bug-report"),
      payload: {
        streamKind: "assistant_text",
        delta:
          '[swarm.message coord-1] Bug report:\n\n1. **orchestration.ts:815-816** - duplicate `"swarm.started"`, needs to be `"swarm.created"`\n2. **shell.ts:66-74** - whitespace inconsistency\n3. **swarmMessaging.ts:151-155** - parser edge case\n4. **model.ts** - resolution asymmetry\n5. **orchestration.ts:109-112** - schema defaults issue\n6. **terminal.ts:48** - non-empty constraint\n7. **providerRuntime.ts:22-25** - source naming\n8. **shell.test.ts** - test gap\n\nPriority: #1, #4. Done.\n\n[swarm.message_close]',
      },
    });
    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-bug-report-complete"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: scoutThreadId,
      turnId: asTurnId("turn-bug-report"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    await waitFor(() =>
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "explore-scout-2" &&
          command.targetAgentId === "coord-1" &&
          command.text.includes('duplicate `"swarm.started"`'),
      ),
    );

    expect(
      harness.sendTurns.some(
        (turn) =>
          turn.threadId === encodeSwarmSessionThreadId(asThreadId("thread-1"), "coord-1") &&
          turn.text?.includes("Priority: #1, #4. Done."),
      ),
    ).toBe(true);
  });

  it("routes single-bracket target= swarm.message directives and leaves a delivery trace", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-target-equals"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-target-equals"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-target-equals-delta"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-target-equals"),
      payload: {
        streamKind: "assistant_text",
        delta:
          "[swarm.message target=explore-scout-2] Scout the codebase and summarize the structure. [swarm.message_close]",
      },
    });
    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-target-equals-complete"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-target-equals"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    await waitFor(() =>
      harness.sendTurns.some(
        (turn) =>
          turn.threadId === encodeSwarmSessionThreadId(asThreadId("thread-1"), "explore-scout-2") &&
          turn.text?.includes("Scout the codebase and summarize the structure."),
      ),
    );

    expect(
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "explore-scout-2" &&
          command.text === "Scout the codebase and summarize the structure.",
      ),
    ).toBe(true);

    expect(
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === null &&
          command.text === "Sent swarm message to explore-scout-2.",
      ),
    ).toBe(true);
  });

  it("routes explicit swarm.message directives without requiring a message_close marker", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-no-close"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-no-close"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-agent-delta-no-close"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-agent-no-close"),
      payload: {
        streamKind: "unknown",
        delta: "[swarm.message coord-1] Requesting review of the latest patch.",
      },
    });
    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-agent-complete-no-close"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-agent-no-close"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    await waitFor(() =>
      harness.sendTurns.some(
        (turn) =>
          turn.threadId === encodeSwarmSessionThreadId(asThreadId("thread-1"), "coord-1") &&
          turn.text?.includes("Requesting review of the latest patch."),
      ),
    );

    expect(
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "coord-1" &&
          command.text === "Requesting review of the latest patch.",
      ),
    ).toBe(true);
  });

  it("routes swarm.message directives when only item.completed fires", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-item-only"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-item-only"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-item-only-delta"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-item-only"),
      payload: {
        streamKind: "assistant_text",
        delta: "[swarm.message coord-1] Item-only routing request.",
      },
    });
    await harness.emitProvider({
      type: "item.completed",
      eventId: asEventId("evt-item-only-complete"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-item-only"),
      payload: {
        itemType: "assistant_message",
      },
    });

    await waitFor(() =>
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "coord-1" &&
          command.text === "Item-only routing request.",
      ),
    );
  });

  it("routes codex swarm.message directives and preserves public text in the source transcript", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-codex"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-codex"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-codex-agent-delta"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-codex-agent"),
      payload: {
        streamKind: "assistant_text",
        delta:
          "Implemented the fix locally. [swarm.message coord-1] Please review the patch and confirm. [swarm.message_close]",
      },
    });
    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-codex-agent-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-codex-agent"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    await waitFor(() =>
      harness.sendTurns.some(
        (turn) =>
          turn.threadId === encodeSwarmSessionThreadId(asThreadId("thread-1"), "coord-1") &&
          turn.text?.includes("Please review the patch and confirm."),
      ),
    );

    expect(
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "coord-1" &&
          command.text === "Please review the patch and confirm.",
      ),
    ).toBe(true);

    expect(
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === null &&
          command.text === "Implemented the fix locally.",
      ),
    ).toBe(true);
  });

  it("routes codex swarm.message bodies that include swarm.message-like placeholder text", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-codex-placeholder"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-codex-placeholder"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const coordinatorThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "coord-1");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-codex-placeholder-delta"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: coordinatorThreadId,
      turnId: asTurnId("turn-codex-placeholder"),
      payload: {
        streamKind: "assistant_text",
        delta:
          "[swarm.message builder-1] Please confirm how [swarm.message …] directives flow through routing and report gaps.",
      },
    });
    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-codex-placeholder-complete"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: coordinatorThreadId,
      turnId: asTurnId("turn-codex-placeholder"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    await waitFor(() =>
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "coord-1" &&
          command.targetAgentId === "builder-1" &&
          command.text ===
            "Please confirm how [swarm.message …] directives flow through routing and report gaps.",
      ),
    );
  });

  it("parses swarm directives from unknown assistant streams on turn completion", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-unknown"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-unknown"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-unknown-agent-delta"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-unknown-agent"),
      payload: {
        streamKind: "unknown",
        delta:
          "[swarm.message coord-1] This should stay raw because it was not confirmed assistant text. [swarm.message_close]",
      },
    });
    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-unknown-agent-complete"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-unknown-agent"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    await waitFor(() =>
      harness.sendTurns.some(
        (turn) =>
          turn.threadId === encodeSwarmSessionThreadId(asThreadId("thread-1"), "coord-1") &&
          turn.text?.includes("This should stay raw because it was not confirmed assistant text."),
      ),
    );

    expect(
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "coord-1" &&
          command.text.includes("This should stay raw"),
      ),
    );
  });

  it("continues delivering valid directives even when one target is unresolved", async () => {
    const harness = createHarness(swarm);
    runtime = ManagedRuntime.make(harness.layer);
    const coordinator = await runtime.runPromise(Effect.service(SwarmCoordinator));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(coordinator.start.pipe(Scope.provide(scope)));

    const startedAt = new Date().toISOString();
    await harness.emitDomain({
      eventId: asEventId("evt-swarm-start-partial-resolve"),
      type: "swarm.started",
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      payload: {
        threadId: asThreadId("thread-1"),
        createdAt: startedAt,
      },
      occurredAt: startedAt,
      sequence: 0,
      commandId: CommandId.makeUnsafe("cmd-swarm-start-partial-resolve"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    await waitFor(() => harness.providerStarts.length === swarm.config.agents.length);

    const builderThreadId = encodeSwarmSessionThreadId(asThreadId("thread-1"), "builder-1");
    await harness.emitProvider({
      type: "content.delta",
      eventId: asEventId("evt-partial-resolve-delta"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-partial-resolve"),
      payload: {
        streamKind: "assistant_text",
        delta:
          "[swarm.message missing-agent] This should fail. [swarm.message coord-1] This should still deliver.",
      },
    });
    await harness.emitProvider({
      type: "turn.completed",
      eventId: asEventId("evt-partial-resolve-complete"),
      provider: "opencode",
      createdAt: new Date().toISOString(),
      threadId: builderThreadId,
      turnId: asTurnId("turn-partial-resolve"),
      payload: {
        state: "completed",
        stopReason: "stop",
      },
    });

    await waitFor(() =>
      harness.sendTurns.some(
        (turn) =>
          turn.threadId === encodeSwarmSessionThreadId(asThreadId("thread-1"), "coord-1") &&
          turn.text?.includes("This should still deliver."),
      ),
    );

    expect(
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === "builder-1" &&
          command.targetAgentId === "coord-1" &&
          command.text === "This should still deliver.",
      ),
    ).toBe(true);

    expect(
      harness.commands.some(
        (command) =>
          command.type === "swarm.agent.message.append" &&
          command.senderAgentId === null &&
          command.targetAgentId === SWARM_OPERATOR_TARGET_ID &&
          command.text.includes("Unresolved swarm target 'missing-agent'"),
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

    const scoutTurn = harness.sendTurns.find(
      (turn) =>
        turn.threadId === encodeSwarmSessionThreadId(asThreadId("thread-1"), "explore-scout-2"),
    );
    expect(scoutTurn?.developerInstructions).toContain("explore-scout-2: Scout (scout) [you]");
    expect(scoutTurn?.developerInstructions).toContain("builder-1: Builder (builder)");
    expect(scoutTurn?.developerInstructions).toContain(
      "When messaging another teammate, prefer the exact agent id",
    );
    expect(scoutTurn?.developerInstructions).toContain(
      "Do NOT call a tool, function, XML tag, or API named `swarm.message`.",
    );
    expect(scoutTurn?.developerInstructions).toContain(
      "Use exactly: `[swarm.message <TARGET>] <message>`",
    );
    expect(scoutTurn?.developerInstructions).toContain(
      "Use `SWARM_BOARD.md` as the shared project board for this swarm.",
    );
    expect(scoutTurn?.developerInstructions).toContain(
      "Coordinator rule: every new assignment must update task ownership/status in the board in the same turn.",
    );
    expect(scoutTurn?.developerInstructions).toContain(
      "The board may contain multiple swarms; only edit your swarm section",
    );
  });
});
