import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { ArrowRight, LayoutGrid, LinkIcon, MessageSquare, Network, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useSwarmDraftStore } from "../components/swarms/SwarmDraftStore";
import { useSavedEnvironmentRegistryStore } from "../environments/runtime";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const savedEnvironmentCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const navigate = useNavigate();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const resetSwarmDraft = useSwarmDraftStore((store) => store.reset);
  const search = useSearch({ strict: false }) as { environmentId?: string; projectId?: string };
  const [busy, setBusy] = useState(false);

  const defaultProject = useMemo(
    () =>
      projects.find(
        (project) =>
          defaultProjectRef &&
          project.id === defaultProjectRef.projectId &&
          project.environmentId === defaultProjectRef.environmentId,
      ) ??
      projects[0] ??
      null,
    [defaultProjectRef, projects],
  );
  const defaultProjectKey = defaultProject
    ? `${defaultProject.environmentId}:${defaultProject.id}`
    : null;
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(defaultProjectKey);
  useEffect(() => {
    setSelectedProjectKey((currentProjectKey) => {
      if (search.environmentId && search.projectId) {
        const searchKey = `${search.environmentId}:${search.projectId}`;
        if (projects.some((p) => `${p.environmentId}:${p.id}` === searchKey)) {
          return searchKey;
        }
      }
      if (projects.length === 0) return currentProjectKey === null ? currentProjectKey : null;
      if (
        currentProjectKey &&
        projects.some((project) => `${project.environmentId}:${project.id}` === currentProjectKey)
      ) {
        return currentProjectKey;
      }
      return defaultProjectKey;
    });
  }, [defaultProjectKey, projects, search.environmentId, search.projectId]);

  const selectedProject =
    projects.find((project) => `${project.environmentId}:${project.id}` === selectedProjectKey) ??
    defaultProject;

  if (authGateState.status === "hosted-static" && savedEnvironmentCount === 0) {
    return <HostedStaticOnboardingState />;
  }

  const launchStandardThread = async () => {
    if (!selectedProject) return;
    setBusy(true);
    try {
      await handleNewThread(scopeProjectRef(selectedProject.environmentId, selectedProject.id));
    } finally {
      setBusy(false);
    }
  };

  const launchSwarmBuilder = () => {
    resetSwarmDraft();
    void navigate({
      to: "/swarm/build",
      search: selectedProject ? { projectId: selectedProject.id } : {},
    } as never);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-12">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              New thread
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">Choose how we start</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Open a normal single-agent draft, or build a coordinated swarm with dedicated roles.
            </p>
          </div>

          <div className="w-full md:w-80">
            <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Project
            </label>
            <Select value={selectedProjectKey ?? undefined} onValueChange={setSelectedProjectKey}>
              <SelectTrigger className="h-11">
                <div className="flex items-center gap-2">
                  <LayoutGrid className="size-4 text-muted-foreground" />
                  <SelectValue placeholder="Pick a project" />
                </div>
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem
                    key={`${project.environmentId}:${project.id}`}
                    value={`${project.environmentId}:${project.id}`}
                  >
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <Card
            className="group cursor-pointer transition hover:-translate-y-0.5 hover:border-primary/40"
            onClick={launchStandardThread}
          >
            <CardHeader>
              <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <MessageSquare className="size-5" />
              </div>
              <CardTitle>Standard Thread</CardTitle>
              <CardDescription>Start a focused single-agent coding conversation.</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <Button
                disabled={!selectedProject || busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void launchStandardThread();
                }}
              >
                Launch Chat
              </Button>
              <ArrowRight className="size-5 text-muted-foreground transition group-hover:translate-x-1" />
            </CardContent>
          </Card>

          <Card
            className="group cursor-pointer transition hover:-translate-y-0.5 hover:border-primary/40"
            onClick={launchSwarmBuilder}
          >
            <CardHeader>
              <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Network className="size-5" />
              </div>
              <CardTitle>Build a Swarm</CardTitle>
              <CardDescription>
                Configure coordinator, builder, reviewer, and scout agents.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <Button
                variant="secondary"
                disabled={!selectedProject}
                onClick={(event) => {
                  event.stopPropagation();
                  launchSwarmBuilder();
                }}
              >
                Configure Swarm
              </Button>
              <ArrowRight className="size-5 text-muted-foreground transition group-hover:translate-x-1" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect an environment to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {cloudEnabled
                  ? "Sign in to T3 Connect to connect a linked environment through its managed tunnel, or add a reachable backend manually."
                  : "Add a reachable backend manually to start working from this browser."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  {cloudEnabled ? "Open Connections" : "Add environment"}
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
