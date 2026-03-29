import { useMemo, useState, useCallback } from "react";
import type { SwarmState } from "@t3tools/contracts";
import { ChevronDown, ChevronRight, Eye, EyeOff, Activity } from "lucide-react";

import ChatMarkdown from "../ChatMarkdown";
import type { SwarmLiveMessage } from "../../store";
import { getSwarmMessageRouteLabel } from "../../lib/swarmMessagePresentation";
import { cn } from "../../lib/utils";
import { ROLE_COLORS, colorWithAlpha } from "./swarmRoleColors";
import type { SwarmAgentRole } from "@t3tools/contracts";

type SwarmStreamingPanelProps = {
  swarm: SwarmState;
  liveMessages: SwarmLiveMessage[];
  cwd?: string | null | undefined;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onClose?: () => void;
};

type StreamingBlock =
  | {
      type: "thinking";
      id: string;
      text: string;
      streaming: boolean;
      createdAt: string;
    }
  | {
      type: "message";
      messageKind: "assistant" | "tool" | "mcp";
      id: string;
      text: string;
      streaming: boolean;
      createdAt: string;
      targetAgentId: string | null;
      senderAgentId: string | null;
    };

function isBootstrapPromptEcho(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const startLine =
    "Start the swarm. Use the instructions to coordinate, message teammates, and ship the mission.";
  const operatorPrefix = "MESSAGE FROM operator:";
  return (
    normalized.includes(startLine) &&
    (normalized.startsWith("[TaskContext]") ||
      normalized.startsWith(operatorPrefix) ||
      normalized === startLine)
  );
}

const getAgentColor = (role: string): string => {
  const typedRole = role as SwarmAgentRole;
  return ROLE_COLORS[typedRole] ?? ROLE_COLORS["builder"];
};

export function SwarmStreamingPanel({
  swarm,
  liveMessages,
  cwd,
  isExpanded = false,
  onToggleExpand,
  onClose,
}: SwarmStreamingPanelProps) {
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(() => new Set());
  const [collapsedThinking, setCollapsedThinking] = useState<Set<string>>(() => new Set());

  const messagesByAgent = useMemo(() => {
    const byAgent = new Map<string, SwarmLiveMessage[]>();
    for (const entry of liveMessages) {
      const agentKey = entry.agentId ?? "unknown";
      const group = byAgent.get(agentKey);
      if (group) {
        group.push(entry);
      } else {
        byAgent.set(agentKey, [entry]);
      }
    }
    return byAgent;
  }, [liveMessages]);

  const agentOrder = useMemo(() => {
    const ordered = swarm.config.agents.map((agent) => agent.id);
    for (const key of messagesByAgent.keys()) {
      if (!ordered.includes(key)) {
        ordered.push(key);
      }
    }
    return ordered;
  }, [messagesByAgent, swarm.config.agents]);

  const getAgentName = useCallback(
    (id?: string | null) => {
      if (!id) return "Agent";
      if (id === "unknown") return "Unknown Agent";
      return swarm.config.agents.find((agent) => agent.id === id)?.name ?? id;
    },
    [swarm.config.agents],
  );

  const getAgentRole = useCallback(
    (id?: string | null): string => {
      if (!id) return "builder";
      return swarm.config.agents.find((a) => a.id === id)?.role ?? "builder";
    },
    [swarm.config.agents],
  );

  const toggleAgent = useCallback((agentId: string) => {
    setCollapsedAgents((current) => {
      const next = new Set(current);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);

  const toggleThinking = useCallback((blockId: string) => {
    setCollapsedThinking((current) => {
      const next = new Set(current);
      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
      }
      return next;
    });
  }, []);

  const activeAgentCount = useMemo(() => {
    let count = 0;
    for (const agentId of agentOrder) {
      const items = messagesByAgent.get(agentId);
      if (items && items.length > 0 && items.some((i) => i.streaming)) count++;
    }
    return count;
  }, [agentOrder, messagesByAgent]);

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden bg-[#0c0c11]">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Activity className="size-3.5 text-zinc-500" />
          <span className="text-[12px] font-semibold tracking-wide text-zinc-300">
            Live Streams
          </span>
          {activeAgentCount > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-[1px] text-[10px] font-bold text-emerald-400 tabular-nums">
              <span className="inline-block size-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {activeAgentCount} active
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {onToggleExpand && (
            <button
              className="rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-300"
              onClick={onToggleExpand}
            >
              {isExpanded ? "Minimize" : "Expand"}
            </button>
          )}
          {onClose && (
            <button
              className="rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-400"
              onClick={onClose}
            >
              Hide
            </button>
          )}
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 pt-3 pb-6 scroll-smooth">
        {messagesByAgent.size === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Activity className="mb-3 size-6 text-zinc-700" />
            <p className="text-[13px] font-medium text-zinc-500">No streaming yet</p>
            <p className="mt-1 max-w-[240px] text-[11px] text-zinc-600 leading-relaxed">
              Live agent output and thinking will appear here during swarm execution.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {agentOrder.map((agentId) => {
              const items = messagesByAgent.get(agentId);
              if (!items || items.length === 0) return null;

              const isCollapsed = collapsedAgents.has(agentId);
              const agentName = getAgentName(agentId);
              const role = getAgentRole(agentId);
              const color = getAgentColor(role);
              const initial = agentName.charAt(0).toUpperCase();
              const isStreaming = items.some((i) => i.streaming);

              // Build blocks
              const blocks: StreamingBlock[] = [];
              for (const entry of items) {
                if (entry.kind === "thinking") {
                  const last = blocks[blocks.length - 1];
                  if (last?.type === "thinking") {
                    last.text = last.text ? `${last.text}\n${entry.text}` : entry.text;
                    last.streaming = last.streaming || entry.streaming;
                  } else {
                    blocks.push({
                      type: "thinking",
                      id: `thinking-${entry.id}`,
                      text: entry.text,
                      streaming: entry.streaming,
                      createdAt: entry.createdAt,
                    });
                  }
                } else {
                  blocks.push({
                    type: "message",
                    messageKind:
                      entry.kind === "tool" || entry.kind === "mcp" ? entry.kind : "assistant",
                    id: `message-${entry.id}`,
                    text: entry.text,
                    streaming: entry.streaming,
                    createdAt: entry.createdAt,
                    targetAgentId: entry.targetAgentId,
                    senderAgentId: entry.agentId,
                  });
                }
              }

              return (
                <div
                  key={agentId}
                  className="rounded-xl border border-white/[0.04] bg-[#131318] overflow-hidden"
                >
                  {/* Agent header */}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-white/[0.02]"
                    onClick={() => toggleAgent(agentId)}
                  >
                    {/* Avatar */}
                    <div
                      className="flex size-[26px] shrink-0 items-center justify-center rounded-full border text-[10px] font-bold leading-none"
                      style={{
                        backgroundColor: colorWithAlpha(color, 0.15),
                        color: color,
                        borderColor: colorWithAlpha(color, 0.35),
                      }}
                    >
                      {initial}
                    </div>

                    <span
                      className="text-[12px] font-semibold"
                      style={{ color: colorWithAlpha(color, 0.9) }}
                    >
                      {agentName}
                    </span>

                    <span className="rounded-[3px] bg-white/[0.04] px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider text-zinc-500">
                      {role}
                    </span>

                    {isStreaming && (
                      <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-emerald-400">
                        <span className="inline-block size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        streaming
                      </span>
                    )}

                    <div className="ml-auto flex items-center gap-1 text-zinc-600">
                      <span className="text-[10px] font-mono tabular-nums">{blocks.length}</span>
                      {isCollapsed ? (
                        <ChevronRight className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )}
                    </div>
                  </button>

                  {/* Blocks */}
                  {!isCollapsed && (
                    <div className="border-t border-white/[0.04] px-3 py-2.5 space-y-2">
                      {blocks.map((block) => {
                        if (block.type === "thinking") {
                          return (
                            <ThinkingBlock
                              key={block.id}
                              block={block}
                              isHidden={collapsedThinking.has(block.id)}
                              onToggle={() => toggleThinking(block.id)}
                              cwd={cwd}
                            />
                          );
                        }

                        if (
                          block.messageKind === "assistant" &&
                          isBootstrapPromptEcho(block.text)
                        ) {
                          return null;
                        }

                        return (
                          <MessageBlock
                            key={block.id}
                            block={block}
                            agentName={agentName}
                            getAgentName={getAgentName}
                            cwd={cwd}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Thinking Block ──────────────────────────────────────────────────────────

function ThinkingBlock({
  block,
  isHidden,
  onToggle,
  cwd,
}: {
  block: StreamingBlock & { type: "thinking" };
  isHidden: boolean;
  onToggle: () => void;
  cwd?: string | null | undefined;
}) {
  return (
    <div className="rounded-lg border border-dashed border-white/[0.06] bg-white/[0.02]">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left"
        onClick={onToggle}
      >
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {isHidden ? (
            <Eye className="size-3 text-zinc-600" />
          ) : (
            <EyeOff className="size-3 text-zinc-600" />
          )}
          Thinking
        </div>
        <span
          className={cn(
            "text-[9px] font-bold uppercase tracking-wider",
            block.streaming ? "text-amber-500/70" : "text-zinc-600",
          )}
        >
          {block.streaming ? "Live" : "Done"}
        </span>
      </button>

      {!isHidden && (
        <div className="border-t border-white/[0.04] px-3 py-2.5 text-[12px] text-zinc-500 leading-[1.6]">
          <ChatMarkdown text={block.text} cwd={cwd ?? undefined} isStreaming={block.streaming} />
        </div>
      )}
    </div>
  );
}

// ─── Message Block ───────────────────────────────────────────────────────────

function MessageBlock({
  block,
  agentName,
  getAgentName,
  cwd,
}: {
  block: StreamingBlock & { type: "message" };
  agentName: string;
  getAgentName: (id?: string | null) => string;
  cwd?: string | null | undefined;
}) {
  const routeLabel =
    block.messageKind === "assistant"
      ? getSwarmMessageRouteLabel({
          sender: "agent",
          senderName: agentName,
          targetAgentId: block.targetAgentId,
          getAgentName: (id) => getAgentName(id),
        })
      : block.messageKind === "tool"
        ? "Tool Call"
        : "MCP";

  const timeStr = new Date(block.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const targetName = block.targetAgentId ? getAgentName(block.targetAgentId) : null;
  const showTarget = block.messageKind === "assistant";

  return (
    <div className="rounded-lg border border-white/[0.04] bg-[#0e0e13] px-3.5 py-2.5">
      {/* Route + time header */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {routeLabel}
        </span>
        <div className="flex items-center gap-2">
          {block.streaming && (
            <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-emerald-400">
              <span className="inline-block size-1.5 rounded-full bg-emerald-400 animate-pulse" />
            </span>
          )}
          <span className="text-[10px] font-mono tabular-nums text-zinc-600">{timeStr}</span>
        </div>
      </div>

      {/* Content */}
      <div className="text-[13px] text-zinc-300 leading-[1.6] break-words">
        <ChatMarkdown text={block.text} cwd={cwd ?? undefined} isStreaming={block.streaming} />
      </div>

      {/* Target label */}
      {showTarget && targetName && (
        <div className="mt-1.5 text-[10px] font-medium text-zinc-600">→ {targetName}</div>
      )}
    </div>
  );
}
