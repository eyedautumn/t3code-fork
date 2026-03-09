import OS from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, FileSystem, Layer, Option, Result, Stream } from "effect";
import type { McpServerInfo } from "@t3tools/contracts";

import { buildCodexInitializeParams } from "../../codexAppServerManager";
import { McpServerManagerError } from "../Errors";
import { McpServerManager, type McpServerManagerShape } from "../Services/McpServerManager";

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

type JsonRpcError = {
  readonly message?: string;
};

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_APP_SERVER_TIMEOUT_MS = 20_000;
const DEFAULT_APP_SERVER_LIST_LIMIT = 200;
const MCP_STATUS_LIST_TIMEOUT_MS = 1_500;

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const resolveCodexHomePath = (input: string | undefined): string => {
  if (!input || input.trim().length === 0) {
    return path.join(OS.homedir(), ".codex");
  }
  const trimmed = input.trim();
  if (trimmed === "~") return OS.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(path.join(OS.homedir(), trimmed.slice(2)));
  }
  return path.resolve(trimmed);
};

const resolveCodexConfigPath = (input: string | undefined): string =>
  path.join(resolveCodexHomePath(input), "config.toml");

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const asStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const items = value.map(asTrimmedString).filter(Boolean) as string[];
  return items.length > 0 ? items : [];
};

const asNumber = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
};

const asBoolean = (value: unknown): boolean | null => {
  if (typeof value !== "boolean") return null;
  return value;
};

const normalizeMcpServer = (entry: Record<string, unknown>): McpServerInfo | null => {
  const name = asTrimmedString(entry.name);
  if (!name) return null;

  const transport = (entry.transport ?? {}) as Record<string, unknown>;
  const args = asStringArray(transport.args);
  const envVars = asStringArray(transport.env_vars);
  const transportType = asTrimmedString(transport.type) ?? "unknown";

  return {
    name,
    enabled: entry.enabled === true,
    ...(entry.disabled_reason !== undefined
      ? { disabledReason: (entry.disabled_reason as string | null) ?? null }
      : {}),
    transport: {
      type: transportType,
      ...(asTrimmedString(transport.command) ? { command: transport.command as string } : {}),
      ...(args ? { args } : {}),
      ...(asTrimmedString(transport.url) ? { url: transport.url as string } : {}),
      ...(transport.env !== undefined ? { env: transport.env } : {}),
      ...(envVars ? { envVars } : {}),
      ...(asTrimmedString(transport.cwd) || transport.cwd === null
        ? { cwd: (transport.cwd as string | null) ?? null }
        : {}),
    },
    ...(asTrimmedString(entry.auth_status) ? { authStatus: entry.auth_status as string } : {}),
    ...(entry.startup_timeout_sec !== undefined
      ? { startupTimeoutSec: (entry.startup_timeout_sec as number | null) ?? null }
      : {}),
    ...(entry.tool_timeout_sec !== undefined
      ? { toolTimeoutSec: (entry.tool_timeout_sec as number | null) ?? null }
      : {}),
  };
};

const normalizeMcpServerConfigEntry = (
  name: string,
  entry: Record<string, unknown>,
): McpServerInfo => {
  const enabled = entry.enabled === undefined ? true : entry.enabled === true;
  const command = asTrimmedString(entry.command);
  const url = asTrimmedString(entry.url);
  const args = asStringArray(entry.args);
  const envVars = asStringArray(entry.env_vars ?? entry.envVars);
  const cwdRaw = entry.cwd;
  const cwd = asTrimmedString(cwdRaw) ?? (cwdRaw === null ? null : undefined);
  const transport = asRecord(entry.transport) ?? {};
  const startupTimeoutSec =
    asNumber(entry.startup_timeout_sec ?? entry.startupTimeoutSec) ??
    (asNumber(entry.startup_timeout_ms ?? entry.startupTimeoutMs) !== null
      ? (asNumber(entry.startup_timeout_ms ?? entry.startupTimeoutMs) as number) / 1000
      : null);
  const toolTimeoutSec = asNumber(entry.tool_timeout_sec ?? entry.toolTimeoutSec);
  const transportType =
    asTrimmedString(transport.type) ?? (url ? "http" : command ? "stdio" : "unknown");

  return {
    name,
    enabled,
    transport: {
      type: transportType,
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      ...(url ? { url } : {}),
      ...(entry.env !== undefined ? { env: entry.env } : {}),
      ...(envVars ? { envVars } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    },
    ...(startupTimeoutSec !== null ? { startupTimeoutSec } : {}),
    ...(toolTimeoutSec !== null ? { toolTimeoutSec } : {}),
  };
};

const normalizeMcpServerStatusEntry = (
  entry: Record<string, unknown>,
): McpServerInfo | null => {
  const name =
    asTrimmedString(entry.name) ??
    asTrimmedString(entry.id) ??
    asTrimmedString(entry.server) ??
    asTrimmedString(entry.serverId);
  if (!name) return null;

  const config = asRecord(entry.config);
  const transport =
    asRecord(entry.transport) ??
    (config ? asRecord(config.transport) : null) ??
    asRecord(entry.connection) ??
    {};
  const command = asTrimmedString(transport.command ?? entry.command);
  const url = asTrimmedString(transport.url ?? entry.url);
  const args = asStringArray(transport.args ?? entry.args);
  const envVars = asStringArray(
    transport.env_vars ?? transport.envVars ?? entry.env_vars ?? entry.envVars,
  );
  const cwdRaw = transport.cwd ?? entry.cwd;
  const cwd = asTrimmedString(cwdRaw) ?? (cwdRaw === null ? null : undefined);
  const transportType =
    asTrimmedString(transport.type ?? entry.transportType ?? entry.type) ??
    (url ? "http" : command ? "stdio" : "unknown");

  const enabled =
    asBoolean(entry.enabled) ??
    (asBoolean(entry.disabled) !== null ? !asBoolean(entry.disabled) : null);

  return {
    name,
    enabled: enabled ?? true,
    ...(entry.disabled_reason !== undefined
      ? { disabledReason: (entry.disabled_reason as string | null) ?? null }
      : {}),
    ...(entry.disabledReason !== undefined
      ? { disabledReason: (entry.disabledReason as string | null) ?? null }
      : {}),
    transport: {
      type: transportType,
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      ...(url ? { url } : {}),
      ...(transport.env !== undefined ? { env: transport.env } : {}),
      ...(envVars ? { envVars } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    },
    ...(asTrimmedString(entry.auth_status) ? { authStatus: entry.auth_status as string } : {}),
    ...(asTrimmedString(entry.authStatus) ? { authStatus: entry.authStatus as string } : {}),
    ...(entry.startup_timeout_sec !== undefined
      ? { startupTimeoutSec: (entry.startup_timeout_sec as number | null) ?? null }
      : {}),
    ...(entry.startupTimeoutSec !== undefined
      ? { startupTimeoutSec: (entry.startupTimeoutSec as number | null) ?? null }
      : {}),
    ...(entry.tool_timeout_sec !== undefined
      ? { toolTimeoutSec: (entry.tool_timeout_sec as number | null) ?? null }
      : {}),
    ...(entry.toolTimeoutSec !== undefined
      ? { toolTimeoutSec: (entry.toolTimeoutSec as number | null) ?? null }
      : {}),
  };
};

const mergeMcpServerInfo = (
  base: McpServerInfo,
  override: Partial<McpServerInfo>,
): McpServerInfo => {
  const mergedTransport = {
    ...base.transport,
    ...override.transport,
  };
  return {
    ...base,
    ...override,
    transport: mergedTransport,
  };
};

const parseMcpServersFromConfig = (
  config: Record<string, unknown> | null,
): Map<string, McpServerInfo> => {
  const servers = new Map<string, McpServerInfo>();
  if (!config) return servers;
  const raw = config.mcp_servers ?? config.mcpServers;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const record = asRecord(entry);
      const name = record ? asTrimmedString(record.name) : null;
      if (!record || !name) continue;
      servers.set(name, normalizeMcpServerConfigEntry(name, record));
    }
    return servers;
  }
  const record = asRecord(raw);
  if (!record) return servers;
  for (const [name, value] of Object.entries(record)) {
    const entry = asRecord(value);
    if (!entry || !asTrimmedString(name)) continue;
    servers.set(name, normalizeMcpServerConfigEntry(name, entry));
  }
  return servers;
};

const extractConfigFromResponse = (response: unknown): Record<string, unknown> | null => {
  const record = asRecord(response);
  if (!record) return null;
  const config = asRecord(record.config);
  return config ?? record;
};

const extractListEntries = (response: unknown): unknown[] => {
  if (Array.isArray(response)) return response;
  const record = asRecord(response);
  if (!record) return [];
  const items = record.items ?? record.servers ?? record.mcpServers ?? record.results;
  return Array.isArray(items) ? items : [];
};

const extractNextCursor = (response: unknown): string | null => {
  const record = asRecord(response);
  if (!record) return null;
  return (
    asTrimmedString(record.nextCursor) ??
    asTrimmedString(record.next_cursor) ??
    asTrimmedString(record.cursor) ??
    asTrimmedString(record.next) ??
    null
  );
};

const killChildProcess = (child: ChildProcessWithoutNullStreams): void => {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fall through to direct kill
    }
  }
  child.kill();
};

const runCodexAppServerRpc = async <T>(input: {
  readonly codexHomePath?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly run: (
    sendRequest: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>,
  ) => Promise<T>;
}): Promise<T> => {
  const child = spawn("codex", ["app-server"], {
    cwd: input.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...(input.codexHomePath ? { CODEX_HOME: input.codexHomePath } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  const output = readline.createInterface({ input: child.stdout });
  const pending = new Map<
    string,
    {
      readonly method: string;
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timeout: NodeJS.Timeout;
    }
  >();
  let nextId = 1;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    output.close();
    for (const pendingRequest of pending.values()) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(new Error("Codex app-server stopped before request completed."));
    }
    pending.clear();
    if (child.stdin.writable) {
      child.stdin.end();
    }
    if (!child.killed) {
      killChildProcess(child);
    }
  };

  const writeMessage = (message: unknown) => {
    if (!child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const sendRequest = (method: string, params: unknown = {}, timeoutMs = input.timeoutMs) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timeout = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs ?? DEFAULT_APP_SERVER_TIMEOUT_MS);

      pending.set(String(id), {
        method,
        resolve,
        reject,
        timeout,
      });

      writeMessage({
        method,
        id,
        params,
      });
    });

  const handleResponse = (response: JsonRpcResponse) => {
    if (response.id === undefined || response.id === null) return;
    const pendingRequest = pending.get(String(response.id));
    if (!pendingRequest) return;
    clearTimeout(pendingRequest.timeout);
    pending.delete(String(response.id));
    if (response.error?.message) {
      pendingRequest.reject(new Error(`${pendingRequest.method} failed: ${response.error.message}`));
      return;
    }
    pendingRequest.resolve(response.result);
  };

  output.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcResponse;
      handleResponse(parsed);
    } catch {
      // Ignore non-JSON lines.
    }
  });

  child.on("error", (error) => {
    for (const pendingRequest of pending.values()) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(error);
    }
    pending.clear();
  });

  try {
    await sendRequest("initialize", buildCodexInitializeParams());
    writeMessage({ method: "initialized" });
    return await input.run(sendRequest);
  } finally {
    cleanup();
  }
};

const parseMcpListJson = (json: string): ReadonlyArray<McpServerInfo> => {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected MCP list to be a JSON array.");
  }
  const normalized = parsed
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
    .map(normalizeMcpServer)
    .filter(Boolean) as McpServerInfo[];
  return normalized;
};

const stripTomlComment = (line: string): string => {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inDoubleQuote) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === "\"" && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (char === "#" && !inSingleQuote && !inDoubleQuote) {
      return line.slice(0, i);
    }
  }

  return line;
};

const parseMcpSectionName = (line: string): string | null => {
  const cleaned = stripTomlComment(line);
  const match = cleaned.match(/^\\s*\\[(.+)]\\s*$/);
  if (!match) return null;
  const header = match[1]?.trim();
  if (!header || !header.startsWith("mcp_servers.")) return null;
  const rest = header.slice("mcp_servers.".length).trim();
  if (!rest) return null;
  const first = rest[0];
  if (first === "\"" || first === "'") {
    const end = rest.indexOf(first, 1);
    if (end === -1) return null;
    return rest.slice(1, end);
  }
  return rest;
};

const isTomlHeaderLine = (line: string): boolean => {
  const cleaned = stripTomlComment(line);
  return /^\\s*\\[\\[.+]]\\s*$/.test(cleaned) || /^\\s*\\[.+]\\s*$/.test(cleaned);
};

const isMcpArrayHeader = (line: string): boolean => {
  const cleaned = stripTomlComment(line);
  return /^\\s*\\[\\[\\s*mcp_servers\\s*]]\\s*$/.test(cleaned);
};

const parseMcpArrayName = (line: string): string | null => {
  const noComment = stripTomlComment(line);
  const match = noComment.match(/^\\s*name\\s*=\\s*(.+)\\s*$/);
  if (!match) return null;
  const raw = match[1]?.trim();
  if (!raw) return null;
  const first = raw[0];
  if ((first === "\"" || first === "'") && raw.length > 1) {
    const end = raw.indexOf(first, 1);
    if (end === -1) return null;
    return raw.slice(1, end);
  }
  return raw.split(/\\s+/)[0] ?? null;
};

const findSectionEnd = (lines: string[], start: number): number => {
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isTomlHeaderLine(lines[i] ?? "")) return i;
  }
  return lines.length;
};

const isMissingServerError = (cause: McpServerManagerError): boolean => {
  if (cause.message.includes("was not found in config")) return true;
  if (cause.cause instanceof Error) {
    return cause.cause.message.includes("was not found in config");
  }
  return false;
};

const setEnabledInToml = (input: string, name: string, enabled: boolean): string => {
  const lines = input.split("\\n");
  const endsWithNewline = input.endsWith("\\n");
  let sectionStart = -1;
  let sectionEnd = lines.length;
  let insertAfter = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const sectionName = parseMcpSectionName(lines[i] ?? "");
    if (!sectionName) continue;
    if (sectionName === name) {
      sectionStart = i;
      sectionEnd = findSectionEnd(lines, i);
      insertAfter = i;
      break;
    }
  }

  if (sectionStart === -1) {
    for (let i = 0; i < lines.length; i += 1) {
      if (!isMcpArrayHeader(lines[i] ?? "")) continue;
      const blockStart = i;
      const blockEnd = findSectionEnd(lines, i);
      let blockNameIndex = -1;
      let blockName: string | null = null;
      for (let j = blockStart + 1; j < blockEnd; j += 1) {
        const parsed = parseMcpArrayName(lines[j] ?? "");
        if (!parsed) continue;
        blockName = parsed;
        blockNameIndex = j;
        break;
      }
      if (blockName === name) {
        sectionStart = blockStart;
        sectionEnd = blockEnd;
        insertAfter = blockNameIndex !== -1 ? blockNameIndex : blockStart;
        break;
      }
    }
  }

  if (sectionStart === -1) {
    throw new Error(`MCP server '${name}' was not found in config.`);
  }

  let enabledLineIndex = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    const line = lines[i] ?? "";
    if (/^\\s*enabled\\s*=/.test(line)) {
      enabledLineIndex = i;
      break;
    }
  }

  const nextLine = `enabled = ${enabled ? "true" : "false"}`;
  if (enabledLineIndex !== -1) {
    lines[enabledLineIndex] = nextLine;
  } else {
    const insertIndex = insertAfter >= sectionStart ? insertAfter + 1 : sectionStart + 1;
    lines.splice(insertIndex, 0, nextLine);
  }

  const output = lines.join("\\n");
  return endsWithNewline ? `${output}\\n` : output;
};

const makeMcpServerManager = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runCodexCommand = (args: ReadonlyArray<string>, codexHomePath?: string) =>
    Effect.gen(function* () {
      const env = codexHomePath ? { ...process.env, CODEX_HOME: codexHomePath } : process.env;
      const command = ChildProcess.make("codex", [...args], {
        shell: process.platform === "win32",
        env,
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

  const listViaAppServer = (
    input: { readonly codexHomePath?: string },
  ): Effect.Effect<ReadonlyArray<McpServerInfo>, McpServerManagerError> =>
    Effect.tryPromise({
      try: async () => {
        const result = await runCodexAppServerRpc({
          ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
          run: async (sendRequest) => {
            const configResponse = await sendRequest("config/read", {});
            const config = extractConfigFromResponse(configResponse);
            const configServers = parseMcpServersFromConfig(config);

            const merged = new Map<string, McpServerInfo>(configServers);

            try {
              const statusEntries: Record<string, unknown>[] = [];
              let cursor: string | null = null;
              do {
                const response = await sendRequest(
                  "mcpServerStatus/list",
                  {
                    limit: DEFAULT_APP_SERVER_LIST_LIMIT,
                    ...(cursor ? { cursor } : {}),
                  },
                  MCP_STATUS_LIST_TIMEOUT_MS,
                );
                for (const entry of extractListEntries(response)) {
                  const record = asRecord(entry);
                  if (record) {
                    statusEntries.push(record);
                  }
                }
                cursor = extractNextCursor(response);
              } while (cursor);

              for (const entry of statusEntries) {
                const normalized = normalizeMcpServerStatusEntry(entry);
                if (!normalized) continue;
                const existing = merged.get(normalized.name);
                if (existing) {
                  merged.set(normalized.name, mergeMcpServerInfo(existing, normalized));
                } else {
                  merged.set(normalized.name, normalized);
                }
              }
            } catch {
              // `mcpServerStatus/list` is flaky on some Codex builds; keep config/read as truth.
            }

            return Array.from(merged.values());
          },
        });
        return result;
      },
      catch: (cause) =>
        new McpServerManagerError({
          message: "Failed to list MCP servers via Codex app-server.",
          cause,
        }),
    });

  const listViaCli: McpServerManagerShape["list"] = (input) =>
    Effect.gen(function* () {
      const codexHomePath = resolveCodexHomePath(input.codexHomePath);
      const listProbe = yield* runCodexCommand(["mcp", "list", "--json"], codexHomePath).pipe(
        Effect.timeoutOption(DEFAULT_COMMAND_TIMEOUT_MS),
        Effect.result,
      );

      if (Result.isFailure(listProbe)) {
        const error = listProbe.failure;
        return yield* new McpServerManagerError({
          message: `Failed to execute Codex MCP list: ${error instanceof Error ? error.message : String(error)}.`,
        });
      }

      if (Option.isNone(listProbe.success)) {
        return yield* new McpServerManagerError({
          message: "Codex MCP list command timed out.",
        });
      }

      const result = listProbe.success.value;
      if (result.code !== 0) {
        return yield* new McpServerManagerError({
          message: result.stderr.trim() || "Codex MCP list command failed.",
        });
      }

      return yield* Effect.try({
        try: () => parseMcpListJson(result.stdout),
        catch: (cause) =>
          new McpServerManagerError({
            message: "Failed to parse Codex MCP list response.",
            cause,
          }),
      });
    });

  const list: McpServerManagerShape["list"] = (input) =>
    listViaAppServer({ codexHomePath: resolveCodexHomePath(input.codexHomePath) }).pipe(
      Effect.catch(() => listViaCli(input)),
    );

  const setEnabledViaAppServer = (input: {
    readonly name: string;
    readonly enabled: boolean;
    readonly codexHomePath?: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        await runCodexAppServerRpc({
          ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
          run: async (sendRequest) => {
            await sendRequest("config/value/write", {
              keyPath: `mcp_servers.${input.name}.enabled`,
              value: input.enabled,
              mergeStrategy: "upsert",
            });
            await sendRequest("config/mcpServer/reload", {});
          },
        });
      },
      catch: (cause) =>
        new McpServerManagerError({
          message: `Failed to update MCP server '${input.name}' via Codex app-server.`,
          cause,
        }),
    });

  const setEnabledViaFile: McpServerManagerShape["setEnabled"] = (input) =>
    Effect.gen(function* () {
      const primaryConfigPath = resolveCodexConfigPath(input.codexHomePath);
      const defaultConfigPath = resolveCodexConfigPath(undefined);

      const updateConfigAtPath = (
        configPath: string,
      ): Effect.Effect<void, McpServerManagerError> =>
        Effect.gen(function* () {
          const content = yield* fileSystem.readFileString(configPath).pipe(
            Effect.mapError(
              (cause) =>
                new McpServerManagerError({
                  message: `Failed to read Codex config at ${configPath}.`,
                  cause,
                }),
            ),
          );

          const updated = yield* Effect.try({
            try: () => setEnabledInToml(content, input.name, input.enabled),
            catch: (cause) =>
              new McpServerManagerError({
                message: `Unable to update MCP server '${input.name}' in ${configPath}: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
                cause,
              }),
          });

          yield* fileSystem.writeFileString(configPath, updated).pipe(
            Effect.mapError(
              (cause) =>
                new McpServerManagerError({
                  message: `Failed to write Codex config at ${configPath}.`,
                  cause,
                }),
            ),
          );
        });

      return yield* updateConfigAtPath(primaryConfigPath).pipe(
        Effect.catch((cause) => {
          const shouldFallback =
            !!input.codexHomePath &&
            primaryConfigPath !== defaultConfigPath &&
            (isMissingServerError(cause) ||
              cause.message.startsWith("Failed to read Codex config"));

          if (!shouldFallback) {
            return Effect.fail(cause);
          }

          return updateConfigAtPath(defaultConfigPath).pipe(Effect.catch(Effect.fail));
        }),
      );
    });

  const setEnabled: McpServerManagerShape["setEnabled"] = (input) =>
    setEnabledViaAppServer({
      name: input.name,
      enabled: input.enabled,
      codexHomePath: resolveCodexHomePath(input.codexHomePath),
    }).pipe(Effect.catch(() => setEnabledViaFile(input)));

  const remove: McpServerManagerShape["remove"] = (input) =>
    Effect.gen(function* () {
      const codexHomePath = resolveCodexHomePath(input.codexHomePath);
      const removeProbe = yield* runCodexCommand(["mcp", "remove", input.name], codexHomePath).pipe(
        Effect.timeoutOption(DEFAULT_COMMAND_TIMEOUT_MS),
        Effect.result,
      );

      if (Result.isFailure(removeProbe)) {
        const error = removeProbe.failure;
        return yield* new McpServerManagerError({
          message: `Failed to execute Codex MCP remove: ${error instanceof Error ? error.message : String(error)}.`,
        });
      }

      if (Option.isNone(removeProbe.success)) {
        return yield* new McpServerManagerError({
          message: "Codex MCP remove command timed out.",
        });
      }

      const result = removeProbe.success.value;
      if (result.code !== 0) {
        return yield* new McpServerManagerError({
          message: result.stderr.trim() || `Failed to remove MCP server '${input.name}'.`,
        });
      }
    });

  return { list, setEnabled, remove } satisfies McpServerManagerShape;
});

export const McpServerManagerLive = Layer.effect(McpServerManager, makeMcpServerManager);
