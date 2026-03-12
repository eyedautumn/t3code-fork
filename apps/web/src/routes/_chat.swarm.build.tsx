import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_RUNTIME_MODE,
  type ProjectId,
  type SwarmConfig,
} from "@t3tools/contracts";

import { useStore } from "../store";
import { useComposerDraftStore } from "../composerDraftStore";
import { SwarmWizard } from "../components/swarms/SwarmWizard";
import { useSwarmDraftStore } from "../components/swarms/SwarmDraftStore";
import { readNativeApi } from "../nativeApi";
import { newCommandId, newThreadId } from "../lib/utils";

function SwarmBuildPageInner() {
  const projects = useStore((store) => store.projects);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const inferredProjectId = useMemo(() => projects[0]?.id ?? null, [projects]);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(inferredProjectId);

  const setSwarmProject = useSwarmDraftStore((store) => store.setProject);

  const { setProjectDraftThreadId, clearProjectDraftThreadById } = useComposerDraftStore((store) => ({
    setProjectDraftThreadId: store.setProjectDraftThreadId,
    clearProjectDraftThreadById: store.clearProjectDraftThreadById,
  }));

  useEffect(() => {
    if (!projects.length) {
      setSelectedProjectId(null);
      return;
    }

    if (!selectedProjectId || !projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects[0]!.id);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    setSwarmProject(selectedProjectId);
  }, [selectedProjectId, setSwarmProject]);

  const handleCreateSwarm = async (config: SwarmConfig) => {
    if (!selectedProjectId) return;
    const api = readNativeApi();
    if (!api) return;
    setBusy(true);
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const leadAgent = config.agents[0];
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
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
        runtimeMode: config.agents[0]?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: config.agents[0]?.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
        swarm: config,
        createdAt,
      });
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

  return (
    selectedProjectId ? (
      <SwarmWizard
        projectId={selectedProjectId}
        onCreate={handleCreateSwarm}
        busy={busy}
      />
    ) : (
      <div className="flex flex-1 items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">Loading projects…</p>
      </div>
    )
  );
}

function SwarmBuildPage() {
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center bg-background text-foreground"><p className="text-sm text-muted-foreground">Loading swarm builder...</p></div>}>
      <SwarmBuildPageInner />
    </Suspense>
  );
}

export const Route = createFileRoute("/_chat/swarm/build")({
  component: SwarmBuildPage,
});
