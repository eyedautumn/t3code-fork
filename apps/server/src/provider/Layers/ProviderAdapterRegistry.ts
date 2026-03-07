/**
 * ProviderAdapterRegistryLive - In-memory provider adapter lookup layer.
 *
 * Binds provider kinds (codex/cursor/...) to concrete adapter services.
 * This layer only performs adapter lookup; it does not route session-scoped
 * calls or own provider lifecycle workflows.
 *
 * @module ProviderAdapterRegistryLive
 */
import { Effect, Layer, Stream } from "effect";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";

export interface ProviderAdapterRegistryLiveOptions {
  readonly adapters?: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
}

function makeOpenCodeAdapter(
  codexAdapter: ProviderAdapterShape<ProviderAdapterError>,
): ProviderAdapterShape<ProviderAdapterError> {
  return {
    provider: "opencode",
    capabilities: codexAdapter.capabilities,
    startSession: (input) =>
      codexAdapter.startSession({
        ...input,
        provider: "codex",
        providerOptions: {
          ...input.providerOptions,
          codex: {
            ...input.providerOptions?.codex,
            ...(input.providerOptions?.opencode ?? {}),
            binaryPath:
              input.providerOptions?.opencode?.binaryPath ??
              input.providerOptions?.codex?.binaryPath ??
              "opencode",
          },
        },
      }).pipe(Effect.map((session) => ({ ...session, provider: "opencode" as const }))),
    sendTurn: codexAdapter.sendTurn,
    interruptTurn: codexAdapter.interruptTurn,
    respondToRequest: codexAdapter.respondToRequest,
    respondToUserInput: codexAdapter.respondToUserInput,
    stopSession: codexAdapter.stopSession,
    listSessions: () =>
      codexAdapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({ ...session, provider: "opencode" as const })),
        ),
      ),
    hasSession: codexAdapter.hasSession,
    readThread: codexAdapter.readThread,
    rollbackThread: codexAdapter.rollbackThread,
    stopAll: codexAdapter.stopAll,
    streamEvents: Stream.map(codexAdapter.streamEvents, (event) => ({
      ...event,
      provider: "opencode" as const,
    })),
  };
}

const makeProviderAdapterRegistry = (options?: ProviderAdapterRegistryLiveOptions) =>
  Effect.gen(function* () {
    let adapters: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
    if (options?.adapters !== undefined) {
      adapters = options.adapters;
    } else {
      const codexAdapter = yield* CodexAdapter;
      adapters = [codexAdapter, makeOpenCodeAdapter(codexAdapter)] as const;
    }

    const byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));

    const getByProvider: ProviderAdapterRegistryShape["getByProvider"] = (provider) => {
      const adapter = byProvider.get(provider);
      if (!adapter) {
        return Effect.fail(new ProviderUnsupportedError({ provider }));
      }
      return Effect.succeed(adapter);
    };

    const listProviders: ProviderAdapterRegistryShape["listProviders"] = () =>
      Effect.sync(() => Array.from(byProvider.keys()));

    return {
      getByProvider,
      listProviders,
    } satisfies ProviderAdapterRegistryShape;
  });

export const ProviderAdapterRegistryLive = Layer.effect(
  ProviderAdapterRegistry,
  makeProviderAdapterRegistry(),
);
