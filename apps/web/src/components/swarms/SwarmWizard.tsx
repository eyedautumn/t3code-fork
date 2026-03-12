import { useMemo, useState } from "react";
import type { ModelSlug, ProjectId, SwarmConfig, RuntimeMode, ProviderServiceTier } from "@t3tools/contracts";
import { getModelOptions, getReasoningEffortOptions } from "@t3tools/shared/model";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useSwarmDraftStore, SWARM_TEMPLATE_OPTIONS, type SwarmTemplateId } from "./SwarmDraftStore";

type SwarmWizardProps = {
  projectId: ProjectId | null;
  onCreate: (config: SwarmConfig) => Promise<void> | void;
  busy?: boolean;
};

const STEPS = [
  { id: 1, title: "Swarm Name" },
  { id: 2, title: "Mission Brief" },
  { id: 3, title: "Agent Roster" },
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

export function SwarmWizard({ projectId, onCreate, busy = false }: SwarmWizardProps) {
  const [currentStep, setCurrentStep] = useState(1);

  const {
    name,
    mission,
    templateId,
    agents,
    startPrompt,
    targetPath,
    setName,
    setMission,
    setTemplate,
    addAgent,
    updateAgent,
    removeAgent,
    buildConfig,
    setStartPrompt,
    setTargetPath,
  } = useSwarmDraftStore();

  const reasoningOptions = useMemo(() => getReasoningEffortOptions("codex"), []);
  const modelOptions = useMemo(() => getModelOptions("codex"), []);
  const defaultReasoning = reasoningOptions[1] ?? "medium";
  const defaultModel = modelOptions[0]?.slug ?? "claude-sonnet-4-20250514";

  const handleTemplateChange = (value: string | null) => {
    if (value) setTemplate(value as SwarmTemplateId);
  };

  const canProceed = () => {
    if (currentStep === 1) return name.trim().length > 0;
    if (currentStep === 2) return true;
    return agents.length > 0;
  };

  const handleNext = () => {
    if (currentStep < STEPS.length) setCurrentStep(currentStep + 1);
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  const handleCreate = () => {
    const config = buildConfig();
    if (!config) return;
    onCreate(config);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground relative font-sans shadow-xl">
      {/* Sleek Fixed Header */}
      <header className="shrink-0 border-b border-border/40 bg-background/80 px-6 py-6 backdrop-blur-xl z-20 supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto max-w-4xl">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-1 ring-primary/20 shadow-inner">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
            </div>
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-foreground">Build your Swarm</h2>
              <p className="mt-1 text-sm text-muted-foreground/80">
                Choose a template, establish the mission, and fine-tune your agents.
              </p>
            </div>
          </div>

          {/* Modern Step Indicator */}
          <div className="mt-8 flex items-center justify-between gap-2 overflow-hidden sm:justify-start sm:gap-4">
            {STEPS.map((step, idx) => (
              <div key={step.id} className="flex items-center gap-4">
                <div
                  className={`flex items-center gap-2.5 transition-all duration-300 ${
                    currentStep === step.id ? "text-foreground" : currentStep > step.id ? "text-primary" : "text-muted-foreground/50"
                  }`}
                >
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ring-1 transition-all duration-300 ${
                      currentStep === step.id
                        ? "bg-primary text-primary-foreground ring-primary shadow-[0_0_12px_rgba(var(--primary),0.4)]"
                        : currentStep > step.id
                        ? "bg-primary/10 text-primary ring-primary/30"
                        : "bg-muted/30 text-muted-foreground ring-border/50"
                    }`}
                  >
                    {currentStep > step.id ? (
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    ) : (
                      idx + 1
                    )}
                  </div>
                  <span className={`text-sm font-medium hidden sm:inline-block ${currentStep === step.id ? "font-semibold" : ""}`}>
                    {step.title}
                  </span>
                </div>
                {idx < STEPS.length - 1 && (
                  <div className={`h-px w-8 sm:w-12 transition-colors duration-300 ${
                    currentStep > step.id ? "bg-primary/50" : "bg-border/50"
                  }`} />
                )}
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* Main Scrollable Content Area */}
      <main className="flex-1 min-h-0 overflow-y-auto bg-muted/10 scroll-smooth px-4 sm:px-6 z-0">
        <div className="mx-auto max-w-4xl space-y-8 py-8 pb-12">
          
          {/* Step 1: Swarm Name */}
          {currentStep === 1 && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <Card className="border-border/40 bg-card/50 backdrop-blur-sm shadow-sm">
                <CardContent className="p-6 sm:p-8 space-y-4">
                  <div className="space-y-3">
                    <Label htmlFor="swarm-name" className="text-sm font-semibold text-foreground/80">Swarm Name</Label>
                    <Input
                      id="swarm-name"
                      value={name || ""}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="e.g. Next.js Migration Team"
                      className="h-12 text-base px-4 bg-background border-border/50 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary/50"
                    />
                    <p className="text-xs text-muted-foreground/80 pl-1">Give your swarm a recognizable name to track its progress.</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Step 2: Mission Brief */}
          {currentStep === 2 && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <Card className="border-border/40 bg-card/50 backdrop-blur-sm shadow-sm">
                <CardContent className="p-6 sm:p-8 space-y-8">
                  <div className="space-y-3">
                    <Label htmlFor="swarm-mission" className="text-sm font-semibold text-foreground/80">Primary Mission</Label>
                    <Textarea
                      id="swarm-mission"
                      value={mission || ""}
                      placeholder="Describe exactly what this swarm needs to accomplish..."
                      onChange={(event) => setMission(event.target.value)}
                      className="min-h-[140px] resize-y text-base p-4 bg-background leading-relaxed border-border/50 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary/50"
                    />
                  </div>

                  <div className="grid gap-6 md:grid-cols-2">
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <Label htmlFor="swarm-start" className="text-sm font-semibold text-foreground/80">Start Prompt</Label>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-bold bg-muted/50 px-2 py-0.5 rounded-sm">Optional</span>
                      </div>
                      <Textarea
                        id="swarm-start"
                        value={startPrompt ?? ""}
                        onChange={(event) => setStartPrompt(event.target.value)}
                        placeholder="Shared context or rules delivered to all agents."
                        className="min-h-[100px] resize-y bg-background border-border/50 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary/20"
                      />
                    </div>
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <Label htmlFor="swarm-target" className="text-sm font-semibold text-foreground/80">Target Directory</Label>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-bold bg-muted/50 px-2 py-0.5 rounded-sm">Optional</span>
                      </div>
                      <Input
                        id="swarm-target"
                        value={targetPath ?? ""}
                        onChange={(event) => setTargetPath(event.target.value)}
                        placeholder="/src/components"
                        className="h-11 bg-background border-border/50 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary/20"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Step 3: Agent Roster with Architecture Template at the top */}
          {currentStep === 3 && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
              
              {/* Presets Card */}
              <Card className="border-primary/20 bg-primary/5 backdrop-blur-sm shadow-sm overflow-hidden">
                <CardContent className="p-6 sm:p-8">
                  <div className="space-y-3">
                    <Label htmlFor="swarm-template" className="text-sm font-semibold text-primary">Architecture Template (Presets)</Label>
                    <p className="text-xs text-muted-foreground/90 pb-1">
                      Applying a preset will instantly load a predefined roster of agents. Any current agents will be replaced.
                    </p>
                    <Select value={templateId ?? undefined} onValueChange={handleTemplateChange}>
                      <SelectTrigger id="swarm-template" className="h-12 text-base px-4 bg-background border-primary/20 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary/40 shadow-sm">
                        <SelectValue placeholder="Custom (No Preset Selected)" />
                      </SelectTrigger>
                      <SelectContent className="border-border/40 shadow-xl rounded-xl">
                        {SWARM_TEMPLATE_OPTIONS.map((option) => (
                          <SelectItem key={option.id} value={option.id} className="py-2.5 cursor-pointer rounded-lg">
                            <span className="font-medium text-foreground/90">{option.label}</span>
                            <span className="text-muted-foreground ml-2 text-xs bg-muted px-2 py-0.5 rounded-full">{option.agentCount} agents</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              {/* Agent Roster Area */}
              <div className="space-y-6">
                <div className="flex items-center justify-between px-1 shrink-0">
                  <h3 className="text-sm font-bold uppercase tracking-widest text-foreground/60 flex items-center gap-2.5">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    Agent Roster
                  </h3>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-2 shadow-sm bg-background hover:bg-muted hover:text-foreground border-border/50 transition-all"
                    onClick={() =>
                      addAgent({
                        id: crypto.randomUUID(),
                        role: "builder",
                        model: defaultModel,
                        provider: "codex",
                        runtimeMode: "full-access",
                        interactionMode: "default",
                        serviceTier: "flex",
                        modelOptions: {},
                        reasoningEffort: defaultReasoning,
                        fastMode: false,
                      })
                    }
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Add Agent
                  </Button>
                </div>

                <div className="space-y-5">
                  {agents.map((agent, index) => (
                    <Card
                      key={agent.id}
                      className="group relative overflow-hidden border-border/40 bg-card shadow-sm transition-all duration-300 hover:shadow-md hover:border-primary/30 rounded-xl"
                    >
                      {/* Agent Header */}
                      <div className="flex items-center justify-between border-b border-border/30 bg-muted/20 px-6 py-3.5">
                        <div className="flex items-center gap-3.5">
                          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-background border border-border/50 text-xs font-bold text-foreground/80 shadow-sm">
                            {index + 1}
                          </span>
                          <span className="font-semibold text-sm text-foreground/90 tracking-tight">
                            Agent {index + 1}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground/50 transition-all hover:text-destructive hover:bg-destructive/10 rounded-md"
                          onClick={() => removeAgent(agent.id)}
                          disabled={agents.length <= 1}
                          title="Remove Agent"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                        </Button>
                      </div>

                      <CardContent className="p-6">
                        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-wide">Role</Label>
                            <Select
                              value={agent.role ?? undefined}
                              onValueChange={(value) => updateAgent(agent.id, { role: value as any })}
                            >
                              <SelectTrigger className="h-10 bg-background/50 border-border/50 transition-all focus-visible:ring-primary/20">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="rounded-xl">
                                {ROLE_OPTIONS.map((option) => (
                                  <SelectItem key={option.value} value={option.value} className="cursor-pointer">
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-wide">Model</Label>
                            <Select
                              value={agent.model ?? defaultModel}
                              onValueChange={(value) => updateAgent(agent.id, { model: value as ModelSlug })}
                            >
                              <SelectTrigger className="h-10 bg-background/50 border-border/50 transition-all focus-visible:ring-primary/20">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="rounded-xl max-h-[300px] overflow-y-auto">
                                {modelOptions.map((option) => (
                                  <SelectItem key={option.slug} value={option.slug} className="cursor-pointer">
                                    {option.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-wide">Runtime</Label>
                            <Select
                              value={agent.runtimeMode ?? undefined}
                              onValueChange={(value) => updateAgent(agent.id, { runtimeMode: value as RuntimeMode })}
                            >
                              <SelectTrigger className="h-10 bg-background/50 border-border/50 transition-all focus-visible:ring-primary/20">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="rounded-xl">
                                {RUNTIME_MODE_OPTIONS.map((option) => (
                                  <SelectItem key={option.value} value={option.value} className="cursor-pointer">
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div className="my-6 h-px w-full bg-border/40" />

                        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4 items-end">
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-wide">Reasoning</Label>
                            <Select
                              value={agent.reasoningEffort ?? defaultReasoning}
                              onValueChange={(value) => updateAgent(agent.id, { reasoningEffort: value as any })}
                            >
                              <SelectTrigger className="h-10 bg-background/50 border-border/50 transition-all focus-visible:ring-primary/20">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="rounded-xl">
                                {reasoningOptions.map((option) => (
                                  <SelectItem key={option} value={option} className="capitalize cursor-pointer">
                                    {option}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-wide">Service Tier</Label>
                            <Select
                              value={agent.serviceTier ?? "flex"}
                              onValueChange={(value) => updateAgent(agent.id, { serviceTier: value as ProviderServiceTier })}
                            >
                              <SelectTrigger className="h-10 bg-background/50 border-border/50 transition-all focus-visible:ring-primary/20">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="rounded-xl">
                                <SelectItem value="fast" className="cursor-pointer">Fast</SelectItem>
                                <SelectItem value="flex" className="cursor-pointer">Flex</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          {/* Fast Mode Toggle */}
                          <div className="space-y-2 lg:col-span-2 lg:max-w-[220px]">
                            <Label className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-wide">Optimization</Label>
                            <button
                              type="button"
                              onClick={() => updateAgent(agent.id, { fastMode: !agent.fastMode })}
                              className={`
                                relative flex h-10 w-full items-center justify-between rounded-lg border px-3.5 text-sm font-medium transition-all duration-300
                                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background
                                ${
                                  agent.fastMode
                                  ? "border-primary/40 bg-primary/10 text-primary shadow-sm"
                                  : "border-border/60 bg-background/50 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                }
                              `}
                            >
                              <span className="flex items-center gap-2.5">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill={agent.fastMode ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-colors ${agent.fastMode ? "text-primary" : "text-muted-foreground/70"}`}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                                Fast Mode
                              </span>
                              <div className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-300 ${agent.fastMode ? "bg-primary" : "bg-border/80"}`}>
                                <div className={`h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-300 ${agent.fastMode ? "translate-x-4" : "translate-x-0"}`} />
                              </div>
                            </button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Fixed Footer */}
      <footer className="shrink-0 border-t border-border/40 bg-background/80 p-5 px-6 backdrop-blur-xl z-20 supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 min-w-0 items-start gap-3 text-xs text-muted-foreground leading-relaxed max-w-lg">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 text-muted-foreground/60"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <p>
              Mission, model overrides, and runtime modes are captured in a single{" "}
              <code className="rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 border border-border/50">
                thread.create
              </code>{" "}
              dispatch automatically.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3 w-full sm:w-auto">
            <Button variant="outline" size="lg" className="flex-1 sm:flex-none h-11 border-border/60 hover:bg-muted" onClick={handleBack} disabled={currentStep === 1}>
              Back
            </Button>
            {currentStep < STEPS.length ? (
              <Button size="lg" className="flex-1 sm:flex-none h-11 bg-primary text-primary-foreground hover:bg-primary/90 shadow-md" onClick={handleNext} disabled={!canProceed()}>
                Next Step
              </Button>
            ) : (
              <Button size="lg" className="flex-1 sm:flex-none h-11 bg-primary text-primary-foreground hover:bg-primary/90 shadow-md transition-all relative overflow-hidden group" onClick={handleCreate} disabled={busy || agents.length === 0 || !projectId}>
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
                {busy ? (
                  <span className="flex items-center gap-2">
                    <svg className="h-5 w-5 animate-spin text-white/70" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Deploying...
                  </span>
                ) : (
                  <span className="flex items-center gap-2 font-medium">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                    Launch Swarm
                  </span>
                )}
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
