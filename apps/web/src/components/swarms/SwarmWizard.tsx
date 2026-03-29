import { useMemo, useState, useEffect, useRef } from "react";
import type { ProjectId, SwarmConfig, ProviderKind, SwarmContextFile } from "@t3tools/contracts";
import {
  getModelOptions,
  getReasoningEffortOptions,
  getDefaultModel,
  getDefaultReasoningEffort,
} from "@t3tools/shared/model";
import { useAppSettings } from "../../appSettings";
import { PROVIDER_OPTIONS } from "../../session-logic";
import { ModelPicker } from "../ModelPicker";
import { cn } from "../../lib/utils";
import {
  Network,
  Check,
  Zap,
  Trash2,
  Plus,
  Info,
  ArrowRight,
  ArrowLeft,
  Loader2,
  CheckSquare,
  Square,
  Bot,
  FileText,
  Image,
  File,
  FileArchive,
  Upload,
  ShieldCheck,
  RotateCcw,
  Hammer,
  PackageCheck,
  Beaker,
  Code2,
  BookOpen,
  Sparkles,
  Accessibility,
  Activity,
  GitBranch,
  TrendingUp,
} from "lucide-react";

import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SWARM_SKILL_CATEGORIES } from "@t3tools/shared/swarmSkills";
import type { SwarmSkillId } from "@t3tools/shared/swarmSkills";
import {
  useSwarmDraftStore,
  SWARM_TEMPLATE_OPTIONS,
  type SwarmTemplateId,
  type SwarmContextFileDraft,
} from "./SwarmDraftStore";

type SwarmWizardProps = {
  projectId: ProjectId | null;
  onCreate: (config: SwarmConfig) => Promise<void> | void;
  busy?: boolean;
};

const STEPS = [
  { id: 1, title: "Swarm Name" },
  { id: 2, title: "Mission Brief" },
  { id: 3, title: "Context" },
  { id: 4, title: "Agent Roster" },
] as const;

const ROLE_OPTIONS = [
  { value: "coordinator", label: "Coordinator" },
  { value: "builder", label: "Builder" },
  { value: "reviewer", label: "Reviewer" },
  { value: "scout", label: "Scout" },
] as const;

const RUNTIME_MODE_OPTIONS = [
  { value: "full-access", label: "Full access" },
  { value: "approval-required", label: "Supervised" },
] as const;

const FILE_TYPE_OPTIONS: {
  value: SwarmContextFile["type"];
  label: string;
  icon: React.ElementType;
}[] = [
  { value: "file", label: "File", icon: File },
  { value: "spec", label: "Spec", icon: FileText },
  { value: "log", label: "Log", icon: FileText },
  { value: "pdf", label: "PDF", icon: FileArchive },
  { value: "image", label: "Image", icon: Image },
  { value: "other", label: "Other", icon: File },
];

function getFileIcon(type: SwarmContextFile["type"]) {
  const option = FILE_TYPE_OPTIONS.find((o) => o.value === type);
  return option?.icon ?? File;
}

const SKILL_ICON_MAP: Record<SwarmSkillId, React.ElementType> = {
  incremental_commits: RotateCcw,
  refactor_only: Hammer,
  monorepo_aware: PackageCheck,
  test_driven: Beaker,
  code_review: Code2,
  documentation: BookOpen,
  security_audit: ShieldCheck,
  dry_principle: Sparkles,
  accessibility: Accessibility,
  keep_ci_green: Activity,
  migration_safe: GitBranch,
  performance: TrendingUp,
};

const SKILL_CATEGORIES = SWARM_SKILL_CATEGORIES.map((category) => ({
  ...category,
  skills: category.skills.map((skill) => ({
    ...skill,
    icon: SKILL_ICON_MAP[skill.id] ?? Sparkles,
  })),
}));

export function SwarmWizard({ projectId, onCreate, busy = false }: SwarmWizardProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const { settings } = useAppSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    name,
    mission,
    templateId,
    agents,
    startPrompt,
    contextFiles,
    skills,
    setName,
    setMission,
    setTemplate,
    addAgent,
    updateAgent,
    removeAgent,
    buildConfig,
    setStartPrompt,
    setSkills,
    addContextFile,
    removeContextFile,
  } = useSwarmDraftStore();

  const availableProviders = PROVIDER_OPTIONS.filter((p) => p.available).map(
    (p) => p.value as ProviderKind,
  );
  const defaultProvider: ProviderKind = availableProviders[0] ?? "opencode";
  const reasoningOptions = useMemo(
    () => (defaultProvider === "codex" ? getReasoningEffortOptions("codex") : []),
    [defaultProvider],
  );
  const defaultReasoning = (reasoningOptions[1] ?? "medium") as "low" | "medium" | "high" | "xhigh";
  const defaultModel =
    getModelOptions(defaultProvider)[0]?.slug ?? getDefaultModel(defaultProvider);

  // Local state for the bulk-action ModelPicker to display correct values visually
  const [bulkProvider, setBulkProvider] = useState<ProviderKind>(defaultProvider);
  const [bulkModel, setBulkModel] = useState<string>(defaultModel);

  useEffect(() => {
    const currentIds = new Set(agents.map((a) => a.id));
    setSelectedAgents((prev) => prev.filter((id) => currentIds.has(id)));
  }, [agents]);

  const handleTemplateChange = (value: string | null) => {
    if (value) {
      setTemplate(value as SwarmTemplateId);
      setSelectedAgents([]);
    }
  };

  const toggleAgentSelection = (id: string) => {
    setSelectedAgents((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  };

  const handleSelectAll = () => {
    if (selectedAgents.length === agents.length) {
      setSelectedAgents([]);
    } else {
      setSelectedAgents(agents.map((a) => a.id));
    }
  };

  const applyBulkUpdate = (updates: Partial<(typeof agents)[0]>) => {
    selectedAgents.forEach((id) => updateAgent(id, updates));
  };

  const handleToggleSkill = (skillId: SwarmSkillId) => {
    const nextSkills = skills.includes(skillId)
      ? skills.filter((id) => id !== skillId)
      : [...skills, skillId];
    setSkills(nextSkills);
  };

  const canProceed = () => {
    if (currentStep === 1) return (name || "").trim().length > 0;
    if (currentStep === 4) return agents.length > 0;
    return true;
  };

  const handleNext = () => {
    if (currentStep < STEPS.length) {
      setCurrentStep(currentStep + 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  const handleCreate = () => {
    const config = buildConfig();
    if (!config) return;
    void onCreate({
      ...config,
      enableTasks: settings.enableSwarmTasks ?? false,
    });
  };

  return (
    <div className="flex h-full max-h-[100dvh] min-h-[500px] w-full flex-col overflow-hidden bg-background/95 text-foreground">
      {/* Header & Progress */}
      <header className="z-30 flex-none border-b border-border/50 bg-background/80 px-6 py-5 backdrop-blur-md">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Network className="size-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Build your Swarm</h2>
              <p className="text-sm text-muted-foreground">
                Configure mission parameters and fine-tune your specialized agent roster.
              </p>
            </div>
          </div>

          <div className="mt-8 flex items-center justify-between gap-2 sm:justify-start sm:gap-4">
            {STEPS.map((step, idx) => {
              const isActive = currentStep === step.id;
              const isPast = currentStep > step.id;

              return (
                <div key={step.id} className="flex items-center gap-2 sm:gap-4">
                  <div
                    className={`flex items-center gap-2.5 transition-colors duration-300 ${isActive ? "text-foreground" : isPast ? "text-primary" : "text-muted-foreground/50"}`}
                  >
                    <div
                      className={`flex size-7 items-center justify-center rounded-full text-xs font-semibold ring-1 transition-all duration-300 ${
                        isActive
                          ? "bg-primary text-primary-foreground ring-primary shadow-[0_0_12px_rgba(var(--primary),0.4)]"
                          : isPast
                            ? "bg-primary/10 text-primary ring-primary/30"
                            : "bg-muted/30 text-muted-foreground ring-border/50"
                      }`}
                    >
                      {isPast ? <Check className="size-4" strokeWidth={3} /> : idx + 1}
                    </div>
                    <span
                      className={`hidden text-sm font-medium md:inline-block ${isActive ? "font-semibold" : ""}`}
                    >
                      {step.title}
                    </span>
                  </div>
                  {idx < STEPS.length - 1 && (
                    <div
                      className={`h-px w-6 transition-colors duration-300 sm:w-12 ${isPast ? "bg-primary/50" : "bg-border/50"}`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden bg-muted/10 px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-5xl space-y-8 pb-32">
          {currentStep === 1 && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <Card className="border-border/50 bg-background shadow-sm">
                <CardHeader>
                  <CardTitle>Swarm Identity</CardTitle>
                  <CardDescription>
                    Give your swarm a recognizable name to track its progress.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="swarm-name">Swarm Name</Label>
                    <Input
                      id="swarm-name"
                      value={name || ""}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Frontend Migration Team"
                      className="h-12 bg-muted/20 text-base transition-colors hover:bg-muted/40 focus-visible:ring-primary/30"
                      autoFocus
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {currentStep === 2 && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <Card className="border-border/50 bg-background shadow-sm">
                <CardHeader>
                  <CardTitle>Mission Brief</CardTitle>
                  <CardDescription>
                    Define exactly what this swarm needs to accomplish.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-8">
                  <div className="space-y-2">
                    <Label htmlFor="swarm-mission">Primary Mission</Label>
                    <Textarea
                      id="swarm-mission"
                      value={mission || ""}
                      placeholder="Describe the overall goal, architecture constraints, and definition of done..."
                      onChange={(e) => setMission(e.target.value)}
                      className="min-h-[140px] resize-y bg-muted/20 p-4 text-base leading-relaxed transition-colors hover:bg-muted/40 focus-visible:ring-primary/30"
                      autoFocus
                    />
                  </div>

                  <div className="space-y-6 rounded-3xl border border-border/60 bg-muted/30 p-6 min-h-[420px]">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold text-foreground">Skill Focus</p>
                        <p className="text-xs text-muted-foreground">
                          Pick the capabilities that describe how this swarm should contribute.
                        </p>
                      </div>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Multi-select
                      </span>
                    </div>

                    <div className="space-y-6">
                      {SKILL_CATEGORIES.map((category) => (
                        <div key={category.id} className="space-y-3">
                          <div className="flex items-baseline justify-between gap-4">
                            <p className="text-sm font-semibold text-foreground">
                              {category.label}
                            </p>
                            <p className="text-xs text-muted-foreground">{category.description}</p>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2">
                            {category.skills.map((skill) => {
                              const Icon = skill.icon;
                              const isSelected = skills.includes(skill.id);

                              return (
                                <button
                                  key={skill.id}
                                  type="button"
                                  onClick={() => handleToggleSkill(skill.id)}
                                  aria-pressed={isSelected}
                                  className={cn(
                                    "group flex items-start gap-3 rounded-2xl border p-4 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                    isSelected
                                      ? "border-primary/60 bg-primary/10 text-foreground shadow-lg shadow-primary/10"
                                      : "border-border/50 bg-background hover:border-primary/50 hover:bg-muted/40",
                                  )}
                                >
                                  <span
                                    className={cn(
                                      "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
                                      isSelected
                                        ? "bg-primary/20 text-primary"
                                        : "bg-muted/10 text-muted-foreground",
                                    )}
                                  >
                                    <Icon className="size-5" />
                                  </span>
                                  <div className="flex flex-col gap-1">
                                    <p className="text-sm font-semibold">{skill.label}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {skill.description}
                                    </p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {currentStep === 3 && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <Card className="border-border/50 bg-background shadow-sm">
                <CardHeader>
                  <CardTitle>Supporting Context</CardTitle>
                  <CardDescription>
                    Share a start prompt or attach files so every agent arrives with the same
                    context.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="swarm-start">Start Prompt</Label>
                      <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Optional
                      </span>
                    </div>
                    <Textarea
                      id="swarm-start"
                      value={startPrompt ?? ""}
                      onChange={(e) => setStartPrompt(e.target.value)}
                      placeholder="Shared context or rules delivered to all agents."
                      className="min-h-[140px] resize-y bg-muted/20 transition-colors hover:bg-muted/40 focus-visible:ring-primary/30"
                    />
                    <p className="text-xs text-muted-foreground">
                      Provide primary goals, guardrails, or operating constraints that every agent
                      should inherit.
                    </p>
                  </div>

                  <div
                    className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border/50 bg-muted/20 p-8 transition-colors hover:border-primary/50 hover:bg-muted/30"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="mb-3 size-10 text-muted-foreground" />
                    <p className="text-sm font-medium text-foreground">
                      Click to add files or drag and drop
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Supports: files, specs, logs, PDFs, images
                    </p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = e.target.files;
                        if (!files) return;
                        Array.from(files).forEach((file) => {
                          const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
                          let type: SwarmContextFile["type"] = "file";
                          if (["pdf"].includes(ext)) type = "pdf";
                          else if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext))
                            type = "image";
                          else if (["log", "txt"].includes(ext)) type = "log";
                          else if (
                            ["spec", "md", "json", "yaml", "yml"].includes(ext) ||
                            file.name.toLowerCase().includes("spec")
                          )
                            type = "spec";
                          else type = "other";
                          const draftFile: SwarmContextFileDraft = {
                            id: crypto.randomUUID(),
                            name: file.name,
                            path: file.name,
                            type,
                          };
                          addContextFile(draftFile);
                        });
                        e.target.value = "";
                      }}
                    />
                  </div>

                  {contextFiles.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">
                        Attached Files ({contextFiles.length})
                      </Label>
                      <div className="max-h-60 space-y-2 overflow-y-auto">
                        {contextFiles.map((file) => {
                          const Icon = getFileIcon(file.type);
                          return (
                            <div
                              key={file.id}
                              className="flex items-center justify-between rounded-md border border-border/50 bg-muted/20 p-3"
                            >
                              <div className="flex items-center gap-3 overflow-hidden">
                                <Icon className="size-5 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-medium">{file.name}</p>
                                  <p className="truncate text-xs text-muted-foreground">
                                    {file.path}
                                  </p>
                                </div>
                                <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
                                  {file.type}
                                </span>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="ml-2 size-7 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => removeContextFile(file.id)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Step 4: Roster */}
          {currentStep === 4 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <Card className="overflow-hidden border-primary/20 bg-primary/5 shadow-sm">
                <CardContent className="p-6">
                  <div className="space-y-2">
                    <Label className="text-primary">Architecture Template</Label>
                    <p className="pb-2 text-xs text-muted-foreground">
                      Applying a preset instantly loads a predefined roster of specialized agents.
                    </p>
                    <Select value={templateId ?? undefined} onValueChange={handleTemplateChange}>
                      <SelectTrigger className="h-12 bg-background text-base shadow-sm hover:bg-muted/50 focus-visible:ring-primary/40">
                        <SelectValue placeholder="Custom (No Preset Selected)" />
                      </SelectTrigger>
                      <SelectContent>
                        {SWARM_TEMPLATE_OPTIONS.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{option.label}</span>
                              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                {option.agentCount} agents
                              </span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <div className="space-y-4">
                {/* Floating Bulk Command Bar */}
                <div className="sticky top-0 z-20 -mx-4 bg-background/80 px-4 py-3 backdrop-blur-md sm:mx-0 sm:rounded-xl sm:border sm:border-border/50 sm:px-4 sm:shadow-sm">
                  {selectedAgents.length > 0 ? (
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between animate-in fade-in zoom-in-95">
                      <div className="flex items-center gap-3">
                        <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-sm">
                          {selectedAgents.length}
                        </span>
                        <span className="text-sm font-semibold text-primary">Agents Selected</span>
                        <div className="hidden h-4 w-px bg-border sm:block" />
                        <button
                          onClick={() => setSelectedAgents([])}
                          className="hidden text-sm text-muted-foreground hover:text-foreground sm:block"
                        >
                          Clear selection
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <ModelPicker
                          provider={bulkProvider}
                          model={bulkModel}
                          onProviderModelChange={(provider, model) => {
                            setBulkProvider(provider);
                            setBulkModel(model);
                            applyBulkUpdate({ provider, model });
                          }}
                          className="h-8 w-[200px]"
                        />

                        <Select
                          onValueChange={(val) => applyBulkUpdate({ reasoningEffort: val as any })}
                        >
                          <SelectTrigger className="h-8 w-[120px] bg-background text-xs">
                            <SelectValue placeholder="Reasoning" />
                          </SelectTrigger>
                          <SelectContent>
                            {reasoningOptions.map((opt) => (
                              <SelectItem key={opt} value={opt} className="text-xs capitalize">
                                {opt}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select
                          onValueChange={(val) => applyBulkUpdate({ runtimeMode: val as any })}
                        >
                          <SelectTrigger className="h-8 w-[140px] bg-background text-xs">
                            <SelectValue placeholder="Access" />
                          </SelectTrigger>
                          <SelectContent>
                            {RUNTIME_MODE_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value} className="text-xs">
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <button
                          onClick={() => setSelectedAgents([])}
                          className="text-xs text-muted-foreground hover:text-foreground sm:hidden"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <button
                          onClick={handleSelectAll}
                          className="group flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {selectedAgents.length === agents.length && agents.length > 0 ? (
                            <CheckSquare className="size-5 text-primary" />
                          ) : (
                            <Square className="size-5 opacity-50 group-hover:opacity-100" />
                          )}
                          Select All
                        </button>
                      </div>

                      <Button
                        variant="secondary"
                        size="sm"
                        className="group h-9 gap-2 shadow-sm transition-all"
                        onClick={() =>
                          addAgent({
                            id: crypto.randomUUID(),
                            role: "builder",
                            model: defaultModel,
                            provider: defaultProvider,
                            runtimeMode: "full-access",
                            interactionMode: "default",
                            serviceTier: "flex",
                            modelOptions: {},
                            reasoningEffort: defaultReasoning,
                            fastMode: false,
                          })
                        }
                      >
                        <Plus className="size-4 transition-transform duration-300 ease-in-out group-hover:rotate-90" />
                        Add Agent
                      </Button>
                    </div>
                  )}
                </div>

                {/* Agent Cards */}
                <div className="space-y-4">
                  {agents.map((agent, index) => {
                    const isSelected = selectedAgents.includes(agent.id);

                    return (
                      <Card
                        key={agent.id}
                        className={`group relative overflow-hidden transition-all duration-200 ${
                          isSelected
                            ? "border-primary/50 bg-primary/[0.02] ring-1 ring-primary/20"
                            : "border-border/50 bg-background hover:border-primary/30 hover:shadow-md"
                        }`}
                      >
                        <div
                          className={`flex items-center justify-between border-b px-5 py-3 transition-colors ${
                            isSelected
                              ? "border-primary/20 bg-primary/5"
                              : "border-border/50 bg-muted/20"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => toggleAgentSelection(agent.id)}
                              className="text-muted-foreground transition-colors hover:text-foreground"
                            >
                              {isSelected ? (
                                <CheckSquare className="size-5 text-primary" />
                              ) : (
                                <Square className="size-5 opacity-50" />
                              )}
                            </button>
                            <div className="flex items-center gap-2">
                              <Bot
                                className={`size-4 ${isSelected ? "text-primary" : "text-muted-foreground"}`}
                              />
                              <span
                                className={`text-sm font-semibold ${isSelected ? "text-primary" : "text-foreground"}`}
                              >
                                Agent {index + 1}
                              </span>
                            </div>
                          </div>

                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => {
                              removeAgent(agent.id);
                              setSelectedAgents((prev) => prev.filter((id) => id !== agent.id));
                            }}
                            disabled={agents.length <= 1}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>

                        <CardContent className="grid gap-5 p-5 sm:grid-cols-2 lg:grid-cols-6">
                          <div className="space-y-1.5 lg:col-span-1">
                            <Label className="text-xs text-muted-foreground">Role</Label>
                            <Select
                              value={agent.role ?? undefined}
                              onValueChange={(val) => updateAgent(agent.id, { role: val as any })}
                            >
                              <SelectTrigger
                                className={`h-9 ${isSelected ? "border-primary/30 bg-background" : "bg-muted/20"}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {ROLE_OPTIONS.map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-1.5 lg:col-span-2">
                            <Label className="text-xs text-muted-foreground">
                              Provider & Model
                            </Label>
                            <ModelPicker
                              provider={agent.provider ?? defaultProvider}
                              model={
                                agent.model ?? getDefaultModel(agent.provider ?? defaultProvider)
                              }
                              onProviderModelChange={(provider, model) =>
                                updateAgent(agent.id, { provider, model })
                              }
                              className={cn(
                                "w-full",
                                isSelected
                                  ? "border-primary/30 bg-background shadow-sm"
                                  : "bg-muted/20",
                              )}
                            />
                          </div>

                          <div className="space-y-1.5 lg:col-span-1">
                            <Label className="text-xs text-muted-foreground">Reasoning</Label>
                            <Select
                              value={
                                agent.reasoningEffort ??
                                getDefaultReasoningEffort(agent.provider ?? defaultProvider) ??
                                defaultReasoning
                              }
                              onValueChange={(val) =>
                                updateAgent(agent.id, { reasoningEffort: val as any })
                              }
                              disabled={agent.provider !== "codex"}
                            >
                              <SelectTrigger
                                className={`h-9 ${isSelected ? "border-primary/30 bg-background" : "bg-muted/20"}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {getReasoningEffortOptions(agent.provider ?? defaultProvider).map(
                                  (opt) => (
                                    <SelectItem key={opt} value={opt} className="capitalize">
                                      {opt}
                                    </SelectItem>
                                  ),
                                )}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-1.5 lg:col-span-1">
                            <Label className="text-xs text-muted-foreground">Access</Label>
                            <Select
                              value={agent.runtimeMode ?? "full-access"}
                              onValueChange={(val) =>
                                updateAgent(agent.id, { runtimeMode: val as any })
                              }
                            >
                              <SelectTrigger
                                className={`h-9 ${isSelected ? "border-primary/30 bg-background" : "bg-muted/20"}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {RUNTIME_MODE_OPTIONS.map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-1.5 lg:col-span-1">
                            <Label className="text-xs text-muted-foreground">Optimization</Label>
                            <button
                              type="button"
                              onClick={() => updateAgent(agent.id, { fastMode: !agent.fastMode })}
                              className={`flex h-9 w-full items-center justify-between rounded-md border px-3 text-sm font-medium transition-all ${
                                agent.fastMode
                                  ? "border-primary/50 bg-primary/10 text-primary ring-1 ring-primary/20 shadow-sm shadow-primary/10"
                                  : `border-border/50 text-muted-foreground hover:bg-muted/50 hover:text-foreground ${isSelected ? "bg-background border-primary/30" : "bg-muted/20"}`
                              }`}
                            >
                              <span className="flex items-center gap-2">
                                <Zap
                                  className={`size-4 ${agent.fastMode ? "fill-amber-500 text-amber-500 animate-pulse drop-shadow-[0_0_8px_rgba(245,158,11,0.6)]" : ""}`}
                                />
                                Fast Mode
                              </span>
                              <div
                                className={`flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${agent.fastMode ? "bg-amber-500" : "bg-muted-foreground/30"}`}
                              >
                                <div
                                  className={`size-3 rounded-full bg-background shadow-sm transition-transform ${agent.fastMode ? "translate-x-3" : "translate-x-0"}`}
                                />
                              </div>
                            </button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer Actions */}
      <footer className="z-30 flex-none border-t border-border/50 bg-background/80 px-6 py-4 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex">
            <Info className="size-4" />
            <p>Ready to deploy your configured agents.</p>
          </div>

          <div className="flex w-full items-center justify-end gap-3 sm:w-auto">
            <Button
              variant="outline"
              className="group w-full gap-2 transition-all sm:w-auto"
              onClick={handleBack}
              disabled={currentStep === 1}
            >
              <ArrowLeft className="size-4 transition-transform duration-300 ease-in-out group-hover:-translate-x-1" />
              Back
            </Button>

            {currentStep < STEPS.length ? (
              <Button
                className="group w-full gap-2 transition-all sm:w-auto"
                onClick={handleNext}
                disabled={!canProceed()}
              >
                Next Step
                <ArrowRight className="size-4 transition-transform duration-300 ease-in-out group-hover:translate-x-1" />
              </Button>
            ) : (
              <Button
                className="group w-full gap-2 transition-all sm:w-auto"
                onClick={handleCreate}
                disabled={busy || agents.length === 0 || !projectId}
              >
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Deploying...
                  </>
                ) : (
                  <>
                    Launch Swarm
                    <ArrowRight className="size-4 transition-transform duration-300 ease-in-out group-hover:translate-x-1" />
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
