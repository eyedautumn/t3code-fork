import { create } from "zustand";
import type { DraftThreadEnvMode } from "./composerDraftStore";
import type { ProjectId } from "@t3tools/contracts";

export type NewThreadIntent = {
  projectId: ProjectId;
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
};

interface NewThreadIntentStore {
  intent: NewThreadIntent | null;
  setIntent: (intent: NewThreadIntent) => void;
  clearIntent: () => void;
}

export const useNewThreadIntentStore = create<NewThreadIntentStore>((set) => ({
  intent: null,
  setIntent: (intent) => set({ intent }),
  clearIntent: () => set({ intent: null }),
}));
