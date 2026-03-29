import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  RuntimeItemId,
  ProjectId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type SwarmState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  applyOrchestrationDomainEvent,
  applyProviderRuntimeEvent,
  markThreadUnread,
  reorderProjects,
  syncServerReadModel,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    swarm: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5-codex",
        expanded: true,
        scripts: [],
      },
    ],
    threads: [thread],
    threadsHydrated: true,
    lastProcessedSequence: 0,
    swarmLiveByThreadId: {},
  };
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function makeSwarmThreadId(threadId: string, agentId: string): ThreadId {
  return ThreadId.makeUnsafe(`swarm:${encodeBase64Url(threadId)}:${encodeBase64Url(agentId)}`);
}

function makeSwarmState(agentId = "agent-1"): SwarmState {
  return {
    config: {
      name: "Swarm",
      mission: "Ship it",
      targetPath: undefined,
      agents: [
        {
          id: agentId,
          name: "Agent 1",
          role: "builder",
          provider: "opencode",
          model: "nemotron-3-super-free",
          runtimeMode: "full-access",
          interactionMode: "default",
          serviceTier: null,
          modelOptions: undefined,
          reasoningEffort: undefined,
          fastMode: false,
        },
      ],
      contextFiles: [],
    },
    agents: [],
    messages: [],
    tasks: [],
  };
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5.3-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    swarm: null,
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: "gpt-5.3-codex",
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModel: "gpt-5.3-codex",
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

describe("store pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });

  it("preserves live swarm messages when a trailing snapshot is missing them", () => {
    const thread = makeThread({
      swarm: makeSwarmState(),
      updatedAt: "2026-02-27T00:00:00.000Z",
    });
    const initialState = makeState(thread);

    const withLiveMessage = applyOrchestrationDomainEvent(initialState, {
      eventId: EventId.makeUnsafe("evt-swarm-message-live"),
      type: "swarm.agent.message",
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-1"),
      occurredAt: "2026-02-27T00:00:03.000Z",
      sequence: 3,
      commandId: CommandId.makeUnsafe("cmd-swarm-message-live"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("swarm-message-1"),
        sender: "agent",
        senderAgentId: "agent-1",
        targetAgentId: "agent-1",
        text: "Bug report delivered",
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      },
    });

    const staleSnapshot = makeReadModel(
      makeReadModelThread({
        swarm: makeSwarmState(),
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    );

    const next = syncServerReadModel(withLiveMessage, staleSnapshot);
    const nextThread = next.threads[0];
    expect(nextThread?.swarm?.messages).toHaveLength(1);
    expect(nextThread?.swarm?.messages[0]?.text).toBe("Bug report delivered");
    expect(nextThread?.swarm?.messages[0]?.targetAgentId).toBe("agent-1");
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const state: AppState = {
      projects: [
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project3,
          name: "Project 3",
          cwd: "/tmp/project-3",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
      ],
      threads: [],
      threadsHydrated: true,
      lastProcessedSequence: 0,
      swarmLiveByThreadId: {},
    };

    const next = reorderProjects(state, project1, project3);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project3, project1]);
  });

  it("tracks live swarm provider runtime deltas and completes them on turn completion", () => {
    const agentId = "agent-1";
    const threadId = ThreadId.makeUnsafe("thread-1");
    const state = makeState(
      makeThread({
        id: threadId,
        swarm: makeSwarmState(agentId),
      }),
    );

    const streamingThreadId = makeSwarmThreadId(String(threadId), agentId);
    const contentDelta = {
      type: "content.delta",
      eventId: EventId.makeUnsafe("evt-1"),
      provider: "opencode",
      threadId: streamingThreadId,
      createdAt: "2026-02-25T10:00:00.000Z",
      turnId: TurnId.makeUnsafe("turn-1"),
      itemId: RuntimeItemId.makeUnsafe("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    } satisfies ProviderRuntimeEvent;

    const withDelta = applyProviderRuntimeEvent(state, contentDelta);

    expect(withDelta.swarmLiveByThreadId[String(threadId)]?.messages).toHaveLength(1);
    expect(withDelta.swarmLiveByThreadId[String(threadId)]?.messages[0]).toMatchObject({
      agentId,
      kind: "assistant",
      text: "hello",
      streaming: true,
    });

    const completed = {
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-2"),
      provider: "opencode",
      threadId: streamingThreadId,
      createdAt: "2026-02-25T10:00:01.000Z",
      turnId: TurnId.makeUnsafe("turn-1"),
      payload: {
        state: "completed",
        stopReason: "end_turn",
        usage: null,
      },
    } satisfies ProviderRuntimeEvent;

    const withCompletedTurn = applyProviderRuntimeEvent(withDelta, completed);

    expect(withCompletedTurn.swarmLiveByThreadId[String(threadId)]?.messages[0]?.streaming).toBe(
      false,
    );
  });
});

describe("store read model sync", () => {
  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "claude-opus-4-6",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "sonnet",
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe("claude-sonnet-4-6");
  });

  it("preserves the current project order when syncing incoming read model updates", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          expanded: true,
          scripts: [],
        },
      ],
      threads: [],
      threadsHydrated: true,
      lastProcessedSequence: 0,
      swarmLiveByThreadId: {},
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project1, project3]);
  });
});
