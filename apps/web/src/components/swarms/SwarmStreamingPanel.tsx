import { useMemo, useState, useCallback } from "react";
import type { SwarmState } from "@t3tools/contracts";
import { Bot, ChevronDown, ChevronRight, Eye, EyeOff, Activity } from "lucide-react";

import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import ChatMarkdown from "../ChatMarkdown";
import type { SwarmLiveMessage } from "../../store";

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
      id: string;
      text: string;
      streaming: boolean;
      createdAt: string;
      targetAgentId: string | null;
      senderAgentId: string | null;
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
    const byAgent = new Map<
      string,
      SwarmLiveMessage[]
    >();
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

  return (
    <div className="flex h-full w-full flex-col bg-background/95 min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 bg-muted/10 px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
            <Activity className="size-3.5" />
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
              Agent Streaming
            </h3>
            <p className="text-[10px] text-muted-foreground">Live output and thinking per agent</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onToggleExpand && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[10px] uppercase tracking-wide"
              onClick={onToggleExpand}
              title={isExpanded ? "Minimize" : "Maximize"}
            >
              {isExpanded ? "Minimize" : "Expand"}
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
              onClick={onClose}
              title="Hide panel"
            >
              Hide
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-muted/5 p-4 scroll-smooth min-h-0">
        {messagesByAgent.size === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center opacity-60 transition-opacity hover:opacity-100">
            <Activity className="mb-3 size-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">No streaming yet</p>
            <p className="mt-1 max-w-[260px] text-xs text-muted-foreground">
              Live agent output and thinking will appear here during swarm execution.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {agentOrder.map((agentId) => {
              const items = messagesByAgent.get(agentId);
              if (!items || items.length === 0) return null;
              const isCollapsed = collapsedAgents.has(agentId);
              const headerName = getAgentName(agentId);

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
                <div key={agentId} className="rounded-lg border border-border/50 bg-background/70 shadow-sm">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 border-b border-border/40 px-3 py-2 text-left"
                    onClick={() => toggleAgent(agentId)}
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex size-6 items-center justify-center rounded-full border bg-background shadow-sm border-border text-muted-foreground">
                        <Bot className="size-3" />
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
                        {headerName}
                      </span>
                      <Badge variant="outline" className="h-5 px-2 text-[10px] uppercase tracking-wide">
                        {blocks.length} {blocks.length === 1 ? "item" : "items"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <span className="text-[10px] uppercase tracking-wide">{isCollapsed ? "Show" : "Hide"}</span>
                      {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                    </div>
                  </button>

                  {!isCollapsed && (
                    <div className="space-y-3 px-3 py-3">
                      {blocks.map((block) => {
                        if (block.type === "thinking") {
                          const isHidden = collapsedThinking.has(block.id);
                          return (
                            <div key={block.id} className="rounded-md border border-dashed border-foreground/20 bg-foreground/5">
                              <button
                                type="button"
                                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] uppercase tracking-wide text-foreground/70"
                                onClick={() => toggleThinking(block.id)}
                              >
                                <div className="flex items-center gap-2">
                                  {isHidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                                  <span>Thinking</span>
                                </div>
                                <span className="text-[10px] text-muted-foreground">
                                  {block.streaming ? "Live" : "Complete"}
                                </span>
                              </button>
                              {!isHidden && (
                                <div className="px-3 pb-3 text-xs text-muted-foreground">
                                  <ChatMarkdown
                                    text={block.text}
                                    cwd={cwd ?? undefined}
                                    isStreaming={block.streaming}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        }

                        const targetName = block.targetAgentId ? getAgentName(block.targetAgentId) : "All Agents";
                        return (
                          <div key={block.id} className="rounded-md border border-border/50 bg-background/60 p-3 shadow-sm">
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                              <span>{headerName} → {targetName}</span>
                              <span className="font-mono">
                                {new Date(block.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                              </span>
                            </div>
                            <div className="text-sm leading-relaxed text-foreground/90 break-words">
                              <ChatMarkdown
                                text={block.text}
                                cwd={cwd ?? undefined}
                                isStreaming={block.streaming}
                              />
                            </div>
                          </div>
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
