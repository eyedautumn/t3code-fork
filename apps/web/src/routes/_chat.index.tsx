import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { startTransition, useEffect, useMemo, useState } from "react";
import { type ProjectId } from "@t3tools/contracts";

import { isElectron } from "../env";
import { SidebarTrigger } from "../components/ui/sidebar";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { useDraftThreadLauncher } from "../hooks/useDraftThreadLauncher";
import { useNewThreadIntentStore } from "../newThreadIntentStore";
import { useSwarmDraftStore } from "../components/swarms/SwarmDraftStore";

function ChatIndexRouteView() {
  const projects = useStore((store) => store.projects);
  const navigate = useNavigate();
  const launchDraftThread = useDraftThreadLauncher();
  const { intent, clearIntent } = useNewThreadIntentStore();
  const resetSwarmDraft = useSwarmDraftStore((store) => store.reset);
  const search = useSearch({ strict: false, select: (params) => params as Record<string, unknown> });
  const [busy, setBusy] = useState(false);

  const inferredProjectId = useMemo(() => {
    if (intent?.projectId) return intent.projectId;
    if (typeof search?.newThread === "string") {
      return search.newThread as ProjectId;
    }
    return projects[0]?.id ?? null;
  }, [intent?.projectId, projects, search?.newThread]);

  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(inferredProjectId ?? null);

  useEffect(() => {
    setSelectedProjectId(inferredProjectId ?? null);
  }, [inferredProjectId]);

  const handleStartNormalChat = async () => {
    if (!selectedProjectId) return;
    setBusy(true);
    try {
      await launchDraftThread(selectedProjectId, {
        branch: intent?.branch ?? null,
        worktreePath: intent?.worktreePath ?? null,
        envMode: intent?.envMode ?? "local",
      });
      clearIntent();
    } finally {
      setBusy(false);
    }
  };

  const handleBuildSwarm = () => {
    startTransition(() => {
      resetSwarmDraft();
      void navigate({ to: "/swarm/build" });
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">New chat</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
          <span className="text-xs text-muted-foreground/50">No active thread</span>
        </div>
      )}

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold">Start a new conversation</h1>
            <p className="text-sm text-muted-foreground">
              Choose a project, then spin up a normal chat or a multi-agent Swarm.
            </p>
          </div>
          <div className="w-full min-w-[220px] max-w-xs">
            <Select
              value={selectedProjectId ?? undefined}
              onValueChange={(value) => setSelectedProjectId(value as ProjectId)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card
            className="cursor-pointer border-primary/20 bg-muted/10 transition-all hover:border-primary/50 hover:bg-muted/20"
            onClick={handleStartNormalChat}
          >
            <CardHeader>
              <CardTitle>Normal Chat</CardTitle>
              <CardDescription>
                Start a single-agent thread with the default model and runtime for this project.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Use this path for focused work or when you don&apos;t need multi-agent orchestration.
              </p>
              <Button onClick={(e) => { e.stopPropagation(); handleStartNormalChat(); }} disabled={!selectedProjectId || busy}>
                Start normal chat
              </Button>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer border-primary/20 bg-muted/10 transition-all hover:border-primary/50 hover:bg-muted/20"
            onClick={handleBuildSwarm}
          >
            <CardHeader>
              <CardTitle>Build a Swarm</CardTitle>
              <CardDescription>
                Create a multi-agent swarm with coordinated roles and a shared mission.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Orchestrate multiple agents with coordinator, builder, reviewer, and scout roles.
              </p>
              <Button variant="secondary" onClick={(e) => { e.stopPropagation(); handleBuildSwarm(); }}>
                Build Swarm
              </Button>
            </CardContent>
          </Card>
        </div>

        <Separator />
        <div className="text-xs text-muted-foreground">
          Swarms are created with a single command, including mission, agent roster, and runtime hints.
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
