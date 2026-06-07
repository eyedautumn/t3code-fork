// SwarmDashboardV2.tsx
import { useEffect, useMemo, useState, useRef, type ReactNode } from "react";
import { type SwarmState, type ThreadId } from "@t3tools/contracts";
import {
  Activity,
  ArrowUpRight,
  Clock,
  Cpu,
  Crown,
  Eye,
  Hammer,
  MessageSquare,
  Minus,
  Play,
  PauseCircle,
  Plus,
  Search,
  Send,
  TerminalSquare,
  Copy,
  Check,
  X,
} from "lucide-react";

import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { cn } from "../../lib/utils";
import { SwarmConversationPanel } from "./SwarmConversationPanel";
import { ROLE_COLORS } from "./swarmRoleColors";
import { SwarmTerminalsView } from "./SwarmTerminalsView";
import { SwarmStreamingPanel } from "./SwarmStreamingPanel";
import { formatSwarmMessage, isThinkingMessage } from "../../lib/swarmMessageFormatting";
import { deriveSwarmLiveMessages } from "./swarmLiveMessages";

const ROLE_ICONS: Record<SwarmState["config"]["agents"][number]["role"], ReactNode> = {
  coordinator: <Crown className="h-6 w-6" />,
  builder: <Hammer className="h-5 w-5" />,
  reviewer: <Eye className="h-5 w-5" />,
  scout: <Search className="h-5 w-5" />,
};
const ROLE_LABELS: Record<SwarmState["config"]["agents"][number]["role"], string> = {
  coordinator: "Coordinator",
  builder: "Builder",
  reviewer: "Reviewer",
  scout: "Scout",
};
const ACTIVE_AGENT_STATUSES = new Set<SwarmState["agents"][number]["status"]>([
  "running",
  "starting",
  "ready",
]);

const STATUS_DOT_COLOR: Record<SwarmState["agents"][number]["status"], string> = {
  idle: "#3f3f46",
  starting: "#22c55e",
  running: "#22c55e",
  ready: "#f59e0b",
  blocked: "#f59e0b",
  completed: "#f59e0b",
  stopped: "#3f3f46",
  error: "#ef4444",
};
const STATUS_LABELS: Record<SwarmState["agents"][number]["status"], string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Running",
  ready: "Ready",
  blocked: "Blocked",
  completed: "Completed",
  stopped: "Stopped",
  error: "Error",
};

function isActivityOnlySwarmMessage(text: string | undefined | null): boolean {
  const value = text ?? "";
  return isThinkingMessage(value) || /^\s*\[(tool|command|mcp)\]/i.test(value);
}

function formatElapsedMillis(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

export type SwarmDashboardProps = {
  threadId: ThreadId;
  swarm: SwarmState;
  cwd?: string | null | undefined;
  onSendMessage: (text: string, targetAgentId: string | null) => Promise<void> | void;
  onStartSwarm?: () => Promise<void> | void;
  onStopSwarm?: () => void;
  onStopAgent?: (agentId: string) => void;
};

export function SwarmDashboardV2({
  threadId,
  swarm,
  cwd,
  onSendMessage,
  onStartSwarm,
  onStopSwarm,
  onStopAgent,
}: SwarmDashboardProps) {
  const [chatActive, setChatActive] = useState(false);
  const [terminalsActive, setTerminalsActive] = useState(false);
  const [activityActive, setActivityActive] = useState(false);
  const [copiedMission, setCopiedMission] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [lastChatViewedAt, setLastChatViewedAt] = useState(() => Date.now());
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [composerTargetAgent, setComposerTargetAgent] = useState<string | null>(null);
  const [startInFlight, setStartInFlight] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Determine actual view based on button states
  const view = terminalsActive
    ? "terminals"
    : chatActive
      ? "chat"
      : activityActive
        ? "activity"
        : "visualizer";

  useEffect(() => {
    if (view === "chat") {
      setLastChatViewedAt(Date.now());
    }
  }, [view]);
  const effectiveSwarm = swarm;

  const { hasActive } = useMemo(() => summarizeStatuses(effectiveSwarm), [effectiveSwarm]);
  const liveCount = useMemo(
    () =>
      effectiveSwarm.agents.filter(
        (agent) =>
          agent.status === "running" || agent.status === "starting" || agent.status === "ready",
      ).length,
    [effectiveSwarm.agents],
  );

  const swarmElapsedLabel = useMemo(() => {
    const activeAgents = effectiveSwarm.agents.filter((agent) =>
      ACTIVE_AGENT_STATUSES.has(agent.status),
    );
    const earliest = activeAgents
      .map((agent) => Date.parse(agent.updatedAt))
      .filter((timestamp) => Number.isFinite(timestamp))
      .toSorted((a, b) => a - b)[0];
    if (!earliest) return "-";
    return formatElapsedMillis(now - earliest);
  }, [effectiveSwarm.agents, now]);

  const messageCount = useMemo(
    () => swarm.messages.filter((m) => !m.streaming && !isActivityOnlySwarmMessage(m.text)).length,
    [swarm.messages],
  );
  const liveMessages = useMemo(() => deriveSwarmLiveMessages(swarm), [swarm]);

  const unreadByAgent = useMemo(() => {
    const cutoff = lastChatViewedAt;
    const counts = new Map<string, number>();
    for (const message of swarm.messages) {
      if (message.sender !== "agent" || message.streaming) continue;
      if (isActivityOnlySwarmMessage(message.text)) continue;
      const agentId = message.senderAgentId ?? undefined;
      if (!agentId) continue;
      const messageTime = Date.parse(message.updatedAt);
      if (Number.isFinite(messageTime) && messageTime <= cutoff) {
        continue;
      }
      counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
    }
    return counts;
  }, [lastChatViewedAt, swarm.messages]);

  const handleTerminalsToggle = () => {
    setTerminalsActive((prev) => !prev);
    if (!terminalsActive) {
      setChatActive(false);
      setActivityActive(false);
    }
  };

  const handleChatToggle = () => {
    setChatActive((prev) => !prev);
    if (!chatActive) {
      setTerminalsActive(false);
      setActivityActive(false);
    }
  };

  const handleActivityToggle = () => {
    setActivityActive((prev) => !prev);
    if (!activityActive) {
      setTerminalsActive(false);
      setChatActive(false);
    }
  };

  // Get Dynamic Project Name (from cwd, fallback to swarm name)
  const projectName = useMemo(() => {
    if (cwd) {
      const parts = cwd.split(/[/\\]/); // Handle windows and unix paths
      const folderName = parts[parts.length - 1];
      if (folderName) return folderName.toUpperCase();
    }
    return swarm.config.name.toUpperCase();
  }, [cwd, swarm.config.name]);

  const handleCopyMission = () => {
    const missionText = swarm.config.startPrompt
      ? `${swarm.config.mission}\n\nStart Prompt:\n${swarm.config.startPrompt}`
      : swarm.config.mission;

    void navigator.clipboard.writeText(missionText);
    setCopiedMission(true);
    setTimeout(() => setCopiedMission(false), 2000);
  };

  useEffect(() => {
    if (hasActive) {
      setStartInFlight(false);
    }
  }, [hasActive]);

  const handleStartSwarm = () => {
    if (!onStartSwarm || startInFlight || hasActive) return;
    setStartInFlight(true);
    void Promise.resolve(onStartSwarm())
      .catch(() => undefined)
      .finally(() => {
        window.setTimeout(() => setStartInFlight(false), 2_000);
      });
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#0a0a0f] font-sans text-slate-200 selection:bg-blue-500/30">
      {/* Top Navigation Bar */}
      <header className="flex min-h-[64px] shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#0d0d12] px-4 py-2 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
        {/* Left: Branding & Title */}
        <div className="flex items-center gap-3">
          <div className="flex size-7 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="size-4"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div className="flex flex-col leading-snug gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-wide text-zinc-100">
                {swarm.config.name}
              </span>
              <button
                onClick={handleCopyMission}
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
                title="Copy Mission Brief"
              >
                {copiedMission ? (
                  <Check className="size-3.5 text-emerald-400" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </div>
            <span className="text-[9px] font-medium tracking-[0.2em] text-zinc-600 uppercase">
              {projectName}
            </span>
          </div>
        </div>

        {/* Right: Controls & Views */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-md bg-[#111118] p-0.5 border border-white/[0.06]">
            <button
              onClick={handleTerminalsToggle}
              className={cn(
                "flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                terminalsActive ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              <TerminalSquare className="size-3.5" />
              Terminals
            </button>
            <button
              onClick={handleChatToggle}
              className={cn(
                "flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                chatActive ? "bg-blue-500/15 text-blue-400" : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              <MessageSquare className="size-3.5" />
              Chat
              {messageCount > 0 && (
                <span className="ml-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-blue-500/20 px-1 text-[9px] font-bold text-blue-400">
                  {messageCount > 99 ? "99+" : messageCount}
                </span>
              )}
            </button>
            <button
              onClick={handleActivityToggle}
              className={cn(
                "flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                activityActive ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              <Activity className="size-3.5" />
              Activity
            </button>
          </div>

          <div className="h-5 w-px bg-white/[0.08] mx-1" />

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="size-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-semibold text-emerald-400">{liveCount} Live</span>
              <span className="text-xs font-medium text-zinc-500 font-mono">
                {swarmElapsedLabel}
              </span>
            </div>

            {hasActive ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onStopSwarm}
                disabled={!onStopSwarm}
                className="h-7 gap-1.5 border border-red-500/20 bg-red-500/10 text-[11px] font-semibold text-red-400 hover:bg-red-500/20 rounded-md uppercase tracking-wider disabled:opacity-30 px-3"
              >
                <PauseCircle className="size-3.5" /> Stop
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleStartSwarm}
                disabled={!onStartSwarm || startInFlight}
                className="h-7 gap-1.5 border border-emerald-500/20 bg-emerald-500/10 text-[11px] font-semibold text-emerald-400 hover:bg-emerald-500/20 rounded-md uppercase tracking-wider disabled:opacity-30 px-3"
              >
                <Play className="size-3.5" /> {startInFlight ? "Starting" : "Start"}
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="relative flex-1 min-h-0 overflow-hidden">
        {view === "visualizer" && (
          <SwarmVisualizerV2
            swarm={swarm}
            effectiveSwarm={effectiveSwarm}
            now={now}
            unreadByAgent={unreadByAgent}
            onOpenSidebar={setSelectedAgentId}
            onSelectInComposer={(agentId) => {
              setComposerTargetAgent(agentId);
              setChatActive(true);
              setTerminalsActive(false);
              setActivityActive(false);
            }}
            {...(onStopAgent ? { onStopAgent } : {})}
          />
        )}
        {view === "chat" && <SwarmConversationPanel threadId={threadId} swarm={swarm} />}
        {view === "terminals" && <SwarmTerminalsView swarm={swarm} threadId={threadId} cwd={cwd} />}
        {view === "activity" && (
          <SwarmStreamingPanel swarm={swarm} liveMessages={liveMessages} cwd={cwd} />
        )}

        {/* Global Floating Composer (Hidden in Terminals view) */}
        {view !== "terminals" && (
          <div className="absolute bottom-0 left-0 right-0 flex justify-center pb-2 pointer-events-none z-20">
            <div className="pointer-events-auto w-full max-w-2xl px-4">
              <GlobalComposer
                swarm={swarm}
                targetAgentId={composerTargetAgent}
                onTargetAgentChange={setComposerTargetAgent}
                onSend={onSendMessage}
              />
            </div>
          </div>
        )}

        {selectedAgentId ? (
          <AgentSidebar
            agentConfig={swarm.config.agents.find((agent) => agent.id === selectedAgentId) ?? null}
            agentRuntime={effectiveSwarm.agents.find((agent) => agent.agentId === selectedAgentId)}
            swarm={effectiveSwarm}
            onClose={() => setSelectedAgentId(null)}
            {...(onStopAgent ? { onStopAgent } : {})}
            onSelectInComposer={(agentId) => {
              setComposerTargetAgent(agentId);
              setSelectedAgentId(null);
              setChatActive(true);
              setTerminalsActive(false);
              setActivityActive(false);
            }}
          />
        ) : null}
      </main>
    </div>
  );
}

// --- GLOBAL COMPOSER (SEAMLESS PILL) ---
function GlobalComposer({
  swarm,
  targetAgentId,
  onTargetAgentChange,
  onSend,
}: {
  swarm: SwarmState;
  targetAgentId: string | null;
  onTargetAgentChange: (agentId: string | null) => void;
  onSend: (text: string, targetAgentId: string | null) => Promise<void> | void;
}) {
  const [message, setMessage] = useState("");

  const handleSend = () => {
    if (!message.trim()) return;
    void onSend(message.trim(), targetAgentId);
    setMessage("");
  };

  const selectedAgent = targetAgentId
    ? swarm.config.agents.find((a) => a.id === targetAgentId)
    : null;

  return (
    <div className="flex flex-col items-center w-full">
      {/* Main Composer Pill - Seamless styling */}
      <div className="flex h-[48px] w-full items-center rounded-full bg-[#18181b] border border-white/[0.05] shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl pl-2 pr-1.5 focus-within:border-white/[0.12] transition-colors">
        {/* Target Selector */}
        <Select
          value={targetAgentId ?? "broadcast"}
          onValueChange={(value) => onTargetAgentChange(value === "broadcast" ? null : value)}
        >
          {/* We aggressively strip all standard shadcn input/button styling here to ensure it sits perfectly flush without boxes */}
          <SelectTrigger className="w-auto min-w-[120px] h-full border-none !bg-transparent outline-none shadow-none focus:ring-0 focus:ring-offset-0 px-3 hover:!bg-transparent data-[state=open]:!bg-transparent text-zinc-300 hover:text-white transition-colors">
            <div className="flex items-center gap-2.5">
              {selectedAgent ? (
                <>
                  <div
                    className="size-2 rounded-full"
                    style={{
                      backgroundColor: ROLE_COLORS[selectedAgent.role],
                      boxShadow: `0 0 8px ${ROLE_COLORS[selectedAgent.role]}80`,
                    }}
                  />
                  <span className="text-[13px] font-semibold">{selectedAgent.name}</span>
                </>
              ) : (
                <>
                  <div className="size-2 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.6)]" />
                  <span className="text-[13px] font-semibold">All Agents</span>
                </>
              )}
            </div>
          </SelectTrigger>

          <SelectContent className="border-[#27272a] bg-[#111118] text-zinc-200 rounded-xl shadow-2xl">
            <SelectItem value="broadcast" className="text-xs font-medium">
              <div className="flex items-center gap-2">
                <div className="size-2 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.4)]" />
                All Agents
              </div>
            </SelectItem>
            {swarm.config.agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id} className="text-xs font-medium">
                <div className="flex items-center gap-2">
                  <div
                    className="size-2 rounded-full"
                    style={{ backgroundColor: ROLE_COLORS[agent.role] }}
                  />
                  {agent.name}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Subtle Divider */}
        <div className="h-4 w-px bg-white/[0.08] mx-1" />

        {/* Text Input - Using native HTML input guarantees no weird shadcn background boxes */}
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Direct the Swarm..."
          className="flex-1 bg-transparent border-none outline-none ring-0 text-[14px] text-zinc-200 placeholder:text-zinc-600 px-3 h-full w-full"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />

        {/* Send Button - Native button to avoid background artifacts */}
        <button
          onClick={handleSend}
          disabled={!message.trim()}
          className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-white/[0.03] border border-white/[0.02] text-zinc-500 hover:text-white hover:bg-white/[0.08] disabled:opacity-30 disabled:hover:bg-white/[0.03] transition-all ml-1"
        >
          <Send className="size-4" />
        </button>
      </div>

      {/* Little grab handle at bottom */}
      <div className="mt-2.5 mb-1 h-1 w-8 rounded-full bg-white/[0.15]" />
    </div>
  );
}

// --- VISUALIZER VIEW ---
function SwarmVisualizerV2({
  swarm,
  effectiveSwarm,
  now,
  unreadByAgent,
  onOpenSidebar,
  onSelectInComposer,
  onStopAgent,
}: {
  swarm: SwarmState;
  effectiveSwarm: SwarmState;
  now: number;
  unreadByAgent: Map<string, number>;
  onOpenSidebar: (agentId: string) => void;
  onSelectInComposer: (agentId: string) => void;
  onStopAgent?: (agentId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const runtimeById = useMemo(
    () => new Map(effectiveSwarm.agents.map((entry) => [entry.agentId, entry] as const)),
    [effectiveSwarm.agents],
  );

  const coordinator = swarm.config.agents.find((a) => a.role === "coordinator");
  const builders = swarm.config.agents.filter((a) => a.role === "builder");
  const scouts = swarm.config.agents.filter((a) => a.role === "scout");
  const reviewers = swarm.config.agents.filter((a) => a.role === "reviewer");

  const getNodePosition = (
    agent: SwarmState["config"]["agents"][number],
  ): { x: number; y: number } => {
    if (agent.role === "coordinator") return { x: 50, y: 52 };

    if (agent.role === "builder") {
      const idx = builders.findIndex((a) => a.id === agent.id);
      if (builders.length === 1) return { x: 35, y: 28 };
      if (idx === 0) return { x: 35, y: 28 };
      if (idx === 1) return { x: 65, y: 28 };
      return { x: 35 + idx * 15, y: 28 };
    }

    if (agent.role === "scout") {
      const idx = scouts.findIndex((a) => a.id === agent.id);
      if (scouts.length === 1) return { x: 32, y: 72 };
      return { x: 28 + idx * 12, y: 72 };
    }

    if (agent.role === "reviewer") {
      const idx = reviewers.findIndex((a) => a.id === agent.id);
      if (reviewers.length === 1) return { x: 68, y: 72 };
      return { x: 64 + idx * 12, y: 72 };
    }

    return { x: 50, y: 50 };
  };

  const peers = swarm.config.agents.filter((a) => a.id !== coordinator?.id);

  // PAN & ZOOM HANDLERS
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only trigger on left click
    isDragging.current = true;
    dragStart.current = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current) return;
    setTransform((prev) => ({
      ...prev,
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    }));
  };

  const handleMouseUp = () => {
    isDragging.current = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    const zoomSensitivity = 0.0015;
    const delta = -e.deltaY * zoomSensitivity;
    const newScale = Math.min(Math.max(0.2, transform.scale + delta), 3);
    setTransform((prev) => ({ ...prev, scale: newScale }));
  };

  if (!coordinator) return null;

  const coordPos = getNodePosition(coordinator);

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[#0a0a0f] cursor-grab active:cursor-grabbing"
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      {/* Background stays static while view moves */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(20,20,30,0.5)_0%,_rgba(10,10,15,1)_65%)] pointer-events-none" />

      {/* Faint watermark logo */}
      <div className="absolute inset-0 flex items-center justify-center opacity-[0.03] pointer-events-none">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-[30%] h-[30%]">
          <path d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      </div>

      {/* TRANSFORM WRAPPER for Pan/Zoom */}
      <div
        className="absolute inset-0 origin-center"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transition: isDragging.current ? "none" : "transform 0.05s linear",
        }}
      >
        {/* Connection Lines SVG */}
        <svg className="absolute inset-0 h-full w-full pointer-events-none z-[1] overflow-visible">
          {peers.map((agent) => {
            const pos = getNodePosition(agent);
            const color = ROLE_COLORS[agent.role];
            const runtime = runtimeById.get(agent.id);
            const isConnected = runtime?.status ? ACTIVE_AGENT_STATUSES.has(runtime.status) : false;

            return (
              <g key={`edge-${agent.id}`}>
                <line
                  x1={`${coordPos.x}%`}
                  y1={`${coordPos.y}%`}
                  x2={`${pos.x}%`}
                  y2={`${pos.y}%`}
                  stroke={color}
                  strokeOpacity={isConnected ? "0.45" : "0.06"}
                  strokeWidth={isConnected ? "1.8" : "1"}
                />
                {/* Animated dot traveling along the line */}
                {isConnected && (
                  <circle r="3" fill="white" opacity="0.8">
                    <animateMotion
                      dur="3s"
                      repeatCount="indefinite"
                      path={`M${(coordPos.x / 100) * 1000},${(coordPos.y / 100) * 600} L${(pos.x / 100) * 1000},${(pos.y / 100) * 600}`}
                    />
                  </circle>
                )}
              </g>
            );
          })}
        </svg>

        {/* Agent Nodes */}
        <div className="absolute inset-0 z-[2]">
          {/* Coordinator */}
          <SwarmCircleNodeV2
            agent={coordinator}
            status={runtimeById.get(coordinator.id)?.status ?? "idle"}
            elapsedLabel={
              runtimeById.get(coordinator.id)?.updatedAt
                ? formatElapsedMillis(now - Date.parse(runtimeById.get(coordinator.id)!.updatedAt))
                : "-"
            }
            unreadCount={unreadByAgent.get(coordinator.id) ?? 0}
            style={{ left: `${coordPos.x}%`, top: `${coordPos.y}%` }}
            isCoordinator
            projectName={swarm.config.name}
            swarm={effectiveSwarm}
            onOpenSidebar={onOpenSidebar}
            onSelectInComposer={onSelectInComposer}
            {...(onStopAgent ? { onStopAgent } : {})}
          />

          {/* Peers */}
          {peers.map((agent) => {
            const pos = getNodePosition(agent);
            const runtime = runtimeById.get(agent.id);
            const elapsedLabel = runtime?.updatedAt
              ? formatElapsedMillis(now - Date.parse(runtime.updatedAt))
              : "-";
            return (
              <SwarmCircleNodeV2
                key={agent.id}
                agent={agent}
                status={runtime?.status ?? "idle"}
                elapsedLabel={elapsedLabel}
                unreadCount={unreadByAgent.get(agent.id) ?? 0}
                style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                projectName={swarm.config.name}
                swarm={effectiveSwarm}
                onOpenSidebar={onOpenSidebar}
                onSelectInComposer={onSelectInComposer}
                {...(onStopAgent ? { onStopAgent } : {})}
              />
            );
          })}
        </div>
      </div>

      {/* STATIC UI ELEMENTS (Banner & Controls) */}

      {/* Zoom Controls - Bottom Left */}
      <div className="absolute bottom-6 left-6 z-10 flex items-center gap-1 rounded-lg bg-[#111118]/80 border border-white/[0.04] px-2 py-1 backdrop-blur-md shadow-lg">
        <button
          onClick={() => setTransform((p) => ({ ...p, scale: Math.max(0.2, p.scale - 0.1) }))}
          className="flex size-6 items-center justify-center rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
        >
          <Minus className="size-3" />
        </button>
        <span className="text-[11px] font-mono text-zinc-400 min-w-[36px] text-center cursor-default">
          {Math.round(transform.scale * 100)}%
        </span>
        <button
          onClick={() => setTransform((p) => ({ ...p, scale: Math.min(3, p.scale + 0.1) }))}
          className="flex size-6 items-center justify-center rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
        >
          <Plus className="size-3" />
        </button>
      </div>
    </div>
  );
}

// --- CIRCLE NODE ---
function SwarmCircleNodeV2({
  agent,
  status,
  elapsedLabel,
  unreadCount,
  style,
  isCoordinator = false,
  onOpenSidebar,
  onSelectInComposer,
  onStopAgent,
  swarm,
}: {
  agent: SwarmState["config"]["agents"][number];
  status: SwarmState["agents"][number]["status"];
  elapsedLabel: string;
  unreadCount: number;
  style: React.CSSProperties;
  isCoordinator?: boolean;
  projectName?: string;
  swarm?: SwarmState;
  onOpenSidebar?: (agentId: string) => void;
  onSelectInComposer?: (agentId: string) => void;
  onStopAgent?: (agentId: string) => void;
}) {
  const accent = ROLE_COLORS[agent.role];
  const icon = ROLE_ICONS[agent.role];
  const isRunning = ACTIVE_AGENT_STATUSES.has(status);
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const circleSize = isCoordinator ? 80 : 64;
  const isExpanded = isHovered || isPressed;
  const messageCount = useMemo(() => {
    if (!swarm) return 0;
    return swarm.messages.filter(
      (message) =>
        message.sender === "agent" &&
        message.senderAgentId === agent.id &&
        !message.streaming &&
        !isActivityOnlySwarmMessage(message.text),
    ).length;
  }, [agent.id, swarm]);
  const lastMessagePreview = useMemo(() => {
    if (!swarm) return null;
    const latest = swarm.messages
      .filter(
        (message) =>
          message.sender === "agent" &&
          message.senderAgentId === agent.id &&
          !message.streaming &&
          !isActivityOnlySwarmMessage(message.text) &&
          (message.text?.trim().length ?? 0) > 0,
      )
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!latest) return null;
    const text = latest.text.trim();
    return text.length > 90 ? `${text.slice(0, 90)}...` : text;
  }, [agent.id, swarm]);

  useEffect(() => {
    if (!isPressed) return;
    const handleMouseUp = () => setIsPressed(false);
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [isPressed]);

  const handleMouseEnter = () => {
    hoverTimeoutRef.current = setTimeout(() => setIsHovered(true), 350);
  };
  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovered(false);
    setIsPressed(false);
  };
  const handleClick = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovered(false);
    setIsPressed(false);
    onOpenSidebar?.(agent.id);
  };

  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2 select-none flex flex-col items-center gap-2"
      style={style}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="relative">
        {/* Outer glow */}
        <div
          className="absolute rounded-full transition-all duration-300"
          style={{
            inset: -6,
            border: `1px solid ${accent}`,
            filter: `blur(4px)`,
            opacity: isExpanded ? 0.5 : isRunning ? 0.22 : 0.12,
          }}
        />

        {/* Main circle */}
        <div
          className="relative flex items-center justify-center rounded-full bg-[#0c0c14] cursor-pointer transition-all duration-300"
          style={{
            width: isExpanded ? circleSize + 10 : circleSize,
            height: isExpanded ? circleSize + 10 : circleSize,
            border: `2px solid ${accent}`,
            borderColor: accent,
            opacity: 0.9,
            boxShadow: isExpanded
              ? `0 0 24px ${accent}30, 0 0 48px ${accent}15, inset 0 0 20px ${accent}08`
              : isRunning
                ? `0 0 12px ${accent}15, inset 0 0 12px ${accent}05`
                : `inset 0 0 8px ${accent}05`,
          }}
          onClick={handleClick}
          onMouseDown={() => setIsPressed(true)}
          onMouseUp={() => setIsPressed(false)}
        >
          {/* Inner subtle ring */}
          <div className="absolute rounded-full border border-white/[0.06]" style={{ inset: 4 }} />

          {/* Role icon */}
          <span
            className="relative z-10 transition-transform duration-300"
            style={{ color: accent, transform: isExpanded ? "scale(1.1)" : "scale(1)" }}
          >
            {icon}
          </span>
        </div>

        {/* Notification badge (non-coordinator) */}
        {unreadCount > 0 && (
          <div className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full border-2 border-[#0a0a0f] bg-blue-500 text-[9px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </div>
        )}

        {/* Status dot - bottom center or bottom right */}
        <div
          className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 size-3 rounded-full border-2 border-[#0a0a0f]"
          style={{
            backgroundColor: STATUS_DOT_COLOR[status],
          }}
        />

        {isExpanded ? (
          <div
            className="absolute top-full left-1/2 z-50 mt-3 w-64 -translate-x-1/2 overflow-hidden rounded-xl border border-white/[0.08] bg-[#111118]/95 shadow-[0_16px_64px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.03)] backdrop-blur-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="h-[2px] w-full"
              style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
            />
            <div className="px-4 pt-3.5 pb-3">
              <div className="flex items-center gap-2.5">
                <div
                  className="flex size-7 items-center justify-center rounded-lg border"
                  style={{ background: `${accent}14`, borderColor: `${accent}28`, color: accent }}
                >
                  {icon}
                </div>
                <div className="min-w-0">
                  <h4 className="truncate text-[13px] font-semibold leading-tight text-zinc-100">
                    {agent.name}
                  </h4>
                  <span
                    className="text-[10px] font-medium uppercase tracking-wider"
                    style={{ color: `${accent}cc` }}
                  >
                    {ROLE_LABELS[agent.role]}
                  </span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5 rounded-md border border-white/[0.04] bg-white/[0.03] px-2 py-1">
                  <div
                    className="size-[6px] rounded-full"
                    style={{ backgroundColor: STATUS_DOT_COLOR[status] }}
                  />
                  <span className="text-[10px] font-medium text-zinc-300">
                    {STATUS_LABELS[status]}
                  </span>
                </div>
                {isRunning ? (
                  <div className="flex items-center gap-1 text-[10px] text-zinc-500">
                    <Clock className="size-3" />
                    <span className="font-mono">{elapsedLabel}</span>
                  </div>
                ) : null}
                <div className="flex items-center gap-1 text-[10px] text-zinc-500">
                  <MessageSquare className="size-3" />
                  <span>{messageCount}</span>
                </div>
              </div>
            </div>
            <div className="border-t border-white/[0.04] px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <Cpu className="size-3 shrink-0 text-zinc-600" />
                <span className="truncate font-mono text-[10px] text-zinc-500">{agent.model}</span>
                <span className="text-[10px] text-zinc-600">·</span>
                <span className="shrink-0 text-[10px] capitalize text-zinc-500">
                  {agent.providerInstanceId ?? agent.provider}
                </span>
              </div>
            </div>
            {lastMessagePreview ? (
              <div className="border-t border-white/[0.04] px-4 py-2.5">
                <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-zinc-600">
                  Latest
                </div>
                <p className="line-clamp-2 text-[11px] leading-relaxed text-zinc-400">
                  {lastMessagePreview}
                </p>
              </div>
            ) : null}
            <div className="flex items-center gap-1.5 px-3 pb-3 pt-1">
              <button
                onClick={() => onOpenSidebar?.(agent.id)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-3 py-2 text-[11px] font-semibold text-zinc-300 transition-all hover:border-white/[0.1] hover:bg-white/[0.08] hover:text-white"
              >
                <ArrowUpRight className="size-3" />
                Details
              </button>
              <button
                onClick={() => onSelectInComposer?.(agent.id)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[11px] font-semibold transition-all"
                style={{ background: `${accent}12`, borderColor: `${accent}25`, color: accent }}
              >
                <MessageSquare className="size-3" />
                Chat
              </button>
              {isRunning && onStopAgent ? (
                <button
                  onClick={() => onStopAgent(agent.id)}
                  className="flex items-center justify-center rounded-lg border border-red-500/15 bg-red-500/10 px-2.5 py-2 text-red-400 transition-all hover:border-red-500/25 hover:bg-red-500/15"
                >
                  <PauseCircle className="size-3" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* Label */}
      <div className="text-center flex flex-col items-center mt-1">
        <p className="text-[12px] font-medium text-zinc-300">{agent.name}</p>
        {isRunning && <p className="text-[10px] text-zinc-600 font-mono">{elapsedLabel}</p>}
      </div>
    </div>
  );
}

function AgentSidebar({
  agentConfig,
  agentRuntime,
  swarm,
  onClose,
  onStopAgent,
  onSelectInComposer,
}: {
  agentConfig: SwarmState["config"]["agents"][number] | null;
  agentRuntime?: SwarmState["agents"][number] | undefined;
  swarm: SwarmState;
  onClose: () => void;
  onStopAgent?: (agentId: string) => void;
  onSelectInComposer: (agentId: string) => void;
}) {
  const now = Date.now();
  if (!agentConfig) return null;
  const accent = ROLE_COLORS[agentConfig.role];
  const icon = ROLE_ICONS[agentConfig.role];
  const status = agentRuntime?.status ?? "idle";
  const isRunning = ACTIVE_AGENT_STATUSES.has(status);
  const agentMessages = swarm.messages
    .filter(
      (message) =>
        message.sender === "agent" &&
        message.senderAgentId === agentConfig.id &&
        !message.streaming &&
        !isActivityOnlySwarmMessage(message.text),
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const getAgentName = (id: string) =>
    id === "__swarm.operator__"
      ? "Operator"
      : (swarm.config.agents.find((agent) => agent.id === id)?.name ?? "Unknown");

  return (
    <aside className="absolute right-0 top-0 z-30 flex h-full w-[360px] max-w-[92vw] flex-col border-l border-white/[0.06] bg-[#0d0d12]/96 shadow-[-24px_0_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
      <div className="border-b border-white/[0.06] p-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className="flex size-11 items-center justify-center rounded-xl border"
              style={{ background: `${accent}14`, borderColor: `${accent}2f`, color: accent }}
            >
              {icon}
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold text-zinc-100">{agentConfig.name}</h3>
              <p
                className="text-[11px] font-semibold uppercase tracking-[0.18em]"
                style={{ color: accent }}
              >
                {ROLE_LABELS[agentConfig.role]}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-white/[0.05] bg-white/[0.025] p-3">
            <div className="text-[10px] uppercase tracking-wider text-zinc-600">Status</div>
            <div className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: STATUS_DOT_COLOR[status] }}
              />
              {STATUS_LABELS[status]}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.05] bg-white/[0.025] p-3">
            <div className="text-[10px] uppercase tracking-wider text-zinc-600">Messages</div>
            <div className="mt-1 text-xs font-semibold text-zinc-200">{agentMessages.length}</div>
          </div>
          <div className="rounded-xl border border-white/[0.05] bg-white/[0.025] p-3">
            <div className="text-[10px] uppercase tracking-wider text-zinc-600">Runtime</div>
            <div className="mt-1 text-xs font-semibold text-zinc-200">
              {isRunning && agentRuntime?.updatedAt
                ? formatElapsedMillis(now - Date.parse(agentRuntime.updatedAt))
                : "-"}
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-white/[0.05] bg-white/[0.02] p-3">
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-600">
            <Cpu className="size-3" />
            Model
          </div>
          <div className="truncate font-mono text-[11px] text-zinc-300">{agentConfig.model}</div>
          <div className="mt-1 text-[10px] text-zinc-500">
            {agentConfig.providerInstanceId ?? agentConfig.provider}
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => onSelectInComposer(agentConfig.id)}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-xs font-semibold transition-all"
            style={{ background: `${accent}12`, borderColor: `${accent}25`, color: accent }}
          >
            <MessageSquare className="size-3.5" />
            Message agent
          </button>
          {isRunning && onStopAgent ? (
            <button
              type="button"
              onClick={() => onStopAgent(agentConfig.id)}
              className="flex items-center justify-center gap-2 rounded-xl border border-red-500/15 bg-red-500/10 px-4 py-2.5 text-xs font-semibold text-red-400 transition-all hover:bg-red-500/15"
            >
              <PauseCircle className="size-3.5" />
              Stop
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
            Agent transcript
          </h4>
          <span className="rounded-full bg-white/[0.04] px-2 py-0.5 text-[10px] text-zinc-500">
            {agentMessages.length}
          </span>
        </div>
        {agentMessages.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.08] p-5 text-center text-xs text-zinc-600">
            This agent has not sent any routed swarm messages yet.
          </div>
        ) : (
          <div className="space-y-3">
            {agentMessages.map((message) => {
              const formatted = formatSwarmMessage(message, swarm.config.agents, false);
              return (
                <button
                  type="button"
                  key={message.id}
                  className="group w-full rounded-xl border border-white/[0.04] bg-white/[0.018] p-3.5 text-left transition-all hover:border-white/[0.08] hover:bg-white/[0.035]"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-[10px] text-zinc-600">
                      To {formatted.targetAgentId ? getAgentName(formatted.targetAgentId) : "swarm"}
                    </span>
                    <ArrowUpRight className="size-3 text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <p className="line-clamp-4 text-[12px] leading-relaxed text-zinc-300">
                    {formatted.text || message.text}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

function summarizeStatuses(swarm: SwarmState) {
  const statuses = swarm.agents.map((a) => a.status);
  const hasActive = statuses.some((status) => ACTIVE_AGENT_STATUSES.has(status));
  return { hasActive };
}
