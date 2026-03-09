import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { McpServerInfo, ServerMcpListResult } from "@t3tools/contracts";
import { toastManager } from "../components/ui/toast";
import {
  PlugIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";

import { isElectron } from "../env";
import { useAppSettings } from "../appSettings";
import { ensureNativeApi } from "../nativeApi";
import { serverMcpServersQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { cn } from "../lib/utils";
import { SidebarInset } from "~/components/ui/sidebar";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "../components/ui/card";
import { Switch } from "../components/ui/switch";

function transportSummary(server: McpServerInfo) {
  const transport = server.transport;
  if (transport.type === "stdio") {
    const args = transport.args?.join(" ") ?? "";
    return `${transport.command ?? "command"} ${args}`.trim();
  }
  if (transport.url) return transport.url;
  return transport.type;
}

function authBadgeLabel(status: string | undefined) {
  if (!status) return null;
  if (status === "authenticated") return { label: "Authed", tone: "default" } as const;
  if (status === "unauthenticated") return { label: "Auth required", tone: "error" } as const;
  if (status === "unsupported") return { label: "Auth unsupported", tone: "outline" } as const;
  return { label: status, tone: "outline" } as const;
}

function McpServersRouteView() {
  const { settings } = useAppSettings();
  const codexHomePath = settings.codexHomePath?.trim() || null;
  const queryClient = useQueryClient();
  const mcpQuery = useQuery(serverMcpServersQueryOptions(codexHomePath));

  const setEnabledMutation = useMutation({
    mutationFn: async (input: { name: string; enabled: boolean }) => {
      const api = ensureNativeApi();
      return api.server.mcpSetEnabled({
        name: input.name,
        enabled: input.enabled,
        ...(codexHomePath ? { codexHomePath } : {}),
      });
    },
    onMutate: async (input) => {
      const queryKey = serverQueryKeys.mcpServers(codexHomePath ?? null);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ServerMcpListResult>(queryKey);
      queryClient.setQueryData<ServerMcpListResult>(queryKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          servers: current.servers.map((server) =>
            server.name === input.name ? { ...server, enabled: input.enabled } : server,
          ),
        };
      });
      return { previous };
    },
    onSuccess: (result) => {
      const queryKey = serverQueryKeys.mcpServers(codexHomePath ?? null);
      queryClient.setQueryData(queryKey, result);
    },
    onError: (error, _input, context) => {
      const queryKey = serverQueryKeys.mcpServers(codexHomePath ?? null);
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      const message = error instanceof Error ? error.message : "Failed to update MCP server.";
      toastManager.add({ type: "error", title: "MCP toggle failed", description: message });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: serverQueryKeys.mcpServers(codexHomePath ?? null),
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (input: { name: string }) => {
      const api = ensureNativeApi();
      return api.server.mcpRemove({
        name: input.name,
        ...(codexHomePath ? { codexHomePath } : {}),
      });
    },
    onSuccess: (result) => {
      const queryKey = serverQueryKeys.mcpServers(codexHomePath ?? null);
      queryClient.setQueryData(queryKey, result);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to remove MCP server.";
      toastManager.add({ type: "error", title: "MCP remove failed", description: message });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: serverQueryKeys.mcpServers(codexHomePath ?? null),
      });
    },
  });

  const servers = mcpQuery.data?.servers ?? [];
  const hasServers = servers.length > 0;
  const pendingNames = new Set<string>();
  if (setEnabledMutation.isPending && setEnabledMutation.variables?.name) {
    pendingNames.add(setEnabledMutation.variables.name);
  }
  if (removeMutation.isPending && removeMutation.variables?.name) {
    pendingNames.add(removeMutation.variables.name);
  }

  const enabledCount = servers.filter((server) => server.enabled).length;
  const overviewStats = { enabledCount, totalCount: servers.length };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              MCP servers
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  MCP servers
                </h1>
                <p className="text-sm text-muted-foreground">
                  Manage the MCP servers configured for Codex CLI on this device.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">
                  {overviewStats.enabledCount}/{overviewStats.totalCount} enabled
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void queryClient.invalidateQueries({
                      queryKey: serverQueryKeys.mcpServers(codexHomePath ?? null),
                    })
                  }
                  disabled={mcpQuery.isFetching}
                >
                  <RefreshCwIcon className={cn("size-3.5", mcpQuery.isFetching && "animate-spin")} />
                  Refresh
                </Button>
              </div>
            </header>

            {mcpQuery.isError && (
              <Alert variant="error">
                <ShieldAlertIcon />
                <AlertTitle>Unable to load MCP servers</AlertTitle>
                <AlertDescription>
                  {mcpQuery.error instanceof Error
                    ? mcpQuery.error.message
                    : "An unknown error occurred while loading MCP servers."}
                </AlertDescription>
              </Alert>
            )}

            {!mcpQuery.isLoading && !hasServers && !mcpQuery.isError && (
              <Card className="border-dashed">
                <CardHeader>
                  <CardTitle className="text-base">No MCP servers configured</CardTitle>
                  <CardDescription>
                    Add MCP servers with `codex mcp add` or edit your Codex config.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              {servers.map((server) => {
                const authBadge = authBadgeLabel(server.authStatus);
                const busy = pendingNames.has(server.name);
                const summary = transportSummary(server);

                return (
                  <Card key={server.name} className="flex h-full flex-col">
                    <CardHeader className="flex flex-row items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <ServerIcon className="size-4 text-muted-foreground" />
                          <CardTitle className="text-base">{server.name}</CardTitle>
                        </div>
                        <CardDescription className="mt-2 text-xs text-muted-foreground/80">
                          {summary}
                        </CardDescription>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={server.enabled ? "default" : "outline"}>
                          {server.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                        {authBadge && (
                          <Badge variant={authBadge.tone}>{authBadge.label}</Badge>
                        )}
                      </div>
                    </CardHeader>

                    <CardPanel className="flex-1 space-y-3">
                      {server.disabledReason && (
                        <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                          Disabled reason: {server.disabledReason}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1">
                          <PlugIcon className="size-3" />
                          {server.transport.type}
                        </span>
                        {server.startupTimeoutSec !== undefined && server.startupTimeoutSec !== null && (
                          <span>Startup timeout: {server.startupTimeoutSec}s</span>
                        )}
                        {server.toolTimeoutSec !== undefined && server.toolTimeoutSec !== null && (
                          <span>Tool timeout: {server.toolTimeoutSec}s</span>
                        )}
                      </div>
                    </CardPanel>

                    <div className="flex items-center justify-between border-t border-border/60 px-4 py-3">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <ShieldCheckIcon className="size-3.5" />
                        {server.enabled ? "Available to Codex" : "Unavailable to Codex"}
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Enabled</span>
                          <Switch
                            checked={server.enabled}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              setEnabledMutation.mutate({ name: server.name, enabled: checked })
                            }
                          />
                        </div>
                        <Button
                          type="button"
                          variant="destructive-outline"
                          size="sm"
                          disabled={busy}
                          onClick={async () => {
                            const api = ensureNativeApi();
                            const confirmed = await api.dialogs.confirm(
                              `Remove MCP server "${server.name}"?`,
                            );
                            if (!confirmed) return;
                            removeMutation.mutate({ name: server.name });
                          }}
                        >
                          <Trash2Icon className="size-3.5" />
                          Remove
                        </Button>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/mcp")({
  component: McpServersRouteView,
});
