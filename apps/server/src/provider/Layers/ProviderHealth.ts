/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness probes when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import type {
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";

const DEFAULT_TIMEOUT_MS = 4_000;
const CODEX_PROVIDER = "codex" as const;
const OPENCODE_PROVIDER = "opencode" as const;

// ── Pure helpers ────────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCommandMissingCause(error: unknown, command: string): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes(`command not found: ${command}`) ||
    lower.includes(`spawn ${command} enoent`) ||
    lower.includes("enoent") ||
    lower.includes("notfound")
  );
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseAuthStatusFromOutput(result: CommandResult, providerName = "Codex"): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: `${providerName} CLI authentication status command is unavailable in this ${providerName} version.`,
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: `${providerName} CLI is not authenticated. Run ${providerName.toLowerCase()} login and try again.`,
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: `${providerName} CLI is not authenticated. Run ${providerName.toLowerCase()} login and try again.`,
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        `Could not verify ${providerName} authentication status from JSON output (missing auth marker).`,
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify ${providerName} authentication status. ${detail}`
      : `Could not verify ${providerName} authentication status.`,
  };
}

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const runProviderCommand = (commandName: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(commandName, [...args], {
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

// ── Health check ────────────────────────────────────────────────────

const checkProviderStatus = (input: {
  readonly provider: "codex" | "opencode";
  readonly cliName: string;
  readonly displayName: string;
}): Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();

    const versionProbe = yield* runProviderCommand(input.cliName, ["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: input.provider,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error, input.cliName)
          ? `${input.displayName} CLI (\`${input.cliName}\`) is not installed or not on PATH.`
          : `Failed to execute ${input.displayName} CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: input.provider,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: `${input.displayName} CLI is installed but failed to run. Timed out while running command.`,
      };
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: input.provider,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `${input.displayName} CLI is installed but failed to run. ${detail}`
          : `${input.displayName} CLI is installed but failed to run.`,
      };
    }

    const authProbe = yield* runProviderCommand(input.cliName, ["login", "status"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: input.provider,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify ${input.displayName} authentication status: ${error.message}.`
            : `Could not verify ${input.displayName} authentication status.`,
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: input.provider,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: `Could not verify ${input.displayName} authentication status. Timed out while running command.`,
      };
    }

    const parsed = parseAuthStatusFromOutput(authProbe.success.value, input.displayName);
    return {
      provider: input.provider,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkCodexProviderStatus = checkProviderStatus({
  provider: CODEX_PROVIDER,
  cliName: "codex",
  displayName: "Codex",
});

export const checkOpenCodeProviderStatus = checkProviderStatus({
  provider: OPENCODE_PROVIDER,
  cliName: "opencode",
  displayName: "OpenCode",
});

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const [codexStatus, openCodeStatus] = yield* Effect.all([
      checkCodexProviderStatus,
      checkOpenCodeProviderStatus,
    ]);
    return {
      getStatuses: Effect.succeed([codexStatus, openCodeStatus]),
    } satisfies ProviderHealthShape;
  }),
);
