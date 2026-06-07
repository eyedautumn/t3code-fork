import { create } from "zustand";
import {
  type ProviderOptionSelections,
  type ProjectId,
  type SwarmAgent,
  type SwarmConfig,
  type SwarmAgentRole,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ProviderServiceTier,
  type ProviderKind,
  type SwarmContextFile,
  type SwarmUploadedSkill,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { SwarmSkillId } from "@t3tools/shared/swarmSkills";
import { getDefaultModel, getReasoningEffortOptions } from "@t3tools/shared/model";
import { createJSONStorage, persist } from "zustand/middleware";
import { createMemoryStorage } from "../../lib/storage";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type SwarmContextFileDraft = Omit<SwarmContextFile, "size">;
export type SwarmUploadedSkillDraft = SwarmUploadedSkill;

export type SwarmAgentDraft = Omit<
  SwarmAgent,
  "name" | "reasoningEffort" | "modelOptions" | "fastMode"
> & {
  reasoningEffort?: ReasoningEffort;
  modelOptions?: ProviderOptionSelections;
  fastMode?: boolean;
};

export type SwarmTemplateId =
  | "trio"
  | "squad"
  | "team"
  | "platoon"
  | "battalion"
  | "legion"
  | "review"
  | "explore";

export type SwarmTemplateDefinition = {
  id: SwarmTemplateId;
  label: string;
  description: string;
  agentCount: number;
  category: "roster" | "strategy";
};

export const SWARM_TEMPLATE_OPTIONS: SwarmTemplateDefinition[] = [
  {
    id: "trio",
    label: "Trio",
    description: "Coordinator, builder, and reviewer for tight delivery loops.",
    agentCount: 3,
    category: "roster",
  },
  {
    id: "squad",
    label: "Squad",
    description: "5 agents balanced for focused delivery.",
    agentCount: 5,
    category: "roster",
  },
  {
    id: "team",
    label: "Team",
    description: "10 agents split across build, review, and scouting.",
    agentCount: 10,
    category: "roster",
  },
  {
    id: "platoon",
    label: "Platoon",
    description: "15 agents for parallel execution with oversight.",
    agentCount: 15,
    category: "roster",
  },
  {
    id: "battalion",
    label: "Battalion",
    description: "20 agents for sustained throughput.",
    agentCount: 20,
    category: "roster",
  },
  {
    id: "legion",
    label: "Legion",
    description: "50 agents for broad coverage and deep parallelism.",
    agentCount: 50,
    category: "roster",
  },
  {
    id: "review",
    label: "Review & Red Team",
    description: "Fast critique and adversarial validation.",
    agentCount: 2,
    category: "strategy",
  },
  {
    id: "explore",
    label: "Scouts",
    description: "Lightweight discovery and direction setting.",
    agentCount: 2,
    category: "strategy",
  },
];

export interface SwarmDraftState {
  projectId: ProjectId | null;
  name: string;
  mission: string;
  templateId: SwarmTemplateId;
  agents: SwarmAgentDraft[];
  startPrompt?: string;
  targetPath?: string;
  contextFiles: SwarmContextFileDraft[];
  skills: SwarmSkillId[];
  uploadedSkills: SwarmUploadedSkillDraft[];
  selectedUploadedSkillIds: string[];
}

export interface SwarmDraftActions {
  setProject: (projectId: ProjectId | null) => void;
  setName: (name: string) => void;
  setMission: (mission: string) => void;
  setTemplate: (templateId: SwarmTemplateId) => void;
  setStartPrompt: (prompt: string) => void;
  setTargetPath: (path: string) => void;
  setSkills: (skills: SwarmSkillId[]) => void;
  addUploadedSkills: (skills: SwarmUploadedSkillDraft[]) => void;
  removeUploadedSkill: (skillId: string) => void;
  toggleUploadedSkill: (skillId: string) => void;
  addAgent: (agent: SwarmAgentDraft) => void;
  updateAgent: (agentId: string, patch: Partial<SwarmAgentDraft>) => void;
  removeAgent: (agentId: string) => void;
  addContextFile: (file: SwarmContextFileDraft) => void;
  removeContextFile: (fileId: string) => void;
  reset: (projectId?: ProjectId | null) => void;
  buildConfig: () => SwarmConfig | null;
}

const reasoningOpts = getReasoningEffortOptions("codex");

const ROLE_ORDER: SwarmAgentRole[] = ["coordinator", "builder", "reviewer", "scout"];

const roleDefaults: Record<
  SwarmAgentRole,
  {
    runtimeMode: RuntimeMode;
    serviceTier: ProviderServiceTier;
    reasoningEffort: ReasoningEffort;
    fastMode: boolean;
  }
> = {
  coordinator: {
    runtimeMode: "full-access",
    serviceTier: "flex" as ProviderServiceTier,
    reasoningEffort: (reasoningOpts[0] ?? "low") as ReasoningEffort,
    fastMode: false,
  },
  builder: {
    runtimeMode: "full-access",
    serviceTier: "flex" as ProviderServiceTier,
    reasoningEffort: (reasoningOpts[1] ?? "medium") as ReasoningEffort,
    fastMode: false,
  },
  reviewer: {
    runtimeMode: "full-access",
    serviceTier: "fast" as ProviderServiceTier,
    reasoningEffort: (reasoningOpts[2] ?? "high") as ReasoningEffort,
    fastMode: true,
  },
  scout: {
    runtimeMode: "full-access",
    serviceTier: "fast" as ProviderServiceTier,
    reasoningEffort: (reasoningOpts[1] ?? "medium") as ReasoningEffort,
    fastMode: true,
  },
};

const buildAgents = (
  roles: SwarmAgentRole[],
  seed: string,
  provider: ProviderKind = ProviderDriverKind.make("opencode"),
): SwarmAgentDraft[] =>
  roles.map((role, index) => ({
    id: `${seed}-${role}-${index + 1}`,
    name: "",
    role,
    model: getDefaultModel(provider),
    provider,
    runtimeMode: roleDefaults[role].runtimeMode,
    interactionMode: "default",
    serviceTier: roleDefaults[role].serviceTier,
    modelOptions: [],
    reasoningEffort: roleDefaults[role].reasoningEffort,
    fastMode: roleDefaults[role].fastMode,
  }));

const DEFAULT_PROVIDER: ProviderKind = ProviderDriverKind.make("opencode");

const rosterFromDistribution = (
  distribution: Partial<Record<SwarmAgentRole, number>>,
  seed: string,
  provider: ProviderKind = DEFAULT_PROVIDER,
) => {
  const roles: SwarmAgentRole[] = [];
  ROLE_ORDER.forEach((role) => {
    const count = distribution[role] ?? 0;
    for (let i = 0; i < count; i += 1) {
      roles.push(role);
    }
  });
  return buildAgents(roles, seed, provider);
};

const defaultAgents: Record<SwarmTemplateId, SwarmAgentDraft[]> = {
  trio: rosterFromDistribution(
    { coordinator: 1, builder: 1, reviewer: 1 },
    "trio",
    DEFAULT_PROVIDER,
  ),
  squad: rosterFromDistribution(
    { coordinator: 1, builder: 2, reviewer: 1, scout: 1 },
    "squad",
    DEFAULT_PROVIDER,
  ),
  team: rosterFromDistribution(
    { coordinator: 1, builder: 5, reviewer: 2, scout: 2 },
    "team",
    DEFAULT_PROVIDER,
  ),
  platoon: rosterFromDistribution(
    { coordinator: 1, builder: 8, reviewer: 3, scout: 3 },
    "platoon",
    DEFAULT_PROVIDER,
  ),
  battalion: rosterFromDistribution(
    { coordinator: 1, builder: 11, reviewer: 4, scout: 4 },
    "battalion",
    DEFAULT_PROVIDER,
  ),
  legion: rosterFromDistribution(
    { coordinator: 2, builder: 32, reviewer: 8, scout: 8 },
    "legion",
    DEFAULT_PROVIDER,
  ),
  review: rosterFromDistribution({ reviewer: 1, scout: 1 }, "review", DEFAULT_PROVIDER),
  explore: rosterFromDistribution({ coordinator: 1, scout: 1 }, "explore", DEFAULT_PROVIDER),
};

const createInitialState = (projectId: ProjectId | null = null): SwarmDraftState => ({
  projectId,
  name: "New Swarm",
  mission: "",
  templateId: "squad",
  agents: defaultAgents.squad.map((agent) => ({ ...agent })),
  startPrompt: "",
  targetPath: "",
  contextFiles: [],
  skills: [] as SwarmSkillId[],
  uploadedSkills: [],
  selectedUploadedSkillIds: [],
});

const SWARM_DRAFT_STORAGE_KEY = "t3code:swarm-draft:v1";
const SWARM_DRAFT_STORAGE_VERSION = 1;

const swarmDraftStorage =
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage();

export const useSwarmDraftStore = create<SwarmDraftState & SwarmDraftActions>()(
  persist(
    (set, get) => ({
      ...createInitialState(),
      setProject: (projectId) => set({ projectId }),
      setName: (name) => set({ name }),
      setMission: (mission) => set({ mission }),
      setTemplate: (templateId) =>
        set(() => ({
          templateId,
          agents: defaultAgents[templateId].map((agent) => Object.assign({}, agent)),
        })),
      setStartPrompt: (prompt) => set({ startPrompt: prompt }),
      setTargetPath: (path) => set({ targetPath: path }),
      setSkills: (skills) => set({ skills }),
      addUploadedSkills: (incomingSkills) =>
        set((state) => {
          const existingByPath = new Map(state.uploadedSkills.map((skill) => [skill.path, skill]));
          incomingSkills.forEach((skill) => existingByPath.set(skill.path, skill));
          return { uploadedSkills: Array.from(existingByPath.values()) };
        }),
      removeUploadedSkill: (skillId) =>
        set((state) => ({
          uploadedSkills: state.uploadedSkills.filter((skill) => skill.id !== skillId),
          selectedUploadedSkillIds: state.selectedUploadedSkillIds.filter((id) => id !== skillId),
        })),
      toggleUploadedSkill: (skillId) =>
        set((state) => ({
          selectedUploadedSkillIds: state.selectedUploadedSkillIds.includes(skillId)
            ? state.selectedUploadedSkillIds.filter((id) => id !== skillId)
            : [...state.selectedUploadedSkillIds, skillId],
        })),
      addAgent: (agent) => set((state) => ({ agents: [...state.agents, agent] })),
      updateAgent: (agentId, patch) =>
        set((state) => ({
          agents: state.agents.map((agent) =>
            agent.id === agentId ? { ...agent, ...patch } : agent,
          ),
        })),
      removeAgent: (agentId) =>
        set((state) => ({
          agents: state.agents.filter((agent) => agent.id !== agentId),
        })),
      addContextFile: (file) => set((state) => ({ contextFiles: [...state.contextFiles, file] })),
      removeContextFile: (fileId) =>
        set((state) => ({
          contextFiles: state.contextFiles.filter((f) => f.id !== fileId),
        })),
      reset: (projectId = null) =>
        set((state) => ({
          ...createInitialState(projectId),
          uploadedSkills: state.uploadedSkills,
        })),
      buildConfig: () => {
        const state = get();
        if (!state.projectId) return null;
        if (state.agents.length === 0) return null;
        const selectedUploadedSkills = state.uploadedSkills.filter((skill) =>
          state.selectedUploadedSkillIds.includes(skill.id),
        );
        return {
          name: state.name.trim() || "Swarm",
          mission: state.mission.trim() || "Coordinate agents on this project",
          templateId: state.templateId,
          startPrompt: state.startPrompt?.trim() || undefined,
          targetPath: state.targetPath?.trim() || undefined,
          skills: state.skills,
          uploadedSkills: selectedUploadedSkills,
          autoStart: false,
          agents: state.agents.map((agent) => ({
            id: agent.id,
            name: agent.role,
            role: agent.role as SwarmAgentRole,
            provider: agent.provider,
            ...(agent.providerInstanceId ? { providerInstanceId: agent.providerInstanceId } : {}),
            model: agent.model ?? getDefaultModel(agent.provider as ProviderKind),
            runtimeMode: (agent.runtimeMode as RuntimeMode) ?? "full-access",
            interactionMode: (agent.interactionMode as ProviderInteractionMode) ?? "default",
            serviceTier: agent.serviceTier === "flex" ? null : (agent.serviceTier ?? null),
            modelOptions: agent.modelOptions,
            reasoningEffort: agent.reasoningEffort,
            fastMode: agent.fastMode,
          })),
          contextFiles: state.contextFiles.map((f) => ({
            id: f.id,
            name: f.name,
            path: f.path,
            type: f.type,
          })),
        };
      },
    }),
    {
      name: SWARM_DRAFT_STORAGE_KEY,
      version: SWARM_DRAFT_STORAGE_VERSION,
      storage: createJSONStorage(() => swarmDraftStorage),
      partialize: (state) => ({ uploadedSkills: state.uploadedSkills }),
      merge: (persisted, current) => ({
        ...current,
        ...(typeof persisted === "object" && persisted !== null ? persisted : {}),
        selectedUploadedSkillIds: [],
      }),
    },
  ),
);
