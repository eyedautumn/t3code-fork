/**
 * OpencodeAdapterLive - Live implementation for the Opencode provider adapter.
 *
 * Wraps Opencode SDK client behind the ProviderAdapter service contract.
 * Automatically starts the OpenCode server if not already running.
 *
 * Uses the OpenCode SDK's SSE streaming API (`client.event.list()`) to receive
 * real-time events. The adapter subscribes to the event stream *before* calling
 * `session.prompt()` (fire-and-forget via promptAsync-style usage) so that no
 * events are missed. Events are filtered by sessionID and mapped to the
 * ProviderRuntimeEvent contract.
 *
 * The SSE stream is GLOBAL (not session-scoped). The OpenCode server exposes
 * `/event` (project-level) and `/global/event` (global-level) SSE endpoints.
 * There is no per-session SSE endpoint, so we must filter events client-side
 * by comparing the `sessionID` property on each event against our known session.
 *
 * Event types handled from the OpenCode SSE stream:
 *   - message.part.updated  → content.delta (incremental text via part content)
 *   - message.updated       → item.completed (full message received)
 *   - session.idle          → turn.completed  (session finished processing)
 *   - session.error         → runtime.error
 *   - permission.asked      → (future: approval request forwarding)
 *
 * SDK variants:
 *   - Stainless-generated SDK (`new Opencode()`): uses `client.event.list()`
 *     returning an async iterable. Cancel via `stream.controller.abort()`.
 *   - HeyApi-generated v2 SDK (`createOpencodeClient()`): uses
 *     `client.event.subscribe()`. Cancel via aborting the underlying fetch.
 *   Both are supported via fallback detection in `subscribeToEventStream()`.
 *
 * EventListResponse shape (both SDK variants):
 *   Each yielded event has `type` and `properties` at the TOP level — they
 *   are NOT nested under a `.data` wrapper. The `properties` object contains
 *   event-specific data, including `sessionID` for session-scoped events.
 *
 * @module OpencodeAdapterLive
 */
import { Effect, Layer, Queue, Ref, Stream } from "effect";

import {
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  ProviderApprovalDecision,
  ThreadId,
  TurnId,
  EventId,
  RuntimeItemId,
} from "@t3tools/contracts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { OpencodeAdapter, type OpencodeAdapterShape } from "../Services/OpencodeAdapter.ts";
import type {
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSendTurnInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { AssistantMessage, Session } from "@opencode-ai/sdk";

const PROVIDER = "opencode" as const;

interface SdkResponse<T> {
  data: T;
  error?: unknown;
  request: Request;
  response: Response;
}

interface SessionState {
  threadId: ThreadId;
  sessionId: string;
  cwd?: string | undefined;
}

/**
 * Represents the state tracked for a single streaming turn so that the
 * fire-and-forget streaming fiber and the main `sendTurn` fiber can
 * coordinate completion.
 */
interface TurnStreamState {
  hasDelta: boolean;
  completed: boolean;
  itemCompleted: boolean;
  itemId: RuntimeItemId | null;
  /** Parent session plus any discovered child session IDs for this turn. */
  acceptedSessionIds: Set<string>;
  /** Per-part streaming state for delta reconstruction and stream-kind inference. */
  partStateById: Map<string, { text: string; type: string | null; hasDelta: boolean }>;
  /** Remaining prefix of the user prompt to strip if echoed by provider events. */
  promptEchoRemainder: string;
  /** Set to `true` once the session.idle event is received. */
  idle: boolean;
  /** Millisecond timestamp when the adapter first observed the idle transition. */
  idleStartedAt: number | null;
  /** Resolve callback – called from the streaming fiber to signal the turn is done. */
  resolve: () => void;
  /** The promise that resolves when the streaming turn finishes. */
  promise: Promise<void>;
}

/**
 * Represents a normalized OpenCode SSE event.
 *
 * The SDK's `EventListResponse` yields objects with `type` and `properties`
 * at the top level. This interface mirrors that shape after normalization.
 */
interface OpencodeStreamEvent {
  type: string;
  properties: Record<string, unknown>;
}

function makeTurnStreamState(promptInput: string): TurnStreamState {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return {
    hasDelta: false,
    completed: false,
    itemCompleted: false,
    itemId: null,
    acceptedSessionIds: new Set(),
    partStateById: new Map(),
    promptEchoRemainder: promptInput,
    idle: false,
    idleStartedAt: null,
    resolve,
    promise,
  };
}

const DEFAULT_OPEN_CODE_MODEL = "opencode/big-pickle";

function normalizeOpencodeModel(model: string | null | undefined): string {
  const trimmed = typeof model === "string" ? model.trim() : "";
  if (!trimmed) return DEFAULT_OPEN_CODE_MODEL;
  if (trimmed.startsWith("opencode/")) return trimmed;
  if (trimmed.includes("/")) return trimmed;
  return `opencode/${trimmed}`;
}

function readSessionTimeValue(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsedNumber = Number(raw);
    if (Number.isFinite(parsedNumber)) return parsedNumber;
    const parsedDate = Date.parse(raw);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  return 0;
}

function sessionSortTimestamp(session: Session): number {
  const candidate = session as unknown as {
    time?: { updated?: unknown; created?: unknown };
    info?: { time?: { updated?: unknown; created?: unknown } };
  };
  const directTime = candidate.time;
  const infoTime = candidate.info?.time;
  return Math.max(
    readSessionTimeValue(directTime?.updated),
    readSessionTimeValue(infoTime?.updated),
    readSessionTimeValue(directTime?.created),
    readSessionTimeValue(infoTime?.created),
  );
}

function selectMostRecentSessionByTitle(
  sessions: ReadonlyArray<Session>,
  expectedTitle: string,
): Session | undefined {
  const matches = sessions.filter((session) => session.title === expectedTitle);
  if (matches.length === 0) return undefined;
  return matches.toSorted(
    (left, right) => sessionSortTimestamp(right) - sessionSortTimestamp(left),
  )[0];
}

function selectSessionForThread(input: {
  sessions: ReadonlyArray<Session>;
  expectedTitle: string;
  resumeSessionId?: string | undefined;
}): Session | undefined {
  const titledSession = selectMostRecentSessionByTitle(input.sessions, input.expectedTitle);
  if (titledSession) {
    return titledSession;
  }
  if (!input.resumeSessionId) {
    return undefined;
  }
  return input.sessions.find((session) => session.id === input.resumeSessionId);
}

export interface OpencodeAdapterLiveOptions {
  readonly hostname?: string;
  readonly port?: number;
}

function makeEventId(): EventId {
  return EventId.makeUnsafe(crypto.randomUUID());
}

function makeIsoDateTime(): string {
  return new Date().toISOString();
}

function toRuntimeStreamKind(
  rawPartType: unknown,
  options?: { role?: string | undefined },
): "assistant_text" | "reasoning_text" | "unknown" {
  const partType = typeof rawPartType === "string" ? rawPartType : "";
  if (partType === "thinking" || partType === "reasoning") return "reasoning_text";
  if (partType === "text") return "assistant_text";
  if ((options?.role ?? "") === "assistant") {
    return "assistant_text";
  }
  return "unknown";
}

function finalizeTurnFromIdle(
  threadId: ThreadId,
  turnId: TurnId,
  streamState: TurnStreamState,
): ProviderRuntimeEvent[] {
  if (!streamState.idle || streamState.completed) {
    return [];
  }

  streamState.completed = true;
  const itemId = streamState.itemId ?? undefined;
  const out: ProviderRuntimeEvent[] = [];

  if (!streamState.itemCompleted && (itemId || streamState.hasDelta)) {
    streamState.itemCompleted = true;
    out.push(
      makeEvent("item.completed", threadId, turnId, itemId, {
        itemType: "assistant_message",
      }),
    );
  }

  out.push(
    makeEvent("turn.completed", threadId, turnId, undefined, {
      state: "completed",
      stopReason: "end_turn",
      usage: null,
    }),
  );

  return out;
}

/**
 * Normalizes a raw SSE event from the OpenCode SDK into our internal
 * `OpencodeStreamEvent` shape.
 *
 * The `EventListResponse` yielded by `client.event.list()` (Stainless SDK)
 * or `client.event.subscribe()` (HeyApi v2 SDK) has `type` and `properties`
 * at the TOP LEVEL of the object — they are NOT nested under a `.data` wrapper.
 *
 * We handle a few possible layouts defensively:
 *   1. `{ type, properties }` — standard EventListResponse (expected)
 *   2. `{ data: { type, properties } }` — legacy / wrapper (unlikely but safe)
 *   3. `{ type, properties: { ... } }` where properties may contain nested
 *      objects like `message`, `part`, etc.
 */
function normalizeOpencodeStreamEvent(event: unknown): OpencodeStreamEvent | null {
  if (!event || typeof event !== "object") return null;

  const source = event as Record<string, unknown>;

  // ── Primary path: `type` and `properties` at top level ──
  if (typeof source.type === "string" && source.type !== "") {
    const properties =
      source.properties && typeof source.properties === "object"
        ? (source.properties as Record<string, unknown>)
        : {};
    return { type: source.type, properties };
  }

  // ── Fallback: some SDK wrappers nest under `.data` ──
  const inner =
    source.data && typeof source.data === "object"
      ? (source.data as Record<string, unknown>)
      : null;

  if (inner && typeof inner.type === "string" && inner.type !== "") {
    const properties =
      inner.properties && typeof inner.properties === "object"
        ? (inner.properties as Record<string, unknown>)
        : {};
    return { type: inner.type, properties };
  }

  return null;
}

function readOpencodeEventRole(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.role === "string") return properties.role;
  if (typeof properties.messageRole === "string") return properties.messageRole;

  const topInfo =
    properties.info && typeof properties.info === "object"
      ? (properties.info as Record<string, unknown>)
      : undefined;
  if (typeof topInfo?.role === "string") return topInfo.role;

  const message =
    properties.message && typeof properties.message === "object"
      ? (properties.message as Record<string, unknown>)
      : undefined;
  if (typeof message?.role === "string") return message.role;

  const info =
    message?.info && typeof message.info === "object"
      ? (message.info as Record<string, unknown>)
      : undefined;
  if (typeof info?.role === "string") return info.role;

  const part = properties.part as Record<string, unknown> | undefined;
  if (part && typeof part === "object") {
    if (typeof part.role === "string") return part.role;
    const partInfo =
      part.info && typeof part.info === "object"
        ? (part.info as Record<string, unknown>)
        : undefined;
    if (typeof partInfo?.role === "string") return partInfo.role;
  }

  return undefined;
}

function isAssistantLikeRole(role: string | undefined): boolean {
  if (!role) return true;
  return role === "assistant";
}

function makePartStateKey(input: {
  messageId: string | undefined;
  partId: string | undefined;
  index?: number | undefined;
}): string | undefined {
  if (input.partId) return input.partId;
  if (input.messageId && input.index !== undefined) {
    return `${input.messageId}:${input.index}`;
  }
  if (input.messageId) return input.messageId;
  return undefined;
}

type OpencodeMessagePartSnapshot = {
  id: string | null;
  type: string | null;
  text: string;
};

function readOpencodeMessageParts(
  properties: Record<string, unknown>,
): OpencodeMessagePartSnapshot[] {
  const fromTopLevel = Array.isArray(properties.parts) ? properties.parts : null;
  const message =
    properties.message && typeof properties.message === "object"
      ? (properties.message as Record<string, unknown>)
      : null;
  const fromMessage = Array.isArray(message?.parts) ? message.parts : null;
  const parts = fromTopLevel ?? fromMessage;
  if (!parts) return [];

  return parts.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const part = entry as Record<string, unknown>;
    const text = typeof part.text === "string" ? part.text : "";
    if (!text) {
      return [];
    }
    const id = typeof part.id === "string" ? part.id : `snapshot:${index}`;
    const type = typeof part.type === "string" ? part.type : null;
    return [{ id, type, text }];
  });
}

function stripPromptEchoPrefix(delta: string, streamState: TurnStreamState): string {
  const remainder = streamState.promptEchoRemainder;
  if (!remainder || !delta) return delta;

  if (remainder.startsWith(delta)) {
    streamState.promptEchoRemainder = remainder.slice(delta.length);
    return "";
  }

  if (delta.startsWith(remainder)) {
    streamState.promptEchoRemainder = "";
    return delta.slice(remainder.length);
  }

  streamState.promptEchoRemainder = "";
  return delta;
}

function readResumeSessionId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const cursor = resumeCursor as Record<string, unknown>;
  if (typeof cursor.sessionId === "string" && cursor.sessionId.trim().length > 0) {
    return cursor.sessionId;
  }
  if (typeof cursor.id === "string" && cursor.id.trim().length > 0) {
    return cursor.id;
  }
  return undefined;
}

/**
 * Closes an SSE stream subscription. The Stainless-generated SDK exposes
 * `stream.controller.abort()` as the canonical cancellation mechanism.
 * We also handle the HeyApi v2 pattern and any legacy `.close()` method.
 */
async function closeSubscription(subscription: any) {
  try {
    // Stainless SDK: stream.controller.abort()
    if (subscription?.controller?.abort) {
      subscription.controller.abort();
    } else if (subscription?.close) {
      await subscription.close();
    } else if (subscription?.stream?.return) {
      await subscription.stream.return(undefined);
    }
  } catch {
    // ignore – best-effort cleanup
  }
}

function makeEvent(
  type:
    | "session.started"
    | "session.configured"
    | "session.exited"
    | "turn.started"
    | "turn.completed"
    | "turn.aborted"
    | "item.completed"
    | "content.delta"
    | "request.resolved"
    | "runtime.error",
  threadId: ThreadId,
  turnId?: TurnId,
  itemId?: RuntimeItemId,
  payload?: Record<string, unknown>,
): ProviderRuntimeEvent {
  const event: Record<string, unknown> = {
    eventId: makeEventId(),
    provider: PROVIDER,
    threadId,
    createdAt: makeIsoDateTime(),
    turnId,
    itemId,
    type,
    payload: payload ?? {},
  };
  return event as unknown as ProviderRuntimeEvent;
}

async function waitForServer(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://${hostname}:${port}/global/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startOpencodeServer(hostname: string, port: number): Promise<void> {
  const { spawn } = await import("child_process");

  const opencodePath = process.env.NVM_DIR
    ? `${process.env.NVM_DIR}/versions/node/v22.18.0/bin/opencode`
    : "opencode";

  const proc = spawn(opencodePath, ["serve", "--port", String(port), "--hostname", hostname], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env },
  });

  proc.unref();

  const started = await waitForServer(hostname, port, 30000);
  if (!started) {
    throw new Error("Failed to start OpenCode server within 30 seconds");
  }
}

async function getOrCreateClient(hostname: string, port: number): Promise<any> {
  try {
    const response = await fetch(`http://${hostname}:${port}/global/health`);
    if (response.ok) {
      const sdk = await import("@opencode-ai/sdk");
      return sdk.createOpencodeClient({
        baseUrl: `http://${hostname}:${port}`,
      });
    }
  } catch {
    // Server not running, start it
  }

  await startOpencodeServer(hostname, port);
  const sdk = await import("@opencode-ai/sdk");
  return sdk.createOpencodeClient({
    baseUrl: `http://${hostname}:${port}`,
  });
}

// ---------------------------------------------------------------------------
// SSE Event → ProviderRuntimeEvent mapping
// ---------------------------------------------------------------------------

/**
 * Extracts the `sessionID` from an event's properties.
 *
 * The OpenCode server uses `sessionID` (capital "ID") as the canonical field
 * name in event properties (matching the Go SDK's naming convention). We also
 * check `sessionId` for safety, but `sessionID` is the primary.
 */
function extractSessionId(props: Record<string, unknown>): string | undefined {
  // Primary: OpenCode canonical field name
  if (typeof props.sessionID === "string") return props.sessionID;
  // Fallback: alternate casing
  if (typeof props.sessionId === "string") return props.sessionId;
  // Fallback: snake_case (very unlikely, but defensive)
  if (typeof props.session_id === "string") return props.session_id;

  // Some events nest session info inside a `message` or `session` object
  const message = props.message as Record<string, unknown> | undefined;
  if (message && typeof message === "object") {
    if (typeof message.sessionID === "string") return message.sessionID;
    if (typeof message.sessionId === "string") return message.sessionId;
  }
  const session = props.session as Record<string, unknown> | undefined;
  if (session && typeof session === "object") {
    if (typeof session.id === "string") return session.id;
  }
  const part = props.part as Record<string, unknown> | undefined;
  if (part && typeof part === "object") {
    if (typeof part.sessionID === "string") return part.sessionID;
    if (typeof part.sessionId === "string") return part.sessionId;
  }
  const info = props.info as Record<string, unknown> | undefined;
  if (info && typeof info === "object") {
    if (typeof info.id === "string") return info.id;
    if (typeof info.sessionID === "string") return info.sessionID;
    if (typeof info.sessionId === "string") return info.sessionId;
  }

  return undefined;
}

function extractParentSessionId(props: Record<string, unknown>): string | undefined {
  if (typeof props.parentID === "string") return props.parentID;
  if (typeof props.parentId === "string") return props.parentId;
  if (typeof props.parent_id === "string") return props.parent_id;

  const session = props.session as Record<string, unknown> | undefined;
  if (session && typeof session === "object") {
    if (typeof session.parentID === "string") return session.parentID;
    if (typeof session.parentId === "string") return session.parentId;
  }

  const info = props.info as Record<string, unknown> | undefined;
  if (info && typeof info === "object") {
    if (typeof info.parentID === "string") return info.parentID;
    if (typeof info.parentId === "string") return info.parentId;
  }

  return undefined;
}

function extractSessionTitle(props: Record<string, unknown>): string | undefined {
  if (typeof props.title === "string") return props.title;

  const info = props.info as Record<string, unknown> | undefined;
  if (info && typeof info === "object" && typeof info.title === "string") {
    return info.title;
  }

  const session = props.session as Record<string, unknown> | undefined;
  if (session && typeof session === "object" && typeof session.title === "string") {
    return session.title;
  }

  return undefined;
}

/**
 * Extracts a message ID from event properties.
 *
 * OpenCode events use `messageID` (capital "ID") as the canonical field name.
 */
function extractMessageId(props: Record<string, unknown>): string | undefined {
  if (typeof props.messageID === "string") return props.messageID;
  if (typeof props.messageId === "string") return props.messageId;
  if (typeof props.message_id === "string") return props.message_id;
  if (typeof props.id === "string") return props.id;

  const message = props.message as Record<string, unknown> | undefined;
  if (message && typeof message === "object") {
    if (typeof message.id === "string") return message.id;
  }
  const part = props.part as Record<string, unknown> | undefined;
  if (part && typeof part === "object") {
    if (typeof part.messageID === "string") return part.messageID;
    if (typeof part.messageId === "string") return part.messageId;
  }
  const info = props.info as Record<string, unknown> | undefined;
  if (info && typeof info === "object" && typeof info.id === "string") {
    return info.id;
  }

  return undefined;
}

function extractPartId(props: Record<string, unknown>): string | undefined {
  if (typeof props.partID === "string") return props.partID;
  if (typeof props.partId === "string") return props.partId;
  if (typeof props.part_id === "string") return props.part_id;
  const part = props.part as Record<string, unknown> | undefined;
  if (part && typeof part === "object") {
    if (typeof part.id === "string") return part.id;
  }
  return undefined;
}

/**
 * Maps a single OpenCode SSE event (received via `client.event.list()`)
 * to zero or more ProviderRuntimeEvents.
 *
 * The SSE events carry a `type` and `properties` object at the top level
 * of the `EventListResponse`. The relevant event types for streaming a
 * turn are:
 *
 *   message.part.updated  – a part of a message was updated (contains delta or part text)
 *   message.updated       – a full message snapshot was persisted
 *   session.idle          – the session finished processing the prompt
 *   session.error         – an error occurred during processing
 *   permission.asked      – a tool needs approval (future work)
 */
function mapSseEventToRuntimeEvents(
  evt: unknown,
  sessionId: string,
  threadId: ThreadId,
  turnId: TurnId,
  streamState: TurnStreamState,
): ProviderRuntimeEvent[] {
  const out: ProviderRuntimeEvent[] = [];
  const normalized = normalizeOpencodeStreamEvent(evt);
  if (!normalized) return out;
  const type = normalized.type;
  const props = normalized.properties;

  if (streamState.acceptedSessionIds.size === 0) {
    streamState.acceptedSessionIds.add(sessionId);
  }

  // Only process events for *our* session.
  // The SSE stream is global — all sessions' events arrive on the same stream.
  const evtSessionId = extractSessionId(props);
  const evtParentSessionId = extractParentSessionId(props);
  const evtSessionTitle = extractSessionTitle(props);
  const expectedSessionTitle = `Session ${threadId}`;
  if (
    type === "session.updated" &&
    evtSessionId &&
    evtParentSessionId &&
    streamState.acceptedSessionIds.has(evtParentSessionId)
  ) {
    streamState.acceptedSessionIds.add(evtSessionId);
  }
  if (
    type === "session.updated" &&
    evtSessionId &&
    typeof evtSessionTitle === "string" &&
    evtSessionTitle.trim() === expectedSessionTitle
  ) {
    streamState.acceptedSessionIds.add(evtSessionId);
  }
  if (evtSessionId && !streamState.acceptedSessionIds.has(evtSessionId)) {
    return out;
  }

  switch (type) {
    // ── Incremental text delta (primary streaming signal) ───────────────
    case "message.part.delta": {
      if (streamState.idle) {
        streamState.idleStartedAt = Date.now();
      }
      const role = readOpencodeEventRole(props);
      if (!isAssistantLikeRole(role)) {
        break;
      }

      const messageId = extractMessageId(props);
      if (messageId && !streamState.itemId) {
        streamState.itemId = RuntimeItemId.makeUnsafe(messageId);
      }
      const itemId = streamState.itemId ?? undefined;

      const partId = extractPartId(props);
      const stateKey = makePartStateKey({ messageId, partId });
      const field = typeof props.field === "string" ? props.field : "";
      const delta = typeof props.delta === "string" ? props.delta : "";
      const existing = stateKey ? streamState.partStateById.get(stateKey) : undefined;
      const nextState = existing ?? { text: "", type: null, hasDelta: false };
      if (typeof props.partType === "string") {
        nextState.type = props.partType;
      }

      if (field === "text") {
        nextState.text = `${nextState.text}${delta}`;
        nextState.hasDelta = true;
        if (stateKey) {
          streamState.partStateById.set(stateKey, nextState);
        }
      }

      if (delta.length > 0) {
        streamState.hasDelta = true;
        const streamKind = toRuntimeStreamKind(nextState.type, { role });
        out.push(makeEvent("content.delta", threadId, turnId, itemId, { delta, streamKind }));
      }
      break;
    }

    // ── Full part snapshot (fallback sync) ─────────────────────────────
    case "message.part.updated": {
      if (streamState.idle) {
        streamState.idleStartedAt = Date.now();
      }
      const role = readOpencodeEventRole(props);
      if (!isAssistantLikeRole(role)) {
        break;
      }

      const messageId = extractMessageId(props);
      if (messageId && !streamState.itemId) {
        streamState.itemId = RuntimeItemId.makeUnsafe(messageId);
      }
      const itemId = streamState.itemId ?? undefined;

      const partRecord =
        props.part && typeof props.part === "object"
          ? (props.part as Record<string, unknown>)
          : undefined;
      const partId = typeof partRecord?.id === "string" ? partRecord.id : extractPartId(props);
      const stateKey = makePartStateKey({ messageId, partId });
      const partType = typeof partRecord?.type === "string" ? partRecord.type : null;
      const fullPartText =
        typeof partRecord?.text === "string"
          ? (partRecord.text as string)
          : typeof props.text === "string"
            ? props.text
            : "";

      if (!fullPartText) {
        if (stateKey && partType) {
          const existing = streamState.partStateById.get(stateKey) ?? {
            text: "",
            type: null,
            hasDelta: false,
          };
          existing.type = partType;
          streamState.partStateById.set(stateKey, existing);
        }
        break;
      }

      const state = stateKey
        ? (streamState.partStateById.get(stateKey) ?? { text: "", type: null, hasDelta: false })
        : { text: "", type: null, hasDelta: false };
      if (partType) {
        state.type = partType;
      }

      let delta = "";
      if (state.text && fullPartText.startsWith(state.text)) {
        delta = fullPartText.slice(state.text.length);
      } else if (!state.text) {
        delta = fullPartText;
      } else {
        delta = fullPartText;
      }

      state.text = fullPartText;
      if (stateKey) {
        streamState.partStateById.set(stateKey, state);
      }

      if (delta.length > 0) {
        streamState.hasDelta = true;
        const streamKind = toRuntimeStreamKind(state.type, { role });
        out.push(makeEvent("content.delta", threadId, turnId, itemId, { delta, streamKind }));
      }
      break;
    }

    // ── Full message snapshot persisted ─────────────────────────────────
    case "message.updated": {
      if (streamState.idle) {
        streamState.idleStartedAt = Date.now();
      }
      const messageId = extractMessageId(props);
      if (messageId && !streamState.itemId) {
        streamState.itemId = RuntimeItemId.makeUnsafe(messageId);
      }
      const itemId = streamState.itemId ?? undefined;

      const role = readOpencodeEventRole(props) ?? "";
      const info =
        props.info && typeof props.info === "object"
          ? (props.info as Record<string, unknown>)
          : undefined;
      const time =
        info?.time && typeof info.time === "object"
          ? (info.time as Record<string, unknown>)
          : undefined;
      const completedAt = time?.completed;
      const isCompleted =
        typeof completedAt === "number" ||
        typeof completedAt === "string" ||
        (typeof info?.finish === "string" && info.finish.length > 0);
      const parts = readOpencodeMessageParts(props);
      const shouldTreatAsAssistant = isAssistantLikeRole(role) && parts.length > 0;

      if (shouldTreatAsAssistant) {
        for (const [index, part] of parts.entries()) {
          const stateKey = makePartStateKey({
            messageId,
            partId: part.id ?? undefined,
            index,
          });
          if (!stateKey) {
            continue;
          }
          const state = streamState.partStateById.get(stateKey) ?? {
            text: "",
            type: null,
            hasDelta: false,
          };
          if (part.type) {
            state.type = part.type;
          }

          let delta = "";
          if (state.text && part.text.startsWith(state.text)) {
            delta = part.text.slice(state.text.length);
          } else if (!state.text) {
            delta = part.text;
          } else if (part.text !== state.text) {
            delta = part.text;
          }

          state.text = part.text;
          streamState.partStateById.set(stateKey, state);

          if (delta.length > 0) {
            streamState.hasDelta = true;
            out.push(
              makeEvent("content.delta", threadId, turnId, itemId, {
                delta,
                streamKind: toRuntimeStreamKind(state.type, { role }),
              }),
            );
          }
        }
      }

      if (shouldTreatAsAssistant && isCompleted && !streamState.itemCompleted) {
        streamState.itemCompleted = true;
        out.push(
          makeEvent("item.completed", threadId, turnId, itemId, {
            itemType: "assistant_message",
          }),
        );
      }
      break;
    }

    // ── Session finished processing (idle) ──────────────────────────────
    case "session.idle": {
      streamState.idle = true;
      streamState.idleStartedAt ??= Date.now();
      break;
    }

    // ── Session status change (busy → idle transition) ──────────────────
    case "session.status": {
      const statusValue = props.status;
      const status =
        typeof statusValue === "string"
          ? statusValue
          : statusValue && typeof statusValue === "object"
            ? typeof (statusValue as Record<string, unknown>).type === "string"
              ? ((statusValue as Record<string, unknown>).type as string)
              : ""
            : "";
      if (status === "idle" && !streamState.completed) {
        streamState.idle = true;
        streamState.idleStartedAt ??= Date.now();
      }
      break;
    }

    // ── Error ───────────────────────────────────────────────────────────
    case "session.error": {
      out.push(
        makeEvent("runtime.error", threadId, turnId, streamState.itemId ?? undefined, {
          message: props.error ?? props.message ?? "OpenCode runtime error",
        }),
      );
      // session.error is typically followed by session.idle, but we mark
      // completed here as well so the turn doesn't hang.
      if (!streamState.completed) {
        streamState.completed = true;
        out.push(
          makeEvent("turn.completed", threadId, turnId, undefined, {
            state: "completed",
            stopReason: "error",
            usage: null,
          }),
        );
      }
      break;
    }

    // ── Permission / approval request ───────────────────────────────────
    case "permission.asked": {
      // TODO: Forward as an approval-request event to the UI layer.
      // For now we log and ignore; the existing `respondToRequest` handler
      // will be called by the UI layer if it surfaces these.
      break;
    }

    default:
      // Ignore unknown / irrelevant event types (server.connected,
      // file.edited, lsp.updated, installation.updated, etc.)
      break;
  }

  return out;
}

export const __test = {
  finalizeTurnFromIdle,
  makeTurnStreamState,
  mapSseEventToRuntimeEventsForTest: mapSseEventToRuntimeEvents,
  selectSessionForThread,
  selectMostRecentSessionByTitle,
};

// ---------------------------------------------------------------------------
// Layer implementation
// ---------------------------------------------------------------------------

export const OpencodeAdapterLive = Layer.effect(
  OpencodeAdapter,
  Effect.gen(function* () {
    const hostname = "127.0.0.1";
    const port = 4096;

    const client = yield* Effect.tryPromise({
      try: () => getOrCreateClient(hostname, port),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: ThreadId.makeUnsafe("unknown"),
          detail: `Failed to start/connect to OpenCode server: ${cause instanceof Error ? cause.message : String(cause)}. Make sure 'opencode' is installed and in your PATH.`,
        }),
    });

    const sessionsRef = yield* Ref.make(new Map<ThreadId, SessionState>());
    const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    /** Tracks active SSE stream subscriptions per thread so they can be cancelled. */
    const subscriptionRef = yield* Ref.make(new Map<ThreadId, any>());
    const streamEvents = Stream.fromQueue(eventQueue);

    const clearActiveSubscription = (threadId: ThreadId) =>
      Ref.update(subscriptionRef, (m) => {
        const next = new Map(m);
        next.delete(threadId);
        return next;
      });

    const closeActiveSubscriptionForThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const subMap = yield* Ref.get(subscriptionRef);
        const sub = subMap.get(threadId);
        if (!sub) {
          return;
        }
        yield* Effect.promise(() => closeSubscription(sub));
        yield* clearActiveSubscription(threadId);
      });

    /**
     * Opens an SSE subscription to the OpenCode server's event stream using
     * the HeyAPI v2 SDK. Returns the async iterable + AbortController.
     */
    const subscribeToEventStream = async (): Promise<{
      stream: AsyncIterable<any>;
      controller: AbortController;
    }> => {
      const eventApi = (client as any)?.event;
      if (!eventApi || typeof eventApi !== "object" || typeof eventApi.subscribe !== "function") {
        throw new Error("OpenCode SDK event.subscribe() is unavailable.");
      }

      const controller = new AbortController();
      const events = await eventApi.subscribe({ signal: controller.signal });

      console.log(events, events.stream, events.stream[Symbol.asyncIterator]);

      if (!events?.stream || !events.stream[Symbol.asyncIterator]) {
        throw new Error("OpenCode subscribe() did not return events.stream");
      }

      const stream = events.stream;
      return { stream, controller };
    };

    // -----------------------------------------------------------------------
    // streamFromOpencode – the core SSE streaming loop
    // -----------------------------------------------------------------------

    /**
     * Opens an SSE subscription via `client.event.list()`, filters events
     * for the given `sessionId`, maps them to ProviderRuntimeEvents, and
     * pushes them onto the shared `eventQueue`.
     *
     * The loop terminates when:
     *   1. A `session.idle` or `session.status: idle` event is received, OR
     *   2. The subscription is aborted externally (interrupt / stop), OR
     *   3. An unrecoverable error occurs.
     *
     * This runs as a fire-and-forget fiber spawned from `sendTurn`.
     */
    const streamFromOpencode = (
      threadId: ThreadId,
      turnId: TurnId,
      sessionId: string,
      subscription: { stream: AsyncIterable<any>; controller: AbortController },
      streamState: TurnStreamState,
    ): Effect.Effect<void, never> =>
      Effect.promise(async () => {
        const IDLE_FLUSH_GRACE_WITH_TEXT_MS = 200;
        const IDLE_FLUSH_GRACE_BEFORE_TEXT_MS = 2_000;
        try {
          const iterator = subscription.stream[Symbol.asyncIterator]();

          while (true) {
            const idleFlushGraceMs = streamState.hasDelta
              ? IDLE_FLUSH_GRACE_WITH_TEXT_MS
              : IDLE_FLUSH_GRACE_BEFORE_TEXT_MS;
            if (streamState.idle && !streamState.completed) {
              streamState.idleStartedAt ??= Date.now();
              const elapsedMs = Date.now() - streamState.idleStartedAt;
              if (elapsedMs >= idleFlushGraceMs) {
                for (const completionEvent of finalizeTurnFromIdle(threadId, turnId, streamState)) {
                  await Effect.runPromise(Queue.offer(eventQueue, completionEvent));
                }
                break;
              }
            }
            const nextResult = streamState.idle
              ? await Promise.race<IteratorResult<any> | { timedOut: true }>([
                  iterator.next(),
                  new Promise<{ timedOut: true }>((resolve) => {
                    const idleStart = streamState.idleStartedAt ?? Date.now();
                    const elapsedMs = Date.now() - idleStart;
                    const remainingMs = Math.max(0, idleFlushGraceMs - elapsedMs);
                    setTimeout(() => resolve({ timedOut: true }), remainingMs);
                  }),
                ])
              : await iterator.next();

            if ("timedOut" in nextResult) {
              for (const completionEvent of finalizeTurnFromIdle(threadId, turnId, streamState)) {
                await Effect.runPromise(Queue.offer(eventQueue, completionEvent));
              }
              break;
            }

            if (nextResult.done) {
              break;
            }

            const evt = nextResult.value;
            console.log("🟡 RAW EVENT:", JSON.stringify(evt, null, 2));
            const mapped = mapSseEventToRuntimeEvents(
              evt,
              sessionId,
              threadId,
              turnId,
              streamState,
            );

            for (const e of mapped) {
              let eventToPublish = e;
              if (e.type === "content.delta" && e.payload.streamKind === "assistant_text") {
                const filteredDelta = stripPromptEchoPrefix(e.payload.delta, streamState);
                if (!filteredDelta) {
                  continue;
                }
                eventToPublish = {
                  ...e,
                  payload: {
                    ...e.payload,
                    delta: filteredDelta,
                  },
                };
              }
              await Effect.runPromise(Queue.offer(eventQueue, eventToPublish));
            }

            // Once the turn is complete, break out of the loop.
            if (streamState.completed) {
              break;
            }
          }

          if (!streamState.completed) {
            for (const completionEvent of finalizeTurnFromIdle(threadId, turnId, streamState)) {
              await Effect.runPromise(Queue.offer(eventQueue, completionEvent));
            }
          }
        } catch (err) {
          // Emit a runtime.error event unless the stream was intentionally
          // aborted (which manifests as an AbortError).
          const isAbort = err instanceof DOMException && err.name === "AbortError";
          if (!isAbort) {
            await Effect.runPromise(
              Queue.offer(
                eventQueue,
                makeEvent("runtime.error", threadId, turnId, undefined, {
                  message: err instanceof Error ? err.message : String(err),
                }),
              ),
            );
          }
          if (!streamState.completed) {
            streamState.completed = true;
            await Effect.runPromise(
              Queue.offer(
                eventQueue,
                makeEvent("turn.completed", threadId, turnId, undefined, {
                  state: "completed",
                  stopReason: isAbort ? "interrupted" : "error",
                  usage: null,
                }),
              ),
            );
          }
        } finally {
          await closeSubscription(subscription);
          streamState.resolve();
        }
      }).pipe(Effect.asVoid);

    // -----------------------------------------------------------------------
    // startSession
    // -----------------------------------------------------------------------

    const startSession = (
      input: ProviderSessionStartInput,
    ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      Effect.gen(function* () {
        const threadId = input.threadId;
        const createdAt = makeIsoDateTime();

        const normalizedModel = normalizeOpencodeModel(input.model);

        const modelSlug = normalizedModel.replace("opencode/", "");
        const modelConfig = { providerID: "opencode", modelID: modelSlug };

        const sessionList = yield* Effect.tryPromise({
          try: () => client.session.list() as Promise<SdkResponse<Array<Session>>>,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Failed to list sessions: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        const knownSessions = sessionList.data ?? [];

        const resumeSessionId = readResumeSessionId(input.resumeCursor);
        const selectedSession = selectSessionForThread({
          sessions: knownSessions,
          expectedTitle: `Session ${threadId}`,
          resumeSessionId,
        });

        const sessionId =
          selectedSession?.id ??
          (yield* Effect.tryPromise({
            try: async () => {
              const response = (await client.session.create({
                body: {
                  title: `Session ${threadId}`,
                  ...(modelConfig ? { model: modelConfig } : {}),
                } as any,
              })) as { data?: { id?: string } | undefined };
              const createdSessionId = response.data?.id;
              if (!createdSessionId) {
                throw new Error("Failed to create session: no session returned");
              }
              return createdSessionId;
            },
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: `Failed to create session: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          }));

        yield* Ref.update(sessionsRef, (map) => {
          const newMap = new Map(map);
          newMap.set(threadId, { threadId, sessionId, cwd: input.cwd });
          return newMap;
        });

        yield* Queue.offer(
          eventQueue,
          makeEvent("session.started", threadId, undefined, undefined, {
            message: "Session started",
            resume: null,
          }),
        );
        yield* Queue.offer(
          eventQueue,
          makeEvent("session.configured", threadId, undefined, undefined, { config: {} }),
        );

        return {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd,
          model: normalizedModel,
          threadId,
          resumeCursor: { sessionId },
          createdAt,
          updatedAt: createdAt,
        };
      });

    // -----------------------------------------------------------------------
    // sendTurn  –  the main streaming implementation
    // -----------------------------------------------------------------------

    const sendTurn = (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
      Effect.gen(function* () {
        const threadId = input.threadId;
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());

        // Look up the actual OpenCode session ID from our map
        const map = yield* Ref.get(sessionsRef);
        const sessionState = map.get(threadId);

        if (!sessionState) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
            cause: new Error("No session found"),
          });
        }

        const sessionId = sessionState.sessionId;
        const sessionCwd = sessionState.cwd;
        const normalizedModel = normalizeOpencodeModel(input.model);

        // Emit turn.started immediately
        yield* Queue.offer(
          eventQueue,
          makeEvent("turn.started", threadId, turnId, undefined, {
            model: normalizedModel,
            effort: null,
          }),
        );

        // Build the prompt body
        const promptInput = input.input ?? "";
        const promptBody: {
          parts: Array<{ type: string; text: string }>;
          system?: string;
        } = {
          parts: [{ type: "text", text: promptInput }],
        };

        let systemPrompt = "";
        if (sessionCwd) {
          systemPrompt += `## Working Directory\nYou MUST work in this directory: ${sessionCwd}\n\n`;
        }
        if (input.developerInstructions) {
          systemPrompt += input.developerInstructions;
        }
        if (systemPrompt) {
          promptBody.system = systemPrompt;
        }

        // ── Step 1: Subscribe to SSE stream BEFORE sending the prompt ──
        //
        // The SSE stream is global — all sessions' events arrive on the
        // same stream. We subscribe first so we don't miss any early
        // events that fire between the prompt request and the subscription
        // being established.

        // Enforce a single active stream per provider thread. Without this,
        // repeated turns on the same OpenCode session can leave stale
        // subscriptions alive and duplicate the same assistant events.
        yield* closeActiveSubscriptionForThread(threadId).pipe(Effect.ignore);

        const subscription = yield* Effect.try({
          try: () => subscribeToEventStream(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `SSE subscribe failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });

        // Track the subscription so it can be cancelled by interruptTurn
        yield* Ref.update(subscriptionRef, (m) => {
          const next = new Map(m);
          next.set(threadId, subscription);
          return next;
        });

        // Create the shared turn-level stream state
        const streamState = makeTurnStreamState(promptInput);

        // ── Step 2: Start the SSE streaming fiber (fire-and-forget) ──
        yield* Effect.sync(async () => {
          void Effect.runPromise(
            streamFromOpencode(threadId, turnId, sessionId, await subscription, streamState),
          );
        });

        // ── Step 3: Send the prompt (non-blocking – the SSE fiber handles events) ──
        //
        // Prefer `session.promptAsync()` if available so request/response
        // completion cannot delay streaming updates. Fall back to
        // `session.prompt()` on SDKs without the async endpoint.

        console.log("[OpenCodeAdapter] Sending prompt...");

        yield* Effect.tryPromise({
          try: () => {
            const sessionApi = (client as any)?.session;
            if (sessionApi && typeof sessionApi.promptAsync === "function") {
              return sessionApi.promptAsync({
                path: { id: sessionId },
                body: promptBody,
              } as any);
            }
            return client.session.prompt({
              path: { id: sessionId },
              body: promptBody,
            } as any) as Promise<SdkResponse<{ info: AssistantMessage }>>;
          },
          catch: (cause) => {
            // If the prompt fails, tear down the subscription.
            void closeSubscription(subscription);
            return new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Prompt failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            });
          },
        });

        // ── Step 4: Wait (with timeout) for the SSE stream to signal completion ──
        //
        // The streaming fiber resolves `streamState.promise` once a
        // terminal event (session.idle / session.error) is received, or
        // when the stream closes. We race this against a timeout so the
        // adapter doesn't hang forever.
        yield* Effect.tryPromise({
          try: () =>
            Promise.race([
              streamState.promise,
              new Promise<void>(
                (resolve) => setTimeout(() => resolve(), 120_000), // 2-minute safety timeout
              ),
            ]),
          catch: () => undefined as never,
        }).pipe(Effect.ignore);

        // ── Step 5: Fallback – if streaming didn't emit completion ──
        //
        // This can happen if the SSE stream ended before session.idle
        // (e.g. network blip, or the prompt completed before the
        // subscription was fully established in an edge case). We emit
        // a synthetic turn.completed so the caller isn't left hanging.
        if (!streamState.completed) {
          const fallbackItemId =
            streamState.itemId ?? RuntimeItemId.makeUnsafe(crypto.randomUUID());

          if (streamState.hasDelta || streamState.itemId) {
            yield* Queue.offer(
              eventQueue,
              makeEvent("item.completed", threadId, turnId, fallbackItemId, {
                itemType: "assistant_message",
              }),
            );
          }
          yield* Queue.offer(
            eventQueue,
            makeEvent("turn.completed", threadId, turnId, undefined, {
              state: "completed",
              stopReason: "end_turn",
              usage: null,
            }),
          );
          streamState.completed = true;
        }

        // Clean up subscription reference (may already be cleaned up by
        // the streaming fiber's `finally` block or by interruptTurn).
        yield* clearActiveSubscription(threadId);

        return { threadId, turnId, resumeCursor: { sessionId } };
      });

    // -----------------------------------------------------------------------
    // interruptTurn
    // -----------------------------------------------------------------------

    const interruptTurn = (
      threadId: ThreadId,
      _turnId?: TurnId,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionsRef);
        const sessionState = map.get(threadId);

        // Cancel the SSE subscription first
        yield* closeActiveSubscriptionForThread(threadId);

        if (!sessionState) {
          return;
        }

        // Tell the OpenCode server to abort the running prompt
        yield* Effect.tryPromise({
          try: () => client.session.abort({ path: { sessionID: sessionState.sessionId } } as any),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Abort failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });

        yield* Queue.offer(
          eventQueue,
          makeEvent("turn.aborted", threadId, _turnId, undefined, {
            reason: "User interrupted",
          }),
        );
      });

    // -----------------------------------------------------------------------
    // respondToRequest
    // -----------------------------------------------------------------------

    const respondToRequest = (
      threadId: ThreadId,
      requestId: import("@t3tools/contracts").ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionsRef);
        const sessionState = map.get(threadId);

        if (!sessionState) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
            cause: new Error("No session found"),
          });
        }

        const response =
          decision === "accept" || decision === "acceptForSession" ? "accept" : "decline";

        yield* Effect.tryPromise({
          try: () =>
            (client.session as any).permission({
              path: { sessionID: sessionState.sessionId, permissionID: requestId },
              body: { response },
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Permission response failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });

        yield* Queue.offer(
          eventQueue,
          makeEvent("request.resolved", threadId, undefined, undefined, {
            requestType: "command_execution_approval",
            decision:
              decision === "accept" || decision === "acceptForSession" ? "approved" : "denied",
          }),
        );
      });

    // -----------------------------------------------------------------------
    // respondToUserInput
    // -----------------------------------------------------------------------

    const respondToUserInput = (
      _threadId: ThreadId,
      _requestId: import("@t3tools/contracts").ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.fail(
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: ThreadId.makeUnsafe("unknown"),
          detail: "User input not implemented for OpenCode",
        }),
      );

    // -----------------------------------------------------------------------
    // stopSession
    // -----------------------------------------------------------------------

    const stopSession = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionsRef);
        const sessionState = map.get(threadId);

        // Cancel any active SSE subscription
        yield* closeActiveSubscriptionForThread(threadId);

        let sessionId = sessionState?.sessionId;
        if (!sessionId) {
          const response = yield* Effect.tryPromise({
            try: () => client.session.list() as Promise<SdkResponse<Array<Session>>>,
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: `List sessions failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
          const sessions = response.data ?? [];
          const matching = selectMostRecentSessionByTitle(sessions, `Session ${threadId}`);
          sessionId = matching?.id;
        }

        if (!sessionId) {
          return;
        }

        yield* Effect.tryPromise({
          try: () => client.session.delete({ path: { id: sessionId } }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Stop session failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });

        yield* Ref.update(sessionsRef, (m) => {
          const newMap = new Map(m);
          newMap.delete(threadId);
          return newMap;
        });

        yield* Queue.offer(
          eventQueue,
          makeEvent("session.exited", threadId, undefined, undefined, {
            reason: "Stopped by user",
            exitKind: "graceful",
          }),
        );
      });

    // -----------------------------------------------------------------------
    // listSessions
    // -----------------------------------------------------------------------

    const listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>, never> =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(sessionsRef);
        const now = makeIsoDateTime();

        if (snapshot.size > 0) {
          return Array.from(snapshot.values()).map((session) => ({
            provider: PROVIDER,
            status: "ready" as const,
            runtimeMode: "full-access" as const,
            threadId: session.threadId,
            cwd: session.cwd,
            model: DEFAULT_OPEN_CODE_MODEL,
            createdAt: now,
            updatedAt: now,
          }));
        }

        const response = yield* Effect.tryPromise({
          try: () => client.session.list() as Promise<SdkResponse<Array<Session>>>,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ThreadId.makeUnsafe("unknown"),
              detail: `List sessions failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        }).pipe(Effect.orDie);

        const sessions = response.data ?? [];

        return sessions.map((session: Session) => ({
          provider: PROVIDER,
          status: "ready" as const,
          runtimeMode: "full-access" as const,
          threadId: ThreadId.makeUnsafe(session.id),
          createdAt: now,
          updatedAt: now,
        }));
      });

    // -----------------------------------------------------------------------
    // hasSession
    // -----------------------------------------------------------------------

    const hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionsRef);
        return map.has(threadId);
      });

    // -----------------------------------------------------------------------
    // readThread
    // -----------------------------------------------------------------------

    const readThread = (
      threadId: ThreadId,
    ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionsRef);
        const sessionState = map.get(threadId);

        if (!sessionState) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
            cause: new Error("No session found"),
          });
        }

        const response = yield* Effect.tryPromise({
          try: () =>
            client.session.messages({
              path: { id: sessionState.sessionId },
              query: { limit: 100 },
            }) as Promise<
              SdkResponse<
                Array<{
                  info: { id: string; role: string };
                  parts: Array<{ type: string; text: string }>;
                }>
              >
            >,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Read thread failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });

        const messages = response.data ?? [];
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());

        return {
          threadId,
          turns: [
            {
              id: turnId,
              items: messages.map((m: any) => ({
                id: m.info.id,
                role: m.info.role,
                parts: m.parts,
              })),
            },
          ],
        };
      });

    // -----------------------------------------------------------------------
    // rollbackThread
    // -----------------------------------------------------------------------

    const rollbackThread = (
      threadId: ThreadId,
      numTurns: number,
    ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionsRef);
        const sessionState = map.get(threadId);

        if (!sessionState) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
            cause: new Error("No session found"),
          });
        }

        yield* Effect.tryPromise({
          try: () =>
            (client.session as any).revert({
              path: { id: sessionState.sessionId },
              body: { numTurns },
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Revert failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });

        return yield* readThread(threadId);
      });

    // -----------------------------------------------------------------------
    // stopAll
    // -----------------------------------------------------------------------

    const stopAll = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionsRef);
        const subMap = yield* Ref.get(subscriptionRef);

        // Cancel all active SSE subscriptions
        for (const sub of subMap.values()) {
          yield* Effect.promise(() => closeSubscription(sub)).pipe(Effect.ignore);
        }
        yield* Ref.set(subscriptionRef, new Map());

        // Delete all sessions
        for (const sessionState of map.values()) {
          yield* Effect.promise(() =>
            client.session.delete({ path: { id: sessionState.sessionId } }),
          ).pipe(Effect.ignore);
        }
        yield* Ref.set(sessionsRef, new Map());
      });

    // -----------------------------------------------------------------------
    // Return the adapter shape
    // -----------------------------------------------------------------------

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents,
    } satisfies OpencodeAdapterShape;
  }),
);

export function makeOpencodeAdapterLive(_options?: OpencodeAdapterLiveOptions) {
  return OpencodeAdapterLive;
}
