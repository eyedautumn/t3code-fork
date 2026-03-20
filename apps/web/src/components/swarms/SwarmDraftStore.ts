import { create } from "zustand";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ProjectId,
  type SwarmAgent,
  type SwarmConfig,
  type SwarmAgentRole,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ProviderServiceTier,
  type ProviderKind,
} from "@t3tools/contracts";
import { getDefaultModel, getReasoningEffortOptions } from "@t3tools/shared/model";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type SwarmAgentDraft = Omit<SwarmAgent, "name" | "reasoningEffort" | "modelOptions" | "fastMode"> & {
  reasoningEffort?: ReasoningEffort;
  modelOptions?: Record<string, unknown>;
  fastMode?: boolean;
};

export type SwarmTemplateId =
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
}

export interface SwarmDraftActions {
  setProject: (projectId: ProjectId | null) => void;
  setName: (name: string) => void;
  setMission: (mission: string) => void;
  setTemplate: (templateId: SwarmTemplateId) => void;
  setStartPrompt: (prompt: string) => void;
  setTargetPath: (path: string) => void;
  addAgent: (agent: SwarmAgentDraft) => void;
  updateAgent: (agentId: string, patch: Partial<SwarmAgentDraft>) => void;
  removeAgent: (agentId: string) => void;
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
    runtimeMode: "approval-required",
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

const buildAgents = (roles: SwarmAgentRole[], seed: string, provider: ProviderKind = "opencode"): SwarmAgentDraft[] =>
  roles.map((role, index) => ({
    id: `${seed}-${role}-${index + 1}`,
    name: "",
    role,
    model: DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL_BY_PROVIDER.codex,
    provider,
    runtimeMode: roleDefaults[role].runtimeMode,
    interactionMode: "default",
    serviceTier: roleDefaults[role].serviceTier,
    modelOptions: {},
    reasoningEffort: roleDefaults[role].reasoningEffort,
    fastMode: roleDefaults[role].fastMode,
  }));

const DEFAULT_PROVIDER: ProviderKind = "opencode";

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
  squad: rosterFromDistribution({ coordinator: 1, builder: 2, reviewer: 1, scout: 1 }, "squad", DEFAULT_PROVIDER),
  team: rosterFromDistribution({ coordinator: 1, builder: 5, reviewer: 2, scout: 2 }, "team", DEFAULT_PROVIDER),
  platoon: rosterFromDistribution({ coordinator: 1, builder: 8, reviewer: 3, scout: 3 }, "platoon", DEFAULT_PROVIDER),
  battalion: rosterFromDistribution({ coordinator: 1, builder: 11, reviewer: 4, scout: 4 }, "battalion", DEFAULT_PROVIDER),
  legion: rosterFromDistribution({ coordinator: 2, builder: 32, reviewer: 8, scout: 8 }, "legion", DEFAULT_PROVIDER),
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
});

export const useSwarmDraftStore = create<SwarmDraftState & SwarmDraftActions>((set, get) => ({
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
  reset: (projectId = null) => set(createInitialState(projectId)),
  buildConfig: () => {
    const state = get();
    if (!state.projectId) return null;
    if (state.agents.length === 0) return null;
    return {
      name: state.name.trim() || "Swarm",
      mission: state.mission.trim() || "Coordinate agents on this project",
      templateId: state.templateId,
      startPrompt: state.startPrompt?.trim() || undefined,
      targetPath: state.targetPath?.trim() || undefined,
      autoStart: false,
      agents: state.agents.map((agent) => ({
        id: agent.id,
        name: agent.role,
        role: agent.role as SwarmAgentRole,
        provider: agent.provider,
        model: agent.model ?? getDefaultModel(agent.provider as ProviderKind),
        runtimeMode: (agent.runtimeMode as RuntimeMode) ?? "full-access",
        interactionMode: (agent.interactionMode as ProviderInteractionMode) ?? "default",
        serviceTier: agent.serviceTier === "flex" ? null : agent.serviceTier ?? null,
        modelOptions: agent.modelOptions,
        reasoningEffort: agent.reasoningEffort,
        fastMode: agent.fastMode,
      })),
    };
  },
}));
