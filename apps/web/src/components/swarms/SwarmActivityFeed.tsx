import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import type { SwarmState } from "@t3tools/contracts";
import ReactMarkdown from "react-markdown";
import { 
  ScrollText, 
  X, 
  Maximize2, 
  Minimize2, 
  Bot, 
  User, 
  ArrowRight,
  ChevronDown,
  ChevronRight
} from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { formatSwarmMessage } from "../../lib/swarmMessageFormatting";

type SwarmActivityFeedProps = {
  swarm: SwarmState;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onClose?: () => void;
};

export function SwarmActivityFeed({ 
  swarm, 
  isExpanded = false, 
  onToggleExpand, 
  onClose 
}: SwarmActivityFeedProps) {
  const [showRawDirectives, setShowRawDirectives] = useState(false);
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(() => new Set());
  const feedEndRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(
    () => swarm.messages.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [swarm.messages],
  );

  const messagesByAgent = useMemo(() => {
    const byAgent = new Map<string, { entry: (typeof messages)[number]; formatted: ReturnType<typeof formatSwarmMessage> }[]>();
    for (const entry of messages) {
      const formatted = formatSwarmMessage(entry, swarm.config.agents, showRawDirectives || entry.streaming);
      if (formatted.hideWhenNotRaw) continue;
      const agentKey = entry.sender === "operator" ? "operator" : (entry.senderAgentId ?? "unknown");
      const group = byAgent.get(agentKey);
      const item = { entry, formatted };
      if (group) {
        group.push(item);
      } else {
        byAgent.set(agentKey, [item]);
      }
    }
    return byAgent;
  }, [messages, showRawDirectives, swarm.config.agents]);

  const agentOrder = useMemo(() => {
    const ordered = swarm.config.agents.map((agent) => agent.id);
    if (messagesByAgent.has("operator")) {
      ordered.unshift("operator");
    }
    if (messagesByAgent.has("unknown")) {
      ordered.push("unknown");
    }
    return ordered.filter((id, index) => ordered.indexOf(id) === index);
  }, [messagesByAgent, swarm.config.agents]);

  const getAgentName = (id?: string | null) => {
    if (!id) return "Agent";
    if (id === "operator") return "Operator";
    if (id === "unknown") return "Unknown Agent";
    return swarm.config.agents.find((agent) => agent.id === id)?.name ?? id;
  };

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

   useEffect(() => {
     if (feedEndRef.current && typeof feedEndRef.current.scrollIntoView === 'function') {
       feedEndRef.current.scrollIntoView({ behavior: "smooth" });
     }
   }, [messages]);

  // Reusable markdown components adapted for timeline density
  const markdownComponents = {
    p: ({ children }: any) => <p className="mb-2 last:mb-0">{children}</p>,
    ul: ({ children }: any) => <ul className="mb-2 ml-4 list-disc space-y-1">{children}</ul>,
    ol: ({ children }: any) => <ol className="mb-2 ml-4 list-decimal space-y-1">{children}</ol>,
    li: ({ children }: any) => <li className="pl-1">{children}</li>,
    h1: ({ children }: any) => <h1 className="mb-2 mt-4 text-sm font-bold">{children}</h1>,
    h2: ({ children }: any) => <h2 className="mb-2 mt-3 text-sm font-bold">{children}</h2>,
    h3: ({ children }: any) => <h3 className="mb-2 mt-2 text-xs font-bold">{children}</h3>,
    a: ({ children, href }: any) => <a href={href} className="underline underline-offset-2 opacity-90 hover:opacity-100" target="_blank" rel="noreferrer">{children}</a>,
    blockquote: ({ children }: any) => <blockquote className="border-l-2 border-foreground/30 pl-3 italic opacity-80 my-2">{children}</blockquote>,
    code: ({ inline, className, children, ...props }: any) => {
      const match = /language-(\w+)/.exec(className || "");
      const isInline = inline || !match;
      return isInline ? (
        <code className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[12px]" {...props}>
          {children}
        </code>
      ) : (
        <div className="my-2 overflow-hidden rounded-md border border-foreground/10 bg-foreground/5 shadow-inner">
          <div className="bg-foreground/10 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-foreground/70">
            {match?.[1] || "code"}
          </div>
          <pre className="overflow-x-auto p-3 text-[12px] leading-snug">
            <code className={className} {...props}>{children}</code>
          </pre>
        </div>
      );
    },
  };

  return (
    <div className="flex h-full w-full flex-col bg-background/95 min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 bg-muted/10 px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
            <ScrollText className="size-3.5" />
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
              Swarm Transcript
            </h3>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 ml-1 border-l border-border/50 pl-2">
            <Button
              variant={showRawDirectives ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-[10px] uppercase tracking-wide"
              onClick={() => setShowRawDirectives((current) => !current)}
              title={showRawDirectives ? "Hide raw directive messages" : "Show raw directive messages"}
            >
              OG
            </Button>
            {onToggleExpand && (
              <Button 
                variant="ghost" 
                size="icon" 
                className="size-7 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={onToggleExpand}
                title={isExpanded ? "Minimize" : "Maximize"}
              >
                {isExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </Button>
            )}
            {onClose && (
              <Button 
                variant="ghost" 
                size="icon" 
                className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={onClose}
                title="Close Feed"
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-muted/5 p-4 scroll-smooth min-h-0">
        {messagesByAgent.size === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center opacity-60 transition-opacity hover:opacity-100">
            <ScrollText className="mb-3 size-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">No activity yet</p>
            <p className="mt-1 max-w-[250px] text-xs text-muted-foreground">
              Agent messages will stream here automatically once the swarm executes.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {agentOrder.map((agentId) => {
              const items = messagesByAgent.get(agentId);
              if (!items || items.length === 0) return null;
              const isCollapsed = collapsedAgents.has(agentId);
              const isOperator = agentId === "operator";
              const headerIcon = isOperator ? <User className="size-3" /> : <Bot className="size-3" />;
              const headerName = getAgentName(agentId);

              return (
                <div key={agentId} className="rounded-lg border border-border/50 bg-background/70 shadow-sm">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 border-b border-border/40 px-3 py-2 text-left"
                    onClick={() => toggleAgent(agentId)}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`flex size-6 items-center justify-center rounded-full border bg-background shadow-sm ${
                        isOperator ? "border-primary/50 text-primary" : "border-border text-muted-foreground"
                      }`}>
                        {headerIcon}
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
                        {headerName}
                      </span>
                      <Badge variant="outline" className="h-5 px-2 text-[10px] uppercase tracking-wide">
                        {items.length} {items.length === 1 ? "message" : "messages"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <span className="text-[10px] uppercase tracking-wide">{isCollapsed ? "Show" : "Hide"}</span>
                      {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                    </div>
                  </button>

                  {!isCollapsed && (
                    <div className="relative space-y-4 px-3 py-3 before:absolute before:inset-y-3 before:left-[11px] before:w-px before:bg-border/50">
                      {items.map(({ entry, formatted }) => {
                        const targetName = formatted.targetAgentId ? getAgentName(formatted.targetAgentId) : "All Agents";
                        return (
                          <div key={entry.id} className="relative pl-8 animate-in fade-in slide-in-from-left-2 duration-300">
                            <div className={`absolute left-0 top-1.5 flex size-[22px] items-center justify-center rounded-full border bg-background shadow-sm ${
                              isOperator ? "border-primary/50 text-primary" : "border-border text-muted-foreground"
                            }`}>
                              {headerIcon}
                            </div>

                            <div className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-background/50 p-3 shadow-sm backdrop-blur-sm transition-colors hover:bg-background">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                                  {isOperator ? (
                                    <Badge variant="default" className="h-4 px-1.5 text-[9px] bg-primary/20 text-primary hover:bg-primary/20 rounded-sm">
                                      Operator
                                    </Badge>
                                  ) : (
                                    <span className="text-foreground">{headerName}</span>
                                  )}
                                  <ArrowRight className="size-3 opacity-50" />
                                  <span className="opacity-70">{targetName}</span>
                                </div>
                                <span className="text-[10px] text-muted-foreground/60 font-mono">
                                  {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                              </div>

                              <div className="text-sm leading-relaxed text-foreground/90 break-words">
                                <ReactMarkdown components={markdownComponents}>
                                  {formatted.text}
                                </ReactMarkdown>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={feedEndRef} className="h-1 w-full" />
          </div>
        )}
      </div>
    </div>
  );
}
