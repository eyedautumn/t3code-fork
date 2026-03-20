import { Schema } from "effect";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ProviderKind } from "./orchestration";
import { ProviderSessionStatus } from "./provider";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderStatus = Schema.Struct({
  provider: ProviderKind,
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

const ServerProviderStatuses = Schema.Array(ServerProviderStatus);

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
});
export type ServerConfig = typeof ServerConfig.Type;

export const McpServerTransport = Schema.Struct({
  type: TrimmedNonEmptyString,
  command: Schema.optional(TrimmedNonEmptyString),
  args: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  url: Schema.optional(TrimmedNonEmptyString),
  env: Schema.optional(Schema.Unknown),
  envVars: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  cwd: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type McpServerTransport = typeof McpServerTransport.Type;

export const McpServerInfo = Schema.Struct({
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  disabledReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  transport: McpServerTransport,
  authStatus: Schema.optional(TrimmedNonEmptyString),
  startupTimeoutSec: Schema.optional(Schema.NullOr(Schema.Number)),
  toolTimeoutSec: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type McpServerInfo = typeof McpServerInfo.Type;

export const ServerMcpListInput = Schema.Struct({
  codexHomePath: Schema.optional(TrimmedNonEmptyString),
});
export type ServerMcpListInput = typeof ServerMcpListInput.Type;

export const ServerMcpListResult = Schema.Struct({
  servers: Schema.Array(McpServerInfo),
});
export type ServerMcpListResult = typeof ServerMcpListResult.Type;

export const ServerMcpSetEnabledInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  codexHomePath: Schema.optional(TrimmedNonEmptyString),
});
export type ServerMcpSetEnabledInput = typeof ServerMcpSetEnabledInput.Type;

export const ServerMcpRemoveInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  codexHomePath: Schema.optional(TrimmedNonEmptyString),
});
export type ServerMcpRemoveInput = typeof ServerMcpRemoveInput.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerSwarmSession = Schema.Struct({
  threadId: ThreadId,
  agentId: TrimmedNonEmptyString,
  providerThreadId: ThreadId,
  sessionId: TrimmedNonEmptyString,
  status: ProviderSessionStatus,
});
export type ServerSwarmSession = typeof ServerSwarmSession.Type;

export const ServerProviderSwarmSessionsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ServerProviderSwarmSessionsInput = typeof ServerProviderSwarmSessionsInput.Type;

export const ServerProviderSwarmSessionsResult = Schema.Array(ServerSwarmSession);
export type ServerProviderSwarmSessionsResult = typeof ServerProviderSwarmSessionsResult.Type;
