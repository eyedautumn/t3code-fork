import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ProjectId } from "@t3tools/contracts";

import {
  type DraftThreadEnvMode,
  useComposerDraftStore,
  type DraftThreadState,
} from "../composerDraftStore";
import { DEFAULT_RUNTIME_MODE } from "../types";
import { newThreadId } from "../lib/utils";

type LaunchOptions = {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
};

function resolveDraftThread(
  threadId: string,
  projectId: ProjectId,
  existing: DraftThreadState | null,
  options?: LaunchOptions,
): DraftThreadState {
  return {
    projectId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    runtimeMode: existing?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: existing?.interactionMode ?? "default",
    branch: options?.branch ?? existing?.branch ?? null,
    worktreePath: options?.worktreePath ?? existing?.worktreePath ?? null,
    envMode: options?.envMode ?? existing?.envMode ?? "local",
  };
}

export function useDraftThreadLauncher() {
  const navigate = useNavigate();
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);

  return useCallback(
    async (projectId: ProjectId, options?: LaunchOptions): Promise<void> => {
      // Always create a fresh draft thread for the project when launching
      // from the new thread screen. This avoids reusing an existing swarm
      // thread as the "standard" chat entry point.
      clearProjectDraftThreadId(projectId);

      const threadId = newThreadId();
      const draftThread = resolveDraftThread(threadId, projectId, null, options);
      setProjectDraftThreadId(projectId, threadId, draftThread);
      await navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [clearProjectDraftThreadId, navigate, setProjectDraftThreadId],
  );
}
