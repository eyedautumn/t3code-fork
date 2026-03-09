import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  mcpServers: (codexHomePath?: string | null) => ["server", "mcp", codexHomePath ?? null] as const,
};

export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
    },
    staleTime: Infinity,
  });
}

export function serverMcpServersQueryOptions(codexHomePath?: string | null) {
  return queryOptions({
    queryKey: serverQueryKeys.mcpServers(codexHomePath ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.mcpList(codexHomePath ? { codexHomePath } : {});
    },
  });
}
