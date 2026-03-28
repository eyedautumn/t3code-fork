import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SWARM_OPERATOR_TARGET_ID, type SwarmState, type ThreadId } from "@t3tools/contracts";
import {
  Activity,
  Bot,
  Box,
  CheckIcon,
  CopyIcon,
  Crown,
  Eye,
  Hammer,
  Hash,
  PauseCircle,
  Play,
  Radio,
  ScrollText,
  Search,
  Send,
  TerminalSquare,
  User,
  Users,
  ZoomIn,
  ZoomOut,
  Maximize,
} from "lucide-react";

import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "../../lib/utils";
import { useStore, type SwarmLiveMessage } from "../../store";
import { SwarmConversationPanelV1 } from "./SwarmConversationPanel";
import { SwarmActivityFeed } from "./SwarmActivityFeed";
import { SwarmTerminalsView } from "./SwarmTerminalsView";
import { SwarmStreamingPanel } from "./SwarmStreamingPanel";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";
import { getSwarmMessageRouteLabel } from "../../lib/swarmMessagePresentation";
import { formatSwarmMessage } from "../../lib/swarmMessageFormatting";
import ChatMarkdown from "../ChatMarkdown";

const CARD_W = 320;
const CARD_H = 185;
const GAP_X = 32;
const GAP_Y = 120;
const LABEL_OFFSET_Y = 40;

const ROLE_ICONS: Record<SwarmState["config"]["agents"][number]["role"], ReactNode> = {
  coordinator: <Crown className="h-3.5 w-3.5" />,
  builder: <Hammer className="h-3.5 w-3.5" />,
  reviewer: <Eye className="h-3.5 w-3.5" />,
  scout: <Search className="h-3.5 w-3.5" />,
};

export const ROLE_COLORS: Record<SwarmState["config"]["agents"][number]["role"], string> = {
  coordinator: "#5b8bf7",
  builder: "#2dd4bf",
  reviewer: "#fbbf24",
  scout: "#34d399",
};

const ROLE_THEME: Record<
  SwarmState["config"]["agents"][number]["role"],
  { text: string; dot: string; highlight: string }
> = {
  coordinator: {
    text: "text-[#5b8bf7]",
    dot: "bg-[#5b8bf7]",
    highlight: "rgba(91,139,247,0.15)",
  },
  builder: {
    text: "text-[#2dd4bf]",
    dot: "bg-[#2dd4bf]",
    highlight: "rgba(45,212,191,0.15)",
  },
  reviewer: {
    text: "text-[#fbbf24]",
    dot: "bg-[#fbbf24]",
    highlight: "rgba(251,191,36,0.15)",
  },
  scout: {
    text: "text-[#34d399]",
    dot: "bg-[#34d399]",
    highlight: "rgba(52,211,153,0.15)",
  },
};

const STATUS_STYLE: Record<
  SwarmState["agents"][number]["status"],
  { text: string; label: string }
> = {
  idle: { text: "text-slate-500", label: "Idle" },
  starting: { text: "text-amber-300", label: "Starting" },
  running: { text: "text-[#34d399]", label: "Running" },
  ready: { text: "text-[#34d399]", label: "Ready" },
  blocked: { text: "text-[#ef4444]", label: "Blocked" },
  completed: { text: "text-slate-400", label: "Completed" },
  stopped: { text: "text-slate-600", label: "Stopped" },
  error: { text: "text-[#ef4444]", label: "Error" },
};

const RANK_ORDER: SwarmState["config"]["agents"][number]["role"][] = [
  "coordinator",
  "builder",
  "reviewer",
  "scout",
];

export type SwarmDashboardProps = {
  threadId: ThreadId;
  swarm: SwarmState;
  cwd?: string | null | undefined;
  onSendMessage: (text: string, targetAgentId: string | null) => Promise<void> | void;
  onStartSwarm?: () => void;
  onStopSwarm?: () => void;
  useExperimentalV2?: boolean;
};

export type SwarmDashboardBaseProps = Omit<SwarmDashboardProps, "useExperimentalV2">;

type NodeData = SwarmState["config"]["agents"][number] & {
  x: number;
  y: number;
  rowIndex: number;
};

type EdgeData = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  fromRole: SwarmState["config"]["agents"][number]["role"];
  toRole: SwarmState["config"]["agents"][number]["role"];
};

type RowLabelData = {
  role: SwarmState["config"]["agents"][number]["role"];
  count: number;
  y: number;
  width: number;
};

export function SwarmDashboardV1({
  threadId,
  swarm,
  cwd,
  onSendMessage,
  onStartSwarm,
  onStopSwarm,
}: SwarmDashboardBaseProps) {
  const [transcriptMode, setTranscriptMode] = useState<"hidden" | "normal" | "expanded">("normal");
  const [streamingMode, setStreamingMode] = useState<"hidden" | "normal" | "expanded">("normal");
  const [viewMode, setViewMode] = useState<"visualizer" | "terminals">("visualizer");
  const liveSwarm = useStore((store) => store.swarmLiveByThreadId[String(threadId)] ?? null);
  const effectiveSwarm = useMemo(() => {
    if (!liveSwarm) return swarm;
    const agentsById = new Map(swarm.agents.map((agent) => [agent.agentId, agent] as const));
    for (const liveAgent of Object.values(liveSwarm.agentsById)) {
      const existing = agentsById.get(liveAgent.agentId);
      if (!existing || existing.updatedAt <= liveAgent.updatedAt) {
        agentsById.set(liveAgent.agentId, liveAgent);
      }
    }
    return {
      ...swarm,
      agents: Array.from(agentsById.values()),
    };
  }, [liveSwarm, swarm]);

  const { nodes, edges, rowLabels } = useMemo(() => {
    const rows = RANK_ORDER.map((role) =>
      swarm.config.agents.filter((a) => a.role === role),
    ).filter((r) => r.length > 0);

    const calcNodes: NodeData[] = [];
    const calcEdges: EdgeData[] = [];
    const calcLabels: RowLabelData[] = [];

    rows.forEach((row, rowIndex) => {
      if (row.length === 0) return;

      const rowWidth = row.length * CARD_W + (row.length - 1) * GAP_X;
      const startX = -rowWidth / 2;
      const y = rowIndex * (CARD_H + GAP_Y);

      calcLabels.push({
        role: row[0]!.role,
        count: row.length,
        y: y - LABEL_OFFSET_Y,
        width: rowWidth < 600 ? 600 : rowWidth,
      });

      row.forEach((agent, colIndex) => {
        const x = startX + colIndex * (CARD_W + GAP_X);
        calcNodes.push({ ...agent, x, y, rowIndex });
      });
    });

    for (let i = 0; i < rows.length - 1; i++) {
      const currentLayer = calcNodes.filter((n) => n.rowIndex === i);
      const nextLayer = calcNodes.filter((n) => n.rowIndex === i + 1);

      currentLayer.forEach((parent) => {
        nextLayer.forEach((child) => {
          calcEdges.push({
            id: `${parent.id}-${child.id}`,
            x1: parent.x + CARD_W / 2,
            y1: parent.y + CARD_H,
            x2: child.x + CARD_W / 2,
            y2: child.y,
            fromRole: parent.role,
            toRole: child.role,
          });
        });
      });
    }

    return { nodes: calcNodes, edges: calcEdges, rowLabels: calcLabels };
  }, [swarm.config.agents]);

  const { summary, primaryStatus, hasRunning } = useMemo(
    () => summarizeStatuses(effectiveSwarm),
    [effectiveSwarm],
  );

  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const findRuntimeAgent = useMemo(() => {
    const runtimeById = new Map(
      effectiveSwarm.agents.map((entry) => [entry.agentId, entry] as const),
    );
    const runtimeByIdLower = new Map(
      effectiveSwarm.agents.map((entry) => [entry.agentId.toLowerCase(), entry] as const),
    );
    return (agentId: string) =>
      runtimeById.get(agentId) ?? runtimeByIdLower.get(agentId.toLowerCase());
  }, [effectiveSwarm.agents]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    setPos({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    isDragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const handleWheel = (e: React.WheelEvent) => {
    const newScale = scale + (e.deltaY > 0 ? -0.05 : 0.05);
    setScale(Math.min(Math.max(0.3, newScale), 2));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-[#0a0c10] px-3 py-3 sm:px-5 sm:py-4 text-slate-300 font-sans selection:bg-blue-500/30">
      <SwarmControlBar
        mission={swarm.config.mission}
        statusLabel={summary}
        statusTone={primaryStatus}
        canStart={!hasRunning}
        canStop={hasRunning}
        name={swarm.config.name}
        isTranscriptHidden={transcriptMode === "hidden"}
        viewMode={viewMode}
        onToggleTranscript={() =>
          setTranscriptMode((prev) => (prev === "hidden" ? "normal" : "hidden"))
        }
        onToggleViewMode={() =>
          setViewMode((prev) => (prev === "visualizer" ? "terminals" : "visualizer"))
        }
        {...(onStartSwarm ? { onStart: onStartSwarm } : {})}
        {...(onStopSwarm ? { onStop: onStopSwarm } : {})}
        {...(swarm.config.targetPath ? { targetPath: swarm.config.targetPath } : {})}
      />

      <div className="grid flex-1 min-h-0 gap-4 xl:grid-cols-[2.2fr_1fr]">
        <Card className="relative min-w-0 overflow-hidden border-[#1a1f29] bg-[#0c0e12] shadow-2xl flex flex-col h-[700px]">
          <CardHeader className="relative z-20 border-b border-[#1a1f29]/80 bg-[#0c0e12] backdrop-blur-md pb-4 shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                {viewMode === "visualizer" ? (
                  <>
                    <Activity className="h-4 w-4 text-[#5b8bf7]" />
                    <CardTitle className="text-xs font-semibold tracking-widest text-slate-400 font-mono uppercase">
                      Swarm Visualizer
                    </CardTitle>
                  </>
                ) : (
                  <>
                    <TerminalSquare className="h-4 w-4 text-[#2dd4bf]" />
                    <CardTitle className="text-xs font-semibold tracking-widest text-slate-400 font-mono uppercase">
                      Agent Terminals
                    </CardTitle>
                  </>
                )}
              </div>

              {viewMode === "visualizer" ? (
                <div className="flex items-center gap-1 rounded-md border border-[#1a1f29] bg-[#0f1218] p-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-slate-400 hover:text-white hover:bg-[#1a1f29]"
                    onClick={() => setScale((s) => Math.max(0.3, s - 0.2))}
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-slate-400 hover:text-white hover:bg-[#1a1f29]"
                    onClick={() => {
                      setScale(1);
                      setPos({ x: 0, y: 0 });
                    }}
                  >
                    <Maximize className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-slate-400 hover:text-white hover:bg-[#1a1f29]"
                    onClick={() => setScale((s) => Math.min(2, s + 0.2))}
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1 rounded-md border border-[#1a1f29] bg-[#0f1218] px-2 py-1 text-[10px] font-mono text-slate-500">
                  {swarm.config.agents.length} agent{swarm.config.agents.length !== 1 ? "s" : ""}{" "}
                  connected
                </div>
              )}
            </div>
          </CardHeader>

          {viewMode === "visualizer" ? (
            <CardContent
              className="relative flex-1 p-0 overflow-hidden bg-[radial-gradient(circle_at_center,_#12161f_0%,_#090a0d_100%)] cursor-grab active:cursor-grabbing select-none"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onWheel={handleWheel}
            >
              <div
                className="absolute top-1/2 left-1/2 w-[4000px] h-[4000px] origin-center touch-none pointer-events-none"
                style={{
                  transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px)) scale(${scale})`,
                }}
              >
                <svg className="absolute inset-0 w-full h-full pointer-events-none z-0">
                  <defs>
                    {edges.map((edge) => (
                      <linearGradient
                        key={`grad-${edge.id}`}
                        id={`grad-${edge.id}`}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor={ROLE_COLORS[edge.fromRole]}
                          stopOpacity="0.4"
                        />
                        <stop
                          offset="100%"
                          stopColor={ROLE_COLORS[edge.toRole]}
                          stopOpacity="0.1"
                        />
                      </linearGradient>
                    ))}
                  </defs>

                  {edges.map((edge) => {
                    const originX = 2000 + edge.x1;
                    const originY = 2000 + edge.y1;
                    const targetX = 2000 + edge.x2;
                    const targetY = 2000 + edge.y2;

                    const midY = originY + 30;
                    const labelY = targetY - LABEL_OFFSET_Y;

                    const gapTop = labelY - 14;
                    const gapBottom = labelY + 14;

                    const pathD = `
                      M ${originX} ${originY} 
                      L ${originX} ${midY} 
                      L ${targetX} ${midY} 
                      L ${targetX} ${gapTop} 
                      M ${targetX} ${gapBottom} 
                      L ${targetX} ${targetY}
                    `;

                    return (
                      <g key={edge.id}>
                        <path d={pathD} fill="none" stroke="#1e2536" strokeWidth={2} />
                        <path
                          d={pathD}
                          fill="none"
                          stroke={`url(#grad-${edge.id})`}
                          strokeWidth={2}
                          className="drop-shadow-[0_0_8px_rgba(91,139,247,0.3)]"
                        />
                        <circle
                          cx={targetX}
                          cy={midY}
                          r="3.5"
                          fill="#323e59"
                          stroke="#0a0c10"
                          strokeWidth="1.5"
                        />
                        <circle
                          cx={originX}
                          cy={originY}
                          r="2.5"
                          fill={ROLE_COLORS[edge.fromRole]}
                        />
                        <circle cx={targetX} cy={targetY} r="2.5" fill={ROLE_COLORS[edge.toRole]} />
                      </g>
                    );
                  })}
                </svg>

                <div className="absolute inset-0 w-full h-full pointer-events-none z-0">
                  {rowLabels.map((label) => {
                    const themeColor = ROLE_COLORS[label.role];
                    return (
                      <div
                        key={`label-${label.role}-${Math.round(label.y)}`}
                        className="absolute left-1/2 flex items-center justify-center gap-4"
                        style={{
                          transform: "translate(-50%, -50%)",
                          top: 2000 + label.y,
                          width: label.width,
                        }}
                      >
                        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-[#1e2536]" />
                        <div
                          className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] px-2"
                          style={{ color: themeColor }}
                        >
                          {ROLE_ICONS[label.role]}
                          <span>
                            {label.role}s ({label.count})
                          </span>
                        </div>
                        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-[#1e2536]" />
                      </div>
                    );
                  })}
                </div>

                <div className="absolute inset-0 w-full h-full z-10">
                  {nodes.length === 0 ? (
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 font-mono text-sm text-slate-600">
                      Awaiting Agent Initialization...
                    </div>
                  ) : (
                    nodes.map((node) => {
                      const runtime = findRuntimeAgent(node.id);
                      return (
                        <div
                          key={node.id}
                          className="absolute pointer-events-auto"
                          style={{
                            left: 2000 + node.x,
                            top: 2000 + node.y,
                            width: CARD_W,
                            height: CARD_H,
                          }}
                        >
                          <SwarmAgentCard
                            agent={node}
                            {...(runtime ? { runtimeStatus: runtime.status } : {})}
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </CardContent>
          ) : (
            <CardContent className="relative flex-1 p-4 overflow-auto bg-[#0c0e12]">
              <SwarmTerminalsView swarm={swarm} threadId={threadId} cwd={cwd} />
            </CardContent>
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-4 max-h-[700px] h-[700px] overflow-hidden">
          <div
            className={cn(
              "rounded-xl border border-[#1a1f29] bg-[#0c0e12] overflow-hidden flex flex-col min-w-0 min-h-0 transition-all duration-300 ease-in-out",
              streamingMode === "hidden" && transcriptMode === "hidden" ? "flex-1" : "flex-[0.9]",
            )}
          >
            <SwarmConversationPanelV1 threadId={threadId} swarm={swarm} onSend={onSendMessage} />
          </div>

          {streamingMode !== "hidden" && (
            <div
              className={cn(
                "rounded-xl border border-[#1a1f29] bg-[#0c0e12] overflow-hidden flex flex-col min-w-0 min-h-0 transition-all duration-300 ease-in-out",
                streamingMode === "expanded" ? "flex-[1.4]" : "flex-1",
              )}
            >
              <SwarmStreamingPanel
                swarm={swarm}
                liveMessages={liveSwarm?.messages ?? []}
                cwd={cwd}
                isExpanded={streamingMode === "expanded"}
                onToggleExpand={() =>
                  setStreamingMode((m) => (m === "expanded" ? "normal" : "expanded"))
                }
                onClose={() => setStreamingMode("hidden")}
              />
            </div>
          )}

          {transcriptMode !== "hidden" && (
            <div
              className={cn(
                "rounded-xl border border-[#1a1f29] bg-[#0c0e12] overflow-hidden flex flex-col min-w-0 min-h-0 transition-all duration-300 ease-in-out",
                transcriptMode === "expanded" ? "flex-[1.5]" : "flex-1",
              )}
            >
              <SwarmActivityFeed
                swarm={swarm}
                isExpanded={transcriptMode === "expanded"}
                onToggleExpand={() =>
                  setTranscriptMode((m) => (m === "expanded" ? "normal" : "expanded"))
                }
                onClose={() => setTranscriptMode("hidden")}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SwarmAgentCard({
  agent,
  runtimeStatus,
}: {
  agent: SwarmState["config"]["agents"][number];
  runtimeStatus?: SwarmState["agents"][number]["status"];
}) {
  const status = runtimeStatus ?? "idle";
  const theme = ROLE_THEME[agent.role];
  const hexColor = ROLE_COLORS[agent.role];
  const activeStyle = STATUS_STYLE[status];

  return (
    <div
      className="group relative flex w-full h-full flex-col rounded-2xl bg-[#0e1218]/90 backdrop-blur-md shadow-2xl transition-all duration-300 hover:shadow-[0_8px_40px_rgba(0,0,0,0.6)]"
      style={{
        border: "1px solid #1a202c",
        borderTop: `2px solid ${hexColor}`,
        borderBottom: `2px solid ${hexColor}40`,
        boxShadow: `inset 0 30px 40px -30px ${theme.highlight}, 0 10px 30px -10px rgba(0,0,0,0.8)`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col px-4 pt-4 pb-3 flex-1 z-10">
        <div className="flex items-center gap-2 mb-3">
          <div className={cn("opacity-90", theme.text)}>{ROLE_ICONS[agent.role]}</div>
          <span className="font-bold tracking-wide text-[15px] text-white">{agent.name}</span>
        </div>

        <div className="flex items-center justify-between font-mono mb-4">
          <div className="flex items-center gap-3">
            <div className={cn("flex items-center gap-1.5 opacity-90", theme.text)}>
              <div
                className={cn("h-1.5 w-1.5 rounded-full shadow-[0_0_8px_currentColor]", theme.dot)}
              />
              <span className="text-[10px] font-bold uppercase tracking-widest leading-none mt-[1px]">
                {agent.role}
              </span>
            </div>
            <div
              className={cn(
                "text-[10px] font-bold uppercase tracking-widest leading-none mt-[1px]",
                activeStyle.text,
              )}
            >
              {activeStyle.label}
            </div>
          </div>
          <div className="text-[10px] font-bold text-slate-500 tracking-wider">## 99%</div>
        </div>

        <div className="flex flex-col gap-2 w-full mt-auto">
          <div className="flex items-center gap-2.5 w-full rounded-md bg-[#131822] border border-[#1e2638] px-3 py-1.5 font-mono text-[10px] text-slate-400">
            <Box className="h-3.5 w-3.5 text-slate-500" />
            <span className="uppercase tracking-wider">{agent.model ?? "GPT-4O-MINI"}</span>
          </div>

          <div className="flex items-center gap-2.5 w-full rounded-md bg-[#131822] border border-[#1e2638] px-3 py-1.5 font-mono text-[10px] text-slate-500 truncate">
            <Hash className={cn("h-3.5 w-3.5", theme.text)} />
            <span className="truncate tracking-wider uppercase">
              [SYSTEM AGENT: {agent.id.slice(0, 12)}...]
            </span>
          </div>
        </div>
      </div>

      <div className="border-t border-[#1e2638] bg-[#0c0f14]/80 rounded-b-2xl px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-2 font-mono text-[10px] font-medium tracking-wide text-slate-600">
          <TerminalSquare
            className={cn(
              "h-3 w-3",
              status === "running" ? "text-emerald-500/70 animate-pulse" : "opacity-40",
            )}
          />
          {status === "running" ? "Executing sequence..." : "Booting CLI session"}
        </div>
      </div>
    </div>
  );
}

function SwarmControlBar({
  mission,
  targetPath,
  name,
  statusLabel,
  statusTone,
  isTranscriptHidden,
  viewMode,
  onToggleTranscript,
  onToggleViewMode,
  onStart,
  onStop,
  canStart,
  canStop,
}: {
  mission: string;
  name: string;
  targetPath?: string;
  statusLabel: string;
  statusTone: SwarmState["agents"][number]["status"];
  isTranscriptHidden: boolean;
  viewMode: "visualizer" | "terminals";
  onToggleTranscript: () => void;
  onToggleViewMode: () => void;
  onStart?: () => void;
  onStop?: () => void;
  canStart: boolean;
  canStop: boolean;
}) {
  const currentStatusStyle = STATUS_STYLE[statusTone] || STATUS_STYLE.idle;
  const { copyToClipboard, isCopied } = useCopyToClipboard<{ mission: string }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Mission copied",
        description: ctx.mission,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy mission",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  return (
    <Card className="border border-[#1a1f29] bg-[#0c0e12] shadow-xl shrink-0">
      <CardContent className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 px-4 py-3">
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <div className="flex items-center gap-2 mb-1 min-w-0">
            <div className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-[#5b8bf7] shrink-0">
              Mission
            </div>
            <span className="text-[#1a1f29] font-mono text-[10px] shrink-0">/</span>
            <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-slate-400 truncate shrink-0 max-w-[120px] lg:max-w-[200px]">
              {name}
            </span>
            {targetPath && (
              <>
                <span className="text-[#1a1f29] font-mono text-[10px] shrink-0">/</span>
                <span className="text-[10px] font-mono text-slate-500 shrink-0">PATH:</span>
                <span className="text-[10px] font-mono text-slate-300 bg-[#161b24] px-1.5 py-0.5 rounded border border-[#212735] truncate min-w-0">
                  {targetPath}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="text-[14px] font-medium text-slate-200 tracking-wide truncate"
              title={mission}
            >
              {mission}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-slate-400 hover:text-white hover:bg-[#1a202c]"
              onClick={() => copyToClipboard(mission, { mission })}
              aria-label="Copy mission"
              title="Copy mission"
            >
              {isCopied ? (
                <CheckIcon className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <CopyIcon className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 overflow-x-auto pb-1 xl:pb-0 hide-scrollbar">
          <div className="flex items-center gap-2 rounded-md border border-[#1a1f29] bg-[#080a0e] px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-300 shrink-0">
            <div
              className={cn(
                "h-1.5 w-1.5 rounded-full shadow-[0_0_8px_currentColor]",
                currentStatusStyle.text.replace("text-", "bg-"),
              )}
            />
            {statusLabel}
          </div>

          <div className="h-4 w-px bg-[#1a1f29] mx-1 shrink-0 hidden sm:block" />

          <Button
            variant="outline"
            size="sm"
            onClick={onToggleTranscript}
            className={cn(
              "shrink-0 border-[#1a1f29] bg-transparent text-slate-400 hover:bg-[#1a202c] hover:border-[#2d3748] hover:text-slate-200 h-8 font-mono text-[10px] uppercase tracking-wider transition-all",
              !isTranscriptHidden && "bg-[#1a202c] border-[#2d3748] text-slate-200",
            )}
          >
            <ScrollText className="mr-1.5 h-3.5 w-3.5" />
            Transcript
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={onToggleViewMode}
            className={cn(
              "shrink-0 border-[#1a1f29] bg-transparent text-slate-400 hover:bg-[#1a202c] hover:border-[#2d3748] hover:text-slate-200 h-8 font-mono text-[10px] uppercase tracking-wider transition-all",
              viewMode === "terminals" && "bg-[#1a202c] border-[#2dd4bf] text-[#2dd4bf]",
            )}
          >
            <TerminalSquare className="mr-1.5 h-3.5 w-3.5" />
            {viewMode === "visualizer" ? "Terminals" : "Visualizer"}
          </Button>

          <div className="h-4 w-px bg-[#1a1f29] mx-1 shrink-0 hidden sm:block" />

          {canStop ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onStop}
              disabled={!onStop}
              className="shrink-0 border-[#1a1f29] bg-transparent text-slate-400 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 h-8 font-mono text-[10px] uppercase tracking-wider transition-all"
            >
              <PauseCircle className="mr-1.5 h-3.5 w-3.5" /> Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={onStart}
              disabled={!onStart || !canStart}
              className="shrink-0 bg-[#2458d1] text-white hover:bg-[#346ced] shadow-[0_0_15px_-5px_rgba(36,88,209,0.5)] border border-[#3b71f7]/50 h-8 font-mono text-[10px] uppercase tracking-wider transition-all"
            >
              <Play className="mr-1.5 h-3.5 w-3.5" /> Execute
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function summarizeStatuses(swarm: SwarmState): {
  summary: string;
  primaryStatus: SwarmState["agents"][number]["status"];
  hasRunning: boolean;
} {
  if (swarm.agents.length === 0) {
    return { summary: "Offline", primaryStatus: "idle", hasRunning: false };
  }
  const statuses = swarm.agents.map((a) => a.status);
  const hasError = statuses.includes("error");
  const hasRunning = statuses.some((s) => s === "running" || s === "starting");
  const allStopped = statuses.every((s) => s === "stopped" || s === "idle");

  if (hasError) return { summary: "Critical Error", primaryStatus: "error", hasRunning };
  if (hasRunning) return { summary: "System Active", primaryStatus: "running", hasRunning };
  if (allStopped) return { summary: "Standby", primaryStatus: "stopped", hasRunning };
  return { summary: "Ready", primaryStatus: "ready", hasRunning };
}
