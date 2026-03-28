import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { Suspense, useEffect, useState } from "react";
import {
  DEFAULT_RUNTIME_MODE,
  type ProjectId,
  type SwarmConfig,
  type ProviderKind,
} from "@t3tools/contracts";
import { getDefaultModel } from "@t3tools/shared/model";

import { useStore } from "../store";
import { useComposerDraftStore } from "../composerDraftStore";
import { SwarmWizard } from "../components/swarms/SwarmWizard";
import { useSwarmDraftStore } from "../components/swarms/SwarmDraftStore";
import { readNativeApi } from "../nativeApi";
import { newCommandId, newThreadId } from "../lib/utils";
import { addSwarmHint } from "../lib/swarmHints";

function SwarmBuildPageInner() {
  const projects = useStore((store) => store.projects);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const search = useSearch({ strict: false }) as { projectId?: ProjectId };
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);

  const setSwarmProject = useSwarmDraftStore((store) => store.setProject);
  const resetSwarmDraft = useSwarmDraftStore((store) => store.reset);

  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );

  // Reset store when component mounts
  useEffect(() => {
    resetSwarmDraft();
  }, [resetSwarmDraft]);

  // Set selected project, preferring the project passed via search params.
  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId(null);
      return;
    }
    const fromSearch = search.projectId;
    if (fromSearch && projects.some((p) => p.id === fromSearch)) {
      setSelectedProjectId(fromSearch);
      return;
    }
    setSelectedProjectId(projects[0]?.id ?? null);
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
    setBusy(true);
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const leadAgent = config.agents[0];
    const leadModel = leadAgent?.model;
    const leadProviderFromModel =
      leadModel && leadModel.startsWith("opencode/")
        ? "opencode"
        : ((leadAgent?.provider ?? "opencode") as ProviderKind);
    const leadProvider = leadProviderFromModel;
    const resolvedLeadModel = leadModel ?? getDefaultModel(leadProvider);
    setProjectDraftThreadId(selectedProjectId, threadId, {
      createdAt,
      runtimeMode: leadAgent?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      interactionMode: leadAgent?.interactionMode ?? "default",
    });
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        projectId: selectedProjectId,
        title: config.name,
        model: resolvedLeadModel,
        runtimeMode: config.agents[0]?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: config.agents[0]?.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
        swarm: config,
        createdAt,
      });
      addSwarmHint(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: { swarm: "1" },
      });
    } catch {
      clearProjectDraftThreadById(selectedProjectId, threadId);
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
