declare module "@anthropic-ai/claude-agent-sdk" {
  export type SDKMessage = any;
  export type SDKResultMessage = SDKMessage;
  export type SDKUserMessage = SDKMessage;
  export type ThinkingConfig = any;
  export type PermissionMode = "auto" | "always_ask" | "deny" | string;
  export type PermissionResult = {
    behavior: "allow" | "deny";
    message?: string;
    updatedInput?: unknown;
  };
  export type PermissionUpdate = {
    tool?: string;
    input?: unknown;
    [key: string]: unknown;
  };
  export type CanUseTool = (
    toolName: string,
    toolInput: any,
    callbackOptions: any,
  ) => Promise<PermissionResult>;
  export type SpawnOptions = {
    cwd?: string;
    env?: Record<string, string>;
    args: string[];
    [key: string]: unknown;
  };
  export type SpawnedProcess = {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    kill: (signal: NodeJS.Signals) => boolean;
    exitCode: number | null;
    on: (
      event: "error" | "exit",
      listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
    ) => void;
  };
  export type Options = {
    model?: string;
    maxThinkingTokens?: number | null;
    permissionMode?: PermissionMode;
    canUseTool?: CanUseTool;
    settings?: {
      fastMode?: boolean;
      [key: string]: unknown;
    };
    spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
    persistSession?: boolean;
    [key: string]: unknown;
  };
  export type SDKInitializationResult = {
    models: Array<{
      value: string;
      supportsEffort?: boolean;
      supportsAdaptiveThinking?: boolean;
      supportedEffortLevels?: ReadonlyArray<string>;
    }>;
    fast_mode_state?: string | null;
  };

  export type SDKMessageStream = AsyncIterable<SDKMessage> & {
    initializationResult(): Promise<SDKInitializationResult>;
    close: () => void;
    interrupt: () => Promise<void>;
    setModel: (model?: string) => Promise<void>;
    setPermissionMode: (mode: PermissionMode) => Promise<void>;
    setMaxThinkingTokens: (value: number | null) => Promise<void>;
  };

  export function query(...args: any[]): SDKMessageStream;
}
