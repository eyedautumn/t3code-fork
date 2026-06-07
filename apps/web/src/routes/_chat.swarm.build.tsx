import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { Suspense, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DEFAULT_RUNTIME_MODE,
  ProviderInstanceId,
  type ProjectId,
  type SwarmConfig,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { resolveModelSlugForProvider } from "@t3tools/shared/model";

import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { SwarmWizard } from "../components/swarms/SwarmWizard";
import { useSwarmDraftStore } from "../components/swarms/SwarmDraftStore";
import { readNativeApi } from "../nativeApi";
import { newCommandId, newThreadId } from "../lib/utils";
import { addSwarmHint } from "../lib/swarmHints";
import { buildThreadRouteParams } from "../threadRoutes";

function SwarmBuildPageInner() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const search = useSearch({ strict: false }) as { projectId?: ProjectId };
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);

  const setSwarmProject = useSwarmDraftStore((store) => store.setProject);
  const resetSwarmDraft = useSwarmDraftStore((store) => store.reset);

  // Reset store when component mounts
  useEffect(() => {
    resetSwarmDraft();
  }, [resetSwarmDraft]);

  // Set selected project, preferring the project passed via search params.
  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId((currentProjectId) =>
        currentProjectId === null ? currentProjectId : null,
      );
      return;
    }
    const fromSearch = search.projectId;
    const nextProjectId =
      fromSearch && projects.some((p) => p.id === fromSearch)
        ? fromSearch
        : (projects[0]?.id ?? null);
    setSelectedProjectId((currentProjectId) =>
      currentProjectId === nextProjectId ? currentProjectId : nextProjectId,
    );
  }, [projects, search.projectId]);

  // Update swarm draft store when project changes
  useEffect(() => {
    if (selectedProjectId !== null) {
      setSwarmProject(selectedProjectId);
    }
  }, [selectedProjectId, setSwarmProject]);

  const handleCreateSwarm = async (config: SwarmConfig) => {
    if (!selectedProjectId) return;
    const api = readNativeApi();
    if (!api) return;
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const selectedProject = projects.find((project) => project.id === selectedProjectId);
    if (!selectedProject) return;
    setBusy(true);
    const leadAgent = config.agents[0];
    const leadModel = leadAgent?.model;
    const leadProviderFromModel =
      leadModel && leadModel.startsWith("opencode/")
        ? "opencode"
        : (leadAgent?.provider ?? "codex");
    const leadProvider = ProviderDriverKind.make(leadProviderFromModel);
    const leadProviderInstanceId =
      leadAgent?.providerInstanceId ?? ProviderInstanceId.make(leadProvider);
    const modelSelection = {
      instanceId: leadProviderInstanceId,
      model: resolveModelSlugForProvider(leadProvider, leadModel),
      ...(leadAgent?.modelOptions ? { options: leadAgent.modelOptions } : {}),
    };
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        projectId: selectedProjectId,
        title: config.name,
        modelSelection,
        runtimeMode: config.agents[0]?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: config.agents[0]?.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
        swarm: config,
        createdAt,
      });
      addSwarmHint(threadId);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: selectedProject.environmentId,
          threadId,
        }),
        search: { swarm: "1" } as never,
      });
    } catch {
      // Keep the builder state intact so the user can retry.
    } finally {
      setBusy(false);
    }
  };

  return selectedProjectId ? (
    <SwarmWizard projectId={selectedProjectId} onCreate={handleCreateSwarm} busy={busy} />
  ) : (
    <div className="flex flex-1 items-center justify-center bg-background text-foreground">
      <p className="text-sm text-muted-foreground">Loading projects…</p>
    </div>
  );
}

function SwarmBuildPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center bg-background text-foreground">
          <p className="text-sm text-muted-foreground">Loading swarm builder...</p>
        </div>
      }
    >
      <SwarmBuildPageInner />
    </Suspense>
  );
}

export const Route = createFileRoute("/_chat/swarm/build")({
  component: SwarmBuildPage,
});
