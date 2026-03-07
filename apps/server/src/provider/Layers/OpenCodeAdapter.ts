import {
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import { createServer } from "node:net";
import { Effect, Layer, Queue, Scope, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { resolveModelSlugForProvider } from "@t3tools/shared/model";

const PROVIDER = "opencode" as const;

type OpenCodeSubscriptionEvent = {
  readonly type?: string;
  readonly properties?: Record<string, unknown>;
};

type OpenCodeSubscription = {
  readonly stream: AsyncIterable<OpenCodeSubscriptionEvent>;
};

type OpenCodeInstance = {
  readonly client: {
    readonly config?: {
      get: (input: unknown) => Promise<unknown>;
    };
    readonly session: {
      create: (input: unknown) => Promise<{ data: { id: string } }>;
      prompt: (input: unknown) => Promise<unknown>;
      abort: (input: unknown) => Promise<unknown>;
      delete: (input: unknown) => Promise<unknown>;
    };
    readonly event: {
      subscribe: (input?: unknown) => Promise<OpenCodeSubscription>;
    };
  };
  readonly server: {
    close(): void;
  };
};

type SessionState = {
  readonly providerSessionId: string;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  updatedAt: string;
  cwd?: string;
  activeTurnId?: TurnId;
};

type ThreadTurnSnapshot = {
  readonly id: TurnId;
  readonly items: unknown[];
};

export interface OpenCodeAdapterLiveOptions {
  readonly createClient?: () => Promise<OpenCodeInstance>;
}

const OPENCODE_HOST = "127.0.0.1";
const OPENCODE_DEFAULT_PORT = 4096;
const OPENCODE_PORT_SCAN_ATTEMPTS = 20;

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function toRequestError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function checkPortAvailable(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, hostname, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(hostname: string, startPort: number): Promise<number> {
  for (let offset = 0; offset < OPENCODE_PORT_SCAN_ATTEMPTS; offset += 1) {
    const port = startPort + offset;
    const available = await checkPortAvailable(hostname, port);
    if (available) {
      return port;
    }
  }
  return startPort;
}

async function tryConnectExistingServer(
  hostname: string,
  port: number,
): Promise<OpenCodeInstance | null> {
  const baseUrl = `http://${hostname}:${port}`;
  const client = createOpencodeClient({ baseUrl, throwOnError: true }) as unknown as OpenCodeInstance["client"];
  try {
    const maybeGlobal = client as unknown as { global?: { health?: (input?: unknown) => Promise<unknown> } };
    if (maybeGlobal.global?.health) {
      await maybeGlobal.global.health({});
      return {
        client,
        server: {
          close() {},
        },
      };
    }
    if (!client.config?.get) {
      return null;
    }
    await client.config.get({});
    return {
      client,
      server: {
        close() {},
      },
    };
  } catch {
    return null;
  }
}

function parseProviderModel(model: string): Effect.Effect<{ providerID: string; modelID: string }, ProviderAdapterValidationError> {
  const [providerID, ...rest] = model.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) {
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Invalid OpenCode model '${model}'. Expected 'provider/model'.`,
      }),
    );
  }
  return Effect.succeed({ providerID, modelID });
}

function resolveEventSessionId(event: {
  properties?: Record<string, unknown>;
}): string | undefined {
  const properties = event.properties;
  if (!properties) return undefined;

  const directSessionId = properties.sessionID;
  if (typeof directSessionId === "string") {
    return directSessionId;
  }

  const info = properties.info as { id?: string; sessionID?: string } | undefined;
  if (info?.id && typeof info.id === "string") {
    return info.id;
  }
  if (info?.sessionID && typeof info.sessionID === "string") {
    return info.sessionID;
  }

  const part = properties.part as { sessionID?: string } | undefined;
  if (part?.sessionID && typeof part.sessionID === "string") {
    return part.sessionID;
  }

  return undefined;
}

function baseEvent(threadId: ThreadId): Pick<ProviderRuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt"> {
  return {
    eventId: EventId.makeUnsafe(`evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    provider: PROVIDER,
    threadId,
    createdAt: nowIso(),
  };
}

const unavailableAdapter = (
  startupError: ProviderAdapterProcessError,
): OpenCodeAdapterShape => ({
  provider: PROVIDER,
  capabilities: { sessionModelSwitch: "unsupported" },
  startSession: (input) =>
    Effect.fail(
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: input.threadId,
        detail: startupError.detail,
        cause: startupError,
      }),
    ),
  sendTurn: (input) =>
    Effect.fail(
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: input.threadId,
        detail: startupError.detail,
        cause: startupError,
      }),
    ),
  interruptTurn: (threadId) =>
    Effect.fail(
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: startupError.detail,
        cause: startupError,
      }),
    ),
  respondToRequest: (threadId) =>
    Effect.fail(
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: startupError.detail,
        cause: startupError,
      }),
    ),
  respondToUserInput: (threadId) =>
    Effect.fail(
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: startupError.detail,
        cause: startupError,
      }),
    ),
  stopSession: (threadId) =>
    Effect.fail(
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: startupError.detail,
        cause: startupError,
      }),
    ),
  listSessions: () => Effect.succeed([]),
  hasSession: () => Effect.succeed(false),
  readThread: (threadId) =>
    Effect.fail(
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: startupError.detail,
        cause: startupError,
      }),
    ),
  rollbackThread: (threadId) =>
    Effect.fail(
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: startupError.detail,
        cause: startupError,
      }),
    ),
  stopAll: () => Effect.void,
  streamEvents: Stream.empty,
});

function isUnavailableOpenCodeAdapter(
  value: OpenCodeInstance | OpenCodeAdapterShape,
): value is OpenCodeAdapterShape {
  return "capabilities" in value && value.capabilities.sessionModelSwitch === "unsupported";
}

const makeOpenCodeAdapter = (
  options?: OpenCodeAdapterLiveOptions,
): Effect.Effect<OpenCodeAdapterShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.tryPromise({
      try: () =>
        (options?.createClient
          ? options.createClient()
          : (async () => {
              const existing = await tryConnectExistingServer(
                OPENCODE_HOST,
                OPENCODE_DEFAULT_PORT,
              );
              if (existing) {
                return existing;
              }
              const port = await findAvailablePort(OPENCODE_HOST, OPENCODE_DEFAULT_PORT);
              return createOpencode({ hostname: OPENCODE_HOST, port }) as unknown as Promise<OpenCodeInstance>;
            })()),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: ThreadId.makeUnsafe("startup"),
          detail: toMessage(cause, "Failed to start OpenCode SDK runtime."),
          cause,
        }),
    }).pipe(
      Effect.catch((startupError) =>
        Effect.logWarning("OpenCode runtime unavailable; adapter disabled", {
          detail: startupError.detail,
        }).pipe(Effect.as(unavailableAdapter(startupError))),
      ),
    );

    if (isUnavailableOpenCodeAdapter(runtime)) {
      return runtime;
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        runtime.server.close();
      }),
    );

    const client = runtime.client;
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionState>();
    const snapshots = new Map<ThreadId, ThreadTurnSnapshot[]>();

    const getSession = (threadId: ThreadId): Effect.Effect<SessionState, ProviderAdapterError> => {
      const session = sessions.get(threadId);
      if (!session) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(session);
    };

    const startSession: OpenCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const created = yield* Effect.tryPromise({
          try: () =>
            client.session.create({
              throwOnError: true,
              body: { title: input.threadId },
              ...(input.cwd ? { query: { directory: input.cwd } } : {}),
            }),
          catch: (cause) => toRequestError("session.create", cause),
        });

        const providerSessionId = created.data.id;
        const at = nowIso();
        const state: SessionState = {
          providerSessionId,
          threadId: input.threadId,
          createdAt: at,
          updatedAt: at,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        };
        sessions.set(input.threadId, state);
        snapshots.set(input.threadId, []);

        yield* Queue.offer(queue, {
          ...baseEvent(input.threadId),
          type: "session.started",
          payload: { message: "OpenCode session created" },
        });
        yield* Queue.offer(queue, {
          ...baseEvent(input.threadId),
          type: "thread.started",
          payload: { providerThreadId: providerSessionId },
        });

        return {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          createdAt: at,
          updatedAt: at,
          resumeCursor: { providerSessionId },
          ...(input.model ? { model: resolveModelSlugForProvider(PROVIDER, input.model) } : {}),
        };
      });

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const session = yield* getSession(input.threadId);
        const turnId = TurnId.makeUnsafe(`turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        session.activeTurnId = turnId;
        session.updatedAt = nowIso();

        const resolvedModel = resolveModelSlugForProvider(PROVIDER, input.model);
        const model = yield* parseProviderModel(resolvedModel);
        const partTextById = new Map<string, string>();

        const turnList = snapshots.get(input.threadId) ?? [];
        turnList.push({ id: turnId, items: [] });
        snapshots.set(input.threadId, turnList);

        yield* Queue.offer(queue, {
          ...baseEvent(input.threadId),
          turnId,
          type: "turn.started",
          payload: { model: `${model.providerID}/${model.modelID}` },
        });

        const sessionCwd = session.cwd;
        const subscription = yield* Effect.tryPromise({
          try: () =>
            client.event.subscribe(
              sessionCwd ? { query: { directory: sessionCwd } } : undefined,
            ),
          catch: (cause) => toRequestError("event.subscribe", cause),
        });

        yield* Effect.tryPromise({
          try: () =>
            client.session.prompt({
              throwOnError: true,
              path: { id: session.providerSessionId },
              ...(sessionCwd ? { query: { directory: sessionCwd } } : {}),
              body: {
                model,
                parts: [{ type: "text", text: input.input ?? "" }],
              },
            }),
          catch: (cause) => toRequestError("session.prompt", cause),
        });

        const streamPump = Effect.tryPromise({
          try: async () => {
            for await (const sseEvent of subscription.stream) {
              const event = sseEvent as { type?: string; properties?: Record<string, unknown> };
              const eventSessionId = resolveEventSessionId(event);
              if (eventSessionId && eventSessionId !== session.providerSessionId) {
                continue;
              }
              if (event.type === "message.part.updated") {
                const part = event.properties?.part as {
                  id?: string;
                  type?: string;
                  tool?: string;
                  text?: string;
                  sessionID?: string;
                } | undefined;
                if (part?.type && part.type !== "text" && part.type !== "tool" && part.type !== "tool-call" && part.type !== "tool-result") {
                  continue;
                }
                const delta = event.properties?.delta as
                  | string
                  | { text?: string }
                  | { value?: string }
                  | undefined;
                const deltaText = (() => {
                  if (typeof delta === "string") {
                    return delta;
                  }
                  if (!delta || typeof delta !== "object") {
                    return undefined;
                  }
                  if ("text" in delta && typeof delta.text === "string") {
                    return delta.text;
                  }
                  if ("value" in delta && typeof delta.value === "string") {
                    return delta.value;
                  }
                  return undefined;
                })();
                if (part?.type === "text" && deltaText && deltaText.length > 0) {
                  await Effect.runPromise(
                    Queue.offer(queue, {
                      ...baseEvent(input.threadId),
                      turnId,
                      itemId: RuntimeItemId.makeUnsafe(part?.id ?? `item_${Date.now()}`),
                      type: "content.delta",
                      payload: { streamKind: "assistant_text", delta: deltaText },
                    }),
                  );
                  if (part?.id) {
                    const previous = partTextById.get(part.id) ?? "";
                    partTextById.set(part.id, `${previous}${deltaText}`);
                  }
                } else if (part?.type === "text" && typeof part?.text === "string" && part.text.length > 0) {
                  const partId = part.id ?? `item_${Date.now()}`;
                  const previous = partTextById.get(partId) ?? "";
                  const nextText = part.text;
                  const nextDelta =
                    nextText.startsWith(previous) ? nextText.slice(previous.length) : nextText;
                  if (nextDelta.length > 0) {
                    await Effect.runPromise(
                      Queue.offer(queue, {
                        ...baseEvent(input.threadId),
                        turnId,
                        itemId: RuntimeItemId.makeUnsafe(partId),
                        type: "content.delta",
                        payload: { streamKind: "assistant_text", delta: nextDelta },
                      }),
                    );
                    partTextById.set(partId, nextText);
                  }
                }
                if (part?.type === "tool" || part?.type === "tool-call") {
                  await Effect.runPromise(
                    Queue.offer(queue, {
                      ...baseEvent(input.threadId),
                      turnId,
                      itemId: RuntimeItemId.makeUnsafe(part?.id ?? `tool_${Date.now()}`),
                      type: "item.started",
                      payload: {
                        itemType: "dynamic_tool_call",
                        title: part.tool ?? "Tool call",
                        data: event.properties,
                      },
                    }),
                  );
                }
                if (part?.type === "tool-result") {
                  await Effect.runPromise(
                    Queue.offer(queue, {
                      ...baseEvent(input.threadId),
                      turnId,
                      itemId: RuntimeItemId.makeUnsafe(part?.id ?? `tool_${Date.now()}`),
                      type: "item.completed",
                      payload: {
                        itemType: "dynamic_tool_call",
                        status: "completed",
                        detail: "Tool result",
                        data: event.properties,
                      },
                    }),
                  );
                }
              }

              if (event.type === "session.updated" || event.type === "session.idle") {
                await Effect.runPromise(
                  Queue.offer(queue, {
                    ...baseEvent(input.threadId),
                    turnId,
                    type: "turn.completed",
                    payload: { state: "completed" },
                  }),
                );
                delete session.activeTurnId;
                break;
              }

              if (event.type === "session.error") {
                await Effect.runPromise(
                  Queue.offer(queue, {
                    ...baseEvent(input.threadId),
                    turnId,
                    type: "turn.completed",
                    payload: {
                      state: "failed",
                      errorMessage: "OpenCode session error",
                    },
                  }),
                );
                delete session.activeTurnId;
                break;
              }
            }
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "event.subscribe.stream",
              detail: toMessage(cause, "OpenCode event stream failed."),
              cause,
            }),
        }).pipe(Effect.ignore);

        yield* Effect.sync(() => {
          Effect.runFork(streamPump);
        });

        return {
          threadId: input.threadId,
          turnId,
        };
      });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const session = yield* getSession(threadId);
        yield* Effect.tryPromise({
          try: () => client.session.abort({ throwOnError: true, path: { id: session.providerSessionId } }),
          catch: (cause) => toRequestError("session.abort", cause),
        });
        delete session.activeTurnId;
      });

    const readThread: OpenCodeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        yield* getSession(threadId);
        return {
          threadId,
          turns: snapshots.get(threadId) ?? [],
        };
      });

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* getSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const turns = snapshots.get(threadId) ?? [];
        const nextTurns = turns.slice(0, Math.max(0, turns.length - numTurns));
        snapshots.set(threadId, nextTurns);
        return {
          threadId,
          turns: nextTurns,
        };
      });

    const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const session = yield* getSession(threadId);
        yield* Effect.tryPromise({
          try: () => client.session.delete({ throwOnError: true, path: { id: session.providerSessionId } }),
          catch: (cause) => toRequestError("session.delete", cause),
        });
        sessions.delete(threadId);
      });

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        [...sessions.values()].map((session) => ({
          provider: PROVIDER,
          status: session.activeTurnId ? ("running" as const) : ("ready" as const),
          runtimeMode: "full-access" as const,
          threadId: session.threadId,
          activeTurnId: session.activeTurnId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          resumeCursor: { providerSessionId: session.providerSessionId },
        })),
      );

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        sessions.clear();
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(queue),
    } satisfies OpenCodeAdapterShape;
  });

export const OpenCodeAdapterLive = Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter());

export function makeOpenCodeAdapterLive(
  options?: OpenCodeAdapterLiveOptions,
): Layer.Layer<OpenCodeAdapter, never, never> {
  return Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter(options));
}
