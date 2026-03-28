import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { startTransition, useEffect, useMemo, useState } from "react";
import { type ProjectId } from "@t3tools/contracts";
import { MessageSquare, Network, ArrowRight, Info, LayoutGrid } from "lucide-react";

import { isElectron } from "../env";
import { SidebarTrigger } from "../components/ui/sidebar";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useDraftThreadLauncher } from "../hooks/useDraftThreadLauncher";
import { useNewThreadIntentStore } from "../newThreadIntentStore";
import { useSwarmDraftStore } from "../components/swarms/SwarmDraftStore";

function ChatIndexRouteView() {
  const projects = useStore((store) => store.projects);
  const navigate = useNavigate();
  const launchDraftThread = useDraftThreadLauncher();
  const { intent, clearIntent } = useNewThreadIntentStore();
  const resetSwarmDraft = useSwarmDraftStore((store) => store.reset);
  const search = useSearch({
    strict: false,
    select: (params) => params as Record<string, unknown>,
  });
  const [busy, setBusy] = useState(false);

  const inferredProjectId = useMemo(() => {
    if (intent?.projectId) return intent.projectId;
    if (typeof search?.newThread === "string") {
      return search.newThread as ProjectId;
    }
    return projects[0]?.id ?? null;
  }, [intent?.projectId, projects, search?.newThread]);

  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(
    inferredProjectId ?? null,
  );

  useEffect(() => {
    setSelectedProjectId(inferredProjectId ?? null);
  }, [inferredProjectId]);

  // Derive the selected project object to display the name properly instead of the ID
  const selectedProject = useMemo(() => {
    return projects.find((p) => p.id === selectedProjectId) ?? null;
  }, [projects, selectedProjectId]);

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
      if (selectedProjectId) {
        void navigate({
          to: "/swarm/build",
          search: { projectId: selectedProjectId },
        });
      } else {
        void navigate({ to: "/swarm/build" });
      }
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background/95 text-foreground">
      {!isElectron && (
        <header className="border-b border-border/50 bg-background/50 px-3 py-2 backdrop-blur-md md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">New Workspace</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border/50 bg-background/50 px-5 backdrop-blur-md">
          <span className="text-xs font-medium text-muted-foreground/60">No active thread</span>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-10 lg:px-8 lg:py-14">
          {/* Header Section */}
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                New Conversation
              </h1>
              <p className="max-w-[500px] text-base text-muted-foreground">
                Select your project context and choose how you want to interact. Spin up a focused
                chat or orchestrate a multi-agent swarm.
              </p>
            </div>

            <div className="w-full space-y-2 md:w-[280px]">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Active Project
              </label>
              <Select
                value={selectedProjectId ?? undefined}
                onValueChange={(value) => setSelectedProjectId(value as ProjectId)}
              >
                <SelectTrigger className="h-11 bg-muted/20 shadow-sm transition-colors hover:bg-muted/40">
                  <div className="flex items-center gap-2">
                    <LayoutGrid className="size-4 text-primary/70" />
                    {/* Explicitly show the project name instead of the ID */}
                    <SelectValue placeholder="Pick a project">
                      {selectedProject ? selectedProject.name : "Pick a project"}
                    </SelectValue>
                  </div>
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

          <Separator className="opacity-50" />

          {/* Action Cards */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card
              className="group relative cursor-pointer overflow-hidden border-border/50 bg-background transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5"
              onClick={handleStartNormalChat}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
              <CardHeader className="relative pb-4">
                <div className="mb-4 inline-flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform group-hover:scale-105">
                  <MessageSquare className="size-6" />
                </div>
                <CardTitle className="text-xl">Standard Thread</CardTitle>
                <CardDescription className="text-sm text-muted-foreground/80">
                  Start a single-agent conversation with the default model and runtime for this
                  project.
                </CardDescription>
              </CardHeader>
              <CardContent className="relative space-y-6">
                <p className="text-sm text-muted-foreground">
                  Perfect for focused, sequential work or quick inquiries where you don&apos;t need
                  complex multi-agent orchestration.
                </p>
                <div className="flex items-center justify-between">
                  <Button
                    className="z-10 shadow-none"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartNormalChat();
                    }}
                    disabled={!selectedProjectId || busy}
                  >
                    Launch Chat
                  </Button>
                  <ArrowRight className="size-5 text-muted-foreground transition-all duration-300 group-hover:translate-x-1 group-hover:text-primary" />
                </div>
              </CardContent>
            </Card>

            <Card
              className="group relative cursor-pointer overflow-hidden border-border/50 bg-background transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5"
              onClick={handleBuildSwarm}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
              <CardHeader className="relative pb-4">
                <div className="mb-4 inline-flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform group-hover:scale-105">
                  <Network className="size-6" />
                </div>
                <CardTitle className="text-xl">Build a Swarm</CardTitle>
                <CardDescription className="text-sm text-muted-foreground/80">
                  Create a multi-agent swarm with coordinated roles, specialized skills, and a
                  shared mission.
                </CardDescription>
              </CardHeader>
              <CardContent className="relative space-y-6">
                <p className="text-sm text-muted-foreground">
                  Orchestrate multiple agents—including a coordinator, builder, reviewer, and
                  scout—to tackle complex engineering tasks.
                </p>
                <div className="flex items-center justify-between">
                  <Button
                    variant="secondary"
                    className="z-10 shadow-none"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleBuildSwarm();
                    }}
                  >
                    Configure Swarm
                  </Button>
                  <ArrowRight className="size-5 text-muted-foreground transition-all duration-300 group-hover:translate-x-1 group-hover:text-primary" />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Footer Info Callout */}
          <div className="mt-4 flex items-center gap-3 rounded-lg border border-primary/10 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
            <Info className="size-4 shrink-0 text-primary/70" />
            <p>
              Swarms are generated via a single initial command, instantly drafting your mission,
              agent roster, and runtime hints.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
