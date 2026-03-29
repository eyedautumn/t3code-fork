import { Fragment, type ReactNode, createElement, useEffect } from "react";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ProviderKind,
  type ProviderRuntimeEvent,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
  type SwarmMessage,
  type SwarmState,
  type SwarmTask,
} from "@t3tools/contracts";
import {
  getModelOptions,
  inferProviderForModel,
  resolveModelSlug,
  resolveModelSlugForProvider,
} from "@t3tools/shared/model";
import { create } from "zustand";
import { type ChatMessage, type Project, type Thread } from "./types";
import { Debouncer } from "@tanstack/react-pacer";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  threadsHydrated: boolean;
  lastProcessedSequence: number;
  swarmLiveByThreadId: Record<string, SwarmLiveThreadState>;
}

export type SwarmLiveMessage = {
  id: string;
  agentId: string;
  kind: "assistant" | "thinking" | "tool" | "mcp";
  text: string;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
  targetAgentId: string | null;
  itemId: string | null;
  turnId: string | null;
};

export type SwarmLiveAgentState = {
  agentId: string;
  status: SwarmState["agents"][number]["status"];
  updatedAt: string;
  lastError: string | null;
};

export type SwarmLiveThreadState = {
  agentsById: Record<string, SwarmLiveAgentState>;
  messages: SwarmLiveMessage[];
};

const PERSISTED_STATE_KEY = "t3code:renderer-state:v8";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

const initialState: AppState = {
  projects: [],
  threads: [],
  threadsHydrated: false,
  lastProcessedSequence: 0,
  swarmLiveByThreadId: {},
};
const TOOL_RUNTIME_ERROR_REGEX =
  /\b(tool|mcp|approval|permission|sandbox|apply_patch|exec_command|file_search|read_file|write_file|edit_file)\b/i;
type SwarmAgentStatusSnapshot = SwarmState["agents"][number];
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];

// ── Persist helpers ──────────────────────────────────────────────────

function readPersistedState(): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      expandedProjectCwds?: string[];
      projectOrderCwds?: string[];
    };
    persistedExpandedProjectCwds.clear();
    persistedProjectOrderCwds.length = 0;
    for (const cwd of parsed.expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(cwd);
      }
    }
    for (const cwd of parsed.projectOrderCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
        persistedProjectOrderCwds.push(cwd);
      }
    }
    return { ...initialState };
  } catch {
    return initialState;
  }
}

let legacyKeysCleanedUp = false;

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: state.projects
          .filter((project) => project.expanded)
          .map((project) => project.cwd),
        projectOrderCwds: state.projects.map((project) => project.cwd),
      }),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}
const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

function decodeBase64Url(value: string): string {
  if (typeof window !== "undefined" && typeof window.atob === "function") {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = window.atob(padded);
    try {
      return decodeURIComponent(
        Array.from(decoded)
          .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
          .join(""),
      );
    } catch {
      return decoded;
    }
  }
  return "";
}

function decodeSwarmSessionThreadId(
  threadId: ThreadId,
): { threadId: ThreadId; agentId: string } | null {
  const raw = String(threadId);
  if (!raw.startsWith("swarm:")) {
    return null;
  }
  const [threadPart, agentPart, extra] = raw.slice("swarm:".length).split(":");
  if (!threadPart || !agentPart || extra !== undefined) {
    return null;
  }
  try {
    const decodedThreadId = decodeBase64Url(threadPart);
    const decodedAgentId = decodeBase64Url(agentPart);
    if (!decodedThreadId || !decodedAgentId) {
      return null;
    }
    return {
      threadId: ThreadId.makeUnsafe(decodedThreadId),
      agentId: decodedAgentId,
    };
  } catch {
    return null;
  }
}

function toSwarmAgentStatusFromRuntime(
  status: string | undefined,
): SwarmState["agents"][number]["status"] | null {
  switch (status) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    default:
      return null;
  }
}

function ensureSwarmLiveThreadState(
  state: AppState,
  threadId: ThreadId,
): SwarmLiveThreadState | null {
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (!thread?.swarm) return null;
  return state.swarmLiveByThreadId[String(threadId)] ?? { agentsById: {}, messages: [] };
}

// ── Pure helpers ──────────────────────────────────────────────────────

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

function mapProjectsFromReadModel(
  incoming: OrchestrationReadModel["projects"],
  previous: Project[],
): Project[] {
  const previousById = new Map(previous.map((project) => [project.id, project] as const));
  const previousByCwd = new Map(previous.map((project) => [project.cwd, project] as const));
  const previousOrderById = new Map(previous.map((project, index) => [project.id, index] as const));
  const previousOrderByCwd = new Map(
    previous.map((project, index) => [project.cwd, index] as const),
  );
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const usePersistedOrder = previous.length === 0;

  const mappedProjects = incoming.map((project) => {
    const existing = previousById.get(project.id) ?? previousByCwd.get(project.workspaceRoot);
    return {
      id: project.id,
      name: project.title,
      cwd: project.workspaceRoot,
      model:
        existing?.model ??
        resolveModelSlug(project.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER.codex),
      expanded:
        existing?.expanded ??
        (persistedExpandedProjectCwds.size > 0
          ? persistedExpandedProjectCwds.has(project.workspaceRoot)
          : true),
      scripts: project.scripts.map((script) => ({ ...script })),
    } satisfies Project;
  });

  return mappedProjects
    .map((project, incomingIndex) => {
      const previousIndex =
        previousOrderById.get(project.id) ?? previousOrderByCwd.get(project.cwd);
      const persistedIndex = usePersistedOrder ? persistedOrderByCwd.get(project.cwd) : undefined;
      const orderIndex =
        previousIndex ??
        persistedIndex ??
        (usePersistedOrder ? persistedProjectOrderCwds.length : previous.length) + incomingIndex;
      return { project, incomingIndex, orderIndex };
    })
    .toSorted((a, b) => {
      const byOrder = a.orderIndex - b.orderIndex;
      if (byOrder !== 0) return byOrder;
      return a.incomingIndex - b.incomingIndex;
    })
    .map((entry) => entry.project);
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (providerName === "codex" || providerName === "claudeAgent" || providerName === "opencode") {
    return providerName as ProviderKind;
  }
  return "codex";
}

const OPENCODE_MODEL_SLUGS = new Set<string>(
  getModelOptions("opencode" as ProviderKind).map((option) => option.slug),
);

function inferProviderForThreadModel(input: {
  readonly model: string;
  readonly sessionProviderName: string | null;
}): ProviderKind {
  if (
    input.sessionProviderName === "codex" ||
    input.sessionProviderName === "claudeAgent" ||
    input.sessionProviderName === "opencode"
  ) {
    return input.sessionProviderName as ProviderKind;
  }
  const normalizedModel = input.model.trim();
  if (normalizedModel && OPENCODE_MODEL_SLUGS.has(normalizedModel)) {
    return "opencode" as ProviderKind;
  }
  return inferProviderForModel(input.model);
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = mapProjectsFromReadModel(
    readModel.projects.filter((project) => project.deletedAt === null),
    state.projects,
  );
  const existingThreadById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const existing = existingThreadById.get(thread.id);
      const mergedSwarm = mergeSwarmSnapshot(thread.swarm, existing?.swarm ?? null);
      return {
        id: thread.id,
        codexThreadId: null,
        projectId: thread.projectId,
        title: thread.title,
        model: resolveModelSlugForProvider(
          inferProviderForThreadModel({
            model: thread.model,
            sessionProviderName: thread.session?.providerName ?? null,
          }),
          thread.model,
        ),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        session: thread.session
          ? {
              provider: toLegacyProvider(thread.session.providerName),
              status: toLegacySessionStatus(thread.session.status),
              orchestrationStatus: thread.session.status,
              activeTurnId: thread.session.activeTurnId ?? undefined,
              createdAt: thread.session.updatedAt,
              updatedAt: thread.session.updatedAt,
              ...(thread.session.lastError ? { lastError: thread.session.lastError } : {}),
            }
          : null,
        messages: thread.messages.map((message) => {
          const attachments = message.attachments?.map((attachment) => ({
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
          }));
          const normalizedMessage: ChatMessage = {
            id: message.id,
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
            streaming: message.streaming,
            ...(message.streaming ? {} : { completedAt: message.updatedAt }),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          };
          return normalizedMessage;
        }),
        proposedPlans: thread.proposedPlans.map((proposedPlan) => ({
          id: proposedPlan.id,
          turnId: proposedPlan.turnId,
          planMarkdown: proposedPlan.planMarkdown,
          implementedAt: proposedPlan.implementedAt,
          implementationThreadId: proposedPlan.implementationThreadId,
          createdAt: proposedPlan.createdAt,
          updatedAt: proposedPlan.updatedAt,
        })),
        error: thread.session?.lastError ?? null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        latestTurn: thread.latestTurn,
        lastVisitedAt: existing?.lastVisitedAt ?? thread.updatedAt,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        turnDiffSummaries: thread.checkpoints.map((checkpoint) => ({
          turnId: checkpoint.turnId,
          completedAt: checkpoint.completedAt,
          status: checkpoint.status,
          assistantMessageId: checkpoint.assistantMessageId ?? undefined,
          checkpointTurnCount: checkpoint.checkpointTurnCount,
          checkpointRef: checkpoint.checkpointRef,
          files: checkpoint.files.map((file) => ({ ...file })),
        })),
        activities: thread.activities.map((activity) => ({ ...activity })),
        swarm: mergedSwarm,
      };
    });
  return {
    ...state,
    projects,
    threads,
    threadsHydrated: true,
  };
}

function pickNewerByUpdatedAt<T extends { updatedAt: string }>(left: T, right: T): T {
  return right.updatedAt >= left.updatedAt ? right : left;
}

function mergeSwarmAgents(
  snapshotAgents: ReadonlyArray<SwarmAgentStatusSnapshot>,
  existingAgents: ReadonlyArray<SwarmAgentStatusSnapshot>,
): SwarmAgentStatusSnapshot[] {
  const byId = new Map<string, SwarmAgentStatusSnapshot>();
  for (const agent of snapshotAgents) {
    byId.set(agent.agentId, agent);
  }
  for (const agent of existingAgents) {
    const current = byId.get(agent.agentId);
    byId.set(agent.agentId, current ? pickNewerByUpdatedAt(current, agent) : agent);
  }
  return Array.from(byId.values()).toSorted((left, right) =>
    left.agentId.localeCompare(right.agentId),
  );
}

function shouldPreferExistingSwarmMessage(existing: SwarmMessage, snapshot: SwarmMessage): boolean {
  if (existing.updatedAt !== snapshot.updatedAt) {
    return existing.updatedAt > snapshot.updatedAt;
  }
  if (existing.streaming !== snapshot.streaming) {
    return existing.streaming === false;
  }
  return existing.text.length >= snapshot.text.length;
}

function mergeSwarmMessages(
  snapshotMessages: ReadonlyArray<SwarmMessage>,
  existingMessages: ReadonlyArray<SwarmMessage>,
): SwarmMessage[] {
  const byId = new Map<string, SwarmMessage>();
  for (const message of snapshotMessages) {
    byId.set(message.id, message);
  }
  for (const message of existingMessages) {
    const current = byId.get(message.id);
    byId.set(
      message.id,
      current ? (shouldPreferExistingSwarmMessage(message, current) ? message : current) : message,
    );
  }
  return Array.from(byId.values()).toSorted((left, right) => {
    const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
    if (createdAtOrder !== 0) return createdAtOrder;
    return left.id.localeCompare(right.id);
  });
}

function mergeSwarmTasks(
  snapshotTasks: ReadonlyArray<SwarmTask>,
  existingTasks: ReadonlyArray<SwarmTask>,
): SwarmTask[] {
  const byId = new Map<string, SwarmTask>();
  for (const task of snapshotTasks) {
    byId.set(task.id, task);
  }
  for (const task of existingTasks) {
    const current = byId.get(task.id);
    byId.set(task.id, current ? pickNewerByUpdatedAt(current, task) : task);
  }
  return Array.from(byId.values()).toSorted((left, right) => left.id.localeCompare(right.id));
}

function mergeSwarmSnapshot(
  snapshotSwarm: SwarmState | null,
  existingSwarm: SwarmState | null,
): SwarmState | null {
  if (!snapshotSwarm) {
    return existingSwarm;
  }
  if (!existingSwarm) {
    return snapshotSwarm;
  }
  return {
    ...snapshotSwarm,
    agents: mergeSwarmAgents(snapshotSwarm.agents, existingSwarm.agents),
    messages: mergeSwarmMessages(snapshotSwarm.messages, existingSwarm.messages),
    tasks: mergeSwarmTasks(snapshotSwarm.tasks, existingSwarm.tasks),
  };
}

export function applyOrchestrationDomainEvent(
  state: AppState,
  event: OrchestrationEvent,
): AppState {
  switch (event.type) {
    case "swarm.agent.status": {
      const { threadId, agentId, status, updatedAt, lastError } = event.payload;
      const threads = updateThread(state.threads, threadId, (thread) => {
        if (!thread.swarm) return thread;
        const existing = thread.swarm.agents.find((agent) => agent.agentId === agentId);
        const nextAgent = {
          agentId,
          status,
          updatedAt,
          lastError,
        };
        const agents = existing
          ? thread.swarm.agents.map((agent) => (agent.agentId === agentId ? nextAgent : agent))
          : [...thread.swarm.agents, nextAgent];
        return {
          ...thread,
          swarm: {
            ...thread.swarm,
            agents,
          },
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }
    case "swarm.agent.message": {
      const {
        threadId,
        messageId,
        sender,
        senderAgentId,
        targetAgentId,
        text,
        streaming,
        createdAt,
        updatedAt,
      } = event.payload;
      const threads = updateThread(state.threads, threadId, (thread) => {
        if (!thread.swarm) return thread;
        const existing = thread.swarm.messages.find((message) => message.id === messageId);
        const nextMessage = {
          id: messageId,
          sender,
          senderAgentId,
          targetAgentId,
          text,
          streaming,
          createdAt,
          updatedAt,
        };
        const messages = existing
          ? thread.swarm.messages.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    text: streaming ? `${message.text}${text}` : text,
                    streaming,
                    updatedAt,
                  }
                : message,
            )
          : [...thread.swarm.messages, nextMessage];
        return {
          ...thread,
          swarm: {
            ...thread.swarm,
            messages,
          },
        };
      });
      return threads === state.threads ? state : { ...state, threads };
    }
    default:
      return state;
  }
}

export function applyProviderRuntimeEvent(state: AppState, event: ProviderRuntimeEvent): AppState {
  const decoded = decodeSwarmSessionThreadId(event.threadId);
  if (!decoded) return state;

  const liveThread = ensureSwarmLiveThreadState(state, decoded.threadId);
  if (!liveThread) return state;

  const nextLiveThread: SwarmLiveThreadState = {
    agentsById: { ...liveThread.agentsById },
    messages: [...liveThread.messages],
  };

  const setAgentStatus = (
    status: SwarmState["agents"][number]["status"],
    updatedAt: string,
    lastError: string | null = null,
  ) => {
    nextLiveThread.agentsById[decoded.agentId] = {
      agentId: decoded.agentId,
      status,
      updatedAt,
      lastError,
    };
  };

  const upsertLiveMessage = (input: {
    id: string;
    kind: SwarmLiveMessage["kind"];
    text: string;
    createdAt: string;
    updatedAt: string;
    itemId: string | null;
    turnId: string | null;
    streaming: boolean;
    mode?: "append" | "replace";
  }) => {
    const existingIndex = nextLiveThread.messages.findIndex((message) => message.id === input.id);
    if (existingIndex >= 0) {
      const current = nextLiveThread.messages[existingIndex]!;
      const nextText = input.mode === "replace" ? input.text : `${current.text}${input.text}`;
      nextLiveThread.messages[existingIndex] = {
        ...current,
        text: nextText,
        streaming: input.streaming,
        updatedAt: input.updatedAt,
      };
      return;
    }
    nextLiveThread.messages.push({
      id: input.id,
      agentId: decoded.agentId,
      kind: input.kind,
      text: input.text,
      streaming: input.streaming,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      targetAgentId: null,
      itemId: input.itemId,
      turnId: input.turnId,
    });
  };

  const completeLiveMessages = (
    predicate: (message: SwarmLiveMessage) => boolean,
    updatedAt: string,
  ) => {
    nextLiveThread.messages = nextLiveThread.messages.map((message) =>
      predicate(message) ? { ...message, streaming: false, updatedAt } : message,
    );
  };

  switch (event.type) {
    case "session.state.changed": {
      const status = toSwarmAgentStatusFromRuntime(event.payload.state);
      if (status) {
        setAgentStatus(
          status,
          event.createdAt,
          status === "error" ? (event.payload.reason ?? null) : null,
        );
      }
      break;
    }
    case "session.exited": {
      setAgentStatus("stopped", event.createdAt);
      break;
    }
    case "runtime.error": {
      const combined = [
        event.payload.message ?? "Provider runtime error",
        event.payload.detail ? JSON.stringify(event.payload.detail) : null,
      ]
        .filter(Boolean)
        .join(" | detail: ");
      if (TOOL_RUNTIME_ERROR_REGEX.test(combined)) {
        break;
      }
      setAgentStatus("error", event.createdAt, event.payload.message ?? "Provider runtime error");
      break;
    }
    case "turn.started": {
      setAgentStatus("running", event.createdAt);
      break;
    }
    case "content.delta": {
      const kind =
        event.payload.streamKind === "reasoning_text" ||
        event.payload.streamKind === "reasoning_summary_text"
          ? "thinking"
          : event.payload.streamKind === "assistant_text" || event.payload.streamKind === "unknown"
            ? "assistant"
            : null;
      if (!kind) break;
      setAgentStatus("running", event.createdAt);
      const itemId = event.itemId ? String(event.itemId) : null;
      const turnId = event.turnId ? String(event.turnId) : null;
      const messageId = `${decoded.agentId}:${kind}:${itemId ?? turnId ?? event.eventId}`;
      upsertLiveMessage({
        id: messageId,
        kind,
        text: event.payload.delta,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        itemId,
        turnId,
        streaming: true,
        mode: "append",
      });
      break;
    }
    case "tool.progress": {
      const toolName = event.payload.toolName ?? "tool";
      const summary = event.payload.summary ?? "running";
      const toolUseId = event.payload.toolUseId ?? null;
      const label = toolUseId ? `${toolName} (${toolUseId})` : toolName;
      const messageId = `${decoded.agentId}:tool:${toolUseId ?? event.eventId}`;
      setAgentStatus("running", event.createdAt);
      upsertLiveMessage({
        id: messageId,
        kind: "tool",
        text: `${label}: ${summary}`,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        itemId: null,
        turnId: event.turnId ? String(event.turnId) : null,
        streaming: true,
        mode: "replace",
      });
      break;
    }
    case "tool.summary": {
      const toolUseId = event.payload.precedingToolUseIds?.[0] ?? null;
      const messageId = `${decoded.agentId}:tool:${toolUseId ?? event.eventId}`;
      setAgentStatus("running", event.createdAt);
      upsertLiveMessage({
        id: messageId,
        kind: "tool",
        text: event.payload.summary,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        itemId: null,
        turnId: event.turnId ? String(event.turnId) : null,
        streaming: false,
        mode: "replace",
      });
      break;
    }
    case "mcp.status.updated": {
      const statusText =
        typeof event.payload.status === "string"
          ? event.payload.status
          : JSON.stringify(event.payload.status);
      const messageId = `${decoded.agentId}:mcp:${event.eventId}`;
      upsertLiveMessage({
        id: messageId,
        kind: "mcp",
        text: statusText ? `MCP status: ${statusText}` : "MCP status updated",
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        itemId: null,
        turnId: event.turnId ? String(event.turnId) : null,
        streaming: false,
        mode: "replace",
      });
      break;
    }
    case "item.completed": {
      if (
        event.payload.itemType !== "assistant_message" &&
        event.payload.itemType !== "reasoning"
      ) {
        break;
      }
      const itemId = event.itemId ? String(event.itemId) : null;
      completeLiveMessages(
        (message) =>
          message.agentId === decoded.agentId &&
          (itemId
            ? message.itemId === itemId
            : message.turnId === (event.turnId ? String(event.turnId) : null)),
        event.createdAt,
      );
      break;
    }
    case "turn.completed": {
      setAgentStatus(
        event.payload.state === "failed" ? "error" : "ready",
        event.createdAt,
        event.payload.errorMessage ?? null,
      );
      const turnId = event.turnId ? String(event.turnId) : null;
      completeLiveMessages(
        (message) => message.agentId === decoded.agentId && (!turnId || message.turnId === turnId),
        event.createdAt,
      );
      break;
    }
    default:
      return state;
  }

  nextLiveThread.messages = nextLiveThread.messages
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-400);

  return {
    ...state,
    swarmLiveByThreadId: {
      ...state.swarmLiveByThreadId,
      [String(decoded.threadId)]: nextLiveThread,
    },
    threads: updateThread(state.threads, decoded.threadId, (thread) => {
      if (!thread.swarm) return thread;
      const liveAgent = nextLiveThread.agentsById[decoded.agentId];
      if (!liveAgent) return thread;
      const existing = thread.swarm.agents.find((agent) => agent.agentId === decoded.agentId);
      const nextAgent = {
        agentId: decoded.agentId,
        status: liveAgent.status,
        updatedAt: liveAgent.updatedAt,
        lastError: liveAgent.lastError,
      };
      const agents = existing
        ? thread.swarm.agents.map((agent) =>
            agent.agentId === decoded.agentId ? nextAgent : agent,
          )
        : [...thread.swarm.agents, nextAgent];
      return {
        ...thread,
        swarm: {
          ...thread.swarm,
          agents,
        },
      };
    }),
  };
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const threads = updateThread(state.threads, threadId, (thread) => {
    const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
    if (
      Number.isFinite(previousVisitedAtMs) &&
      Number.isFinite(visitedAtMs) &&
      previousVisitedAtMs >= visitedAtMs
    ) {
      return thread;
    }
    return { ...thread, lastVisitedAt: at };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    if (!thread.latestTurn?.completedAt) return thread;
    const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
    const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
    if (thread.lastVisitedAt === unreadVisitedAt) return thread;
    return { ...thread, lastVisitedAt: unreadVisitedAt };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function toggleProject(state: AppState, projectId: Project["id"]): AppState {
  return {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, expanded: !p.expanded } : p)),
  };
}

export function setProjectExpanded(
  state: AppState,
  projectId: Project["id"],
  expanded: boolean,
): AppState {
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId || p.expanded === expanded) return p;
    changed = true;
    return { ...p, expanded };
  });
  return changed ? { ...state, projects } : state;
}

export function reorderProjects(
  state: AppState,
  draggedProjectId: Project["id"],
  targetProjectId: Project["id"],
): AppState {
  if (draggedProjectId === targetProjectId) return state;
  const draggedIndex = state.projects.findIndex((project) => project.id === draggedProjectId);
  const targetIndex = state.projects.findIndex((project) => project.id === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) return state;
  const projects = [...state.projects];
  const [draggedProject] = projects.splice(draggedIndex, 1);
  if (!draggedProject) return state;
  projects.splice(targetIndex, 0, draggedProject);
  return { ...state, projects };
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyDomainEvent: (event: OrchestrationEvent) => void;
  applyProviderRuntimeEvent: (event: ProviderRuntimeEvent) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"]) => void;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  reorderProjects: (draggedProjectId: Project["id"], targetProjectId: Project["id"]) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(),
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyDomainEvent: (event) => set((state) => applyOrchestrationDomainEvent(state, event)),
  applyProviderRuntimeEvent: (event) => set((state) => applyProviderRuntimeEvent(state, event)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) => set((state) => markThreadUnread(state, threadId)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
}));

// Persist state changes with debouncing to avoid localStorage thrashing
useStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

// Flush pending writes synchronously before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistState(useStore.getState());
  }, []);
  return createElement(Fragment, null, children);
}
