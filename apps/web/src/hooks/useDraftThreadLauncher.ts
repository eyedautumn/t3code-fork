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
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const clearProjectDraftThreadId = useComposerDraftStore((store) => store.clearProjectDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);

  return useCallback(
    async (projectId: ProjectId, options?: LaunchOptions): Promise<void> => {
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
      if (storedDraftThread) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(storedDraftThread.threadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: storedDraftThread.threadId },
        });
        return;
      }
      clearProjectDraftThreadId(projectId);

      const activeDraftThreadId = getDraftThreadByProjectId(projectId)?.threadId ?? null;
      const activeDraftThread = activeDraftThreadId ? getDraftThread(activeDraftThreadId) : null;
      if (activeDraftThread && activeDraftThreadId) {
        const resolved = resolveDraftThread(activeDraftThreadId, projectId, activeDraftThread, options);
        setDraftThreadContext(activeDraftThreadId, resolved);
        await navigate({
          to: "/$threadId",
          params: { threadId: activeDraftThreadId },
        });
        return;
      }

      const threadId = newThreadId();
      const draftThread = resolveDraftThread(threadId, projectId, null, options);
      setProjectDraftThreadId(projectId, threadId, draftThread);
      await navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      navigate,
      setDraftThreadContext,
      setProjectDraftThreadId,
    ],
  );
}
