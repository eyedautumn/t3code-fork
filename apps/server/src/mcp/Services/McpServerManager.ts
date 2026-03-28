import { Effect, ServiceMap } from "effect";
import type { McpServerInfo } from "@t3tools/contracts";

import type { McpServerManagerError } from "../Errors";

export interface McpServerManagerShape {
  readonly list: (input: {
    readonly codexHomePath?: string;
  }) => Effect.Effect<ReadonlyArray<McpServerInfo>, McpServerManagerError>;
  readonly setEnabled: (input: {
    readonly name: string;
    readonly enabled: boolean;
    readonly codexHomePath?: string;
  }) => Effect.Effect<void, McpServerManagerError>;
  readonly remove: (input: {
    readonly name: string;
    readonly codexHomePath?: string;
  }) => Effect.Effect<void, McpServerManagerError>;
}

export class McpServerManager extends ServiceMap.Service<McpServerManager, McpServerManagerShape>()(
  "t3/mcp/Services/McpServerManager",
) {}
