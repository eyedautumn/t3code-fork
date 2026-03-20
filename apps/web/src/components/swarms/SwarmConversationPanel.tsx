import { useMemo, useState, useRef, useEffect } from "react";
import { SWARM_OPERATOR_TARGET_ID, type SwarmState, type ThreadId } from "@t3tools/contracts";
import ReactMarkdown, { type Components } from "react-markdown";
import { 
  Send, 
  Bot, 
  User, 
  Users, 
  ClipboardList, 
  Radio, 
  Terminal,
  ArrowRight
} from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Card } from "../ui/card";
import { formatSwarmMessage } from "../../lib/swarmMessageFormatting";

type SwarmConversationPanelProps = {
  threadId: ThreadId;
  swarm: SwarmState;
  onSend: (text: string, targetAgentId: string | null) => Promise<void> | void;
};

const isThinkingMessage = (text: string) => {
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith("[thinking]") || trimmed.startsWith("[reasoning]") || trimmed.startsWith("[thoughts]");
};

export function SwarmConversationPanel({ threadId, swarm, onSend }: SwarmConversationPanelProps) {
  const [message, setMessage] = useState("");
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agentOptions = useMemo(
    () =>
      swarm.config.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        label: `${agent.name} (${agent.role})`,
      })),
    [swarm.config.agents],
  );

  const coordinatorId = useMemo(
    () => swarm.config.agents.find((agent) => agent.role === "coordinator")?.id ?? null,
    [swarm.config.agents],
  );

  const sortedMessages = useMemo(
    () => swarm.messages.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [swarm.messages],
  );

  const visibleMessages = useMemo(
    () => sortedMessages.filter((entry) => !entry.streaming && !isThinkingMessage(entry.text ?? "")),
    [sortedMessages],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleMessages]);

  const handleSend = () => {
    if (!message.trim()) return;
    void onSend(message.trim(), targetAgentId);
    setMessage("");
  };

  const getAgentName = (id?: string | null) =>
    id === SWARM_OPERATOR_TARGET_ID
      ? "Operator"
      : id
        ? agentOptions.find((a) => a.id === id)?.name ?? id
        : "Agent";

  // Reusable markdown components for clean styling (omitting `node` so React doesn't complain)
  const markdownComponents: Components = {
    p: ({ node: _node, ...props }) => <p className="mb-2 leading-relaxed last:mb-0" {...props} />,
    ul: ({ node: _node, ...props }) => <ul className="mb-2 ml-4 list-disc space-y-1" {...props} />,
    ol: ({ node: _node, ...props }) => <ol className="mb-2 ml-4 list-decimal space-y-1" {...props} />,
    li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
    h1: ({ node: _node, ...props }) => <h1 className="mb-2 mt-4 text-lg font-bold" {...props} />,
    h2: ({ node: _node, ...props }) => <h2 className="mb-2 mt-4 text-base font-bold" {...props} />,
    h3: ({ node: _node, ...props }) => <h3 className="mb-2 mt-3 text-sm font-bold" {...props} />,
    a: ({ node: _node, ...props }) => (
      <a className="underline underline-offset-2 opacity-90 hover:opacity-100" target="_blank" rel="noreferrer" {...props} />
    ),
    blockquote: ({ node: _node, ...props }) => (
      <blockquote className="my-2 border-l-2 border-foreground/30 pl-3 italic opacity-80" {...props} />
    ),
    code: ({ node: _node, inline, className, children, ...props }: any) => {
      const match = /language-(\w+)/.exec(className || "");
      const isInline = inline || !match;
      return isInline ? (
        <code className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[13px]" {...props}>
          {children}
        </code>
      ) : (
        <div className="my-3 overflow-hidden rounded-md border border-foreground/10 bg-foreground/5 shadow-inner">
          <div className="bg-foreground/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-foreground/70">
            {match?.[1] || "code"}
          </div>
          <pre className="overflow-x-auto p-3 text-[13px] leading-snug">
            <code className={className} {...props}>{children}</code>
          </pre>
        </div>
      );
    },
  };

  return (
    <Card 
      className="flex h-full w-full min-h-0 flex-col overflow-hidden border-border/50 bg-background/95 shadow-lg backdrop-blur-md" 
      data-thread-id={threadId}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/50 bg-muted/10 px-4 py-3">
        <div className="flex min-w-0 max-w-full flex-1 items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
            <Terminal className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-foreground">Operator Console</h3>
            <p className="truncate text-[11px] text-muted-foreground">Monitor and command your swarm</p>
          </div>
        </div>

        <div className="flex w-full shrink-0 items-center gap-2 2xl:w-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-8 flex-1 gap-1.5 border-primary/20 bg-background hover:bg-primary/5 hover:text-primary 2xl:flex-none"
            onClick={() => {
              const prompt = "Give a concise swarm task status: active tasks, owners, owned files, dependencies, and current risks.";
              void onSend(prompt, coordinatorId ?? null);
            }}
          >
            <ClipboardList className="size-3.5 shrink-0" />
            <span className="truncate">Ask for Status</span>
          </Button>

          <Select
            value={targetAgentId ?? "broadcast"}
            onValueChange={(value) => setTargetAgentId(value === "broadcast" ? null : value)}
          >
            <SelectTrigger className="h-8 flex-1 border-border/50 bg-background text-xs shadow-sm focus:ring-primary/30 2xl:w-[150px] 2xl:flex-none">
              <div className="flex min-w-0 items-center gap-2">
                {targetAgentId ? <Bot className="size-3.5 shrink-0 text-primary" /> : <Radio className="size-3.5 shrink-0 text-primary" />}
                <SelectValue placeholder="Message all" className="truncate" />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="broadcast" className="text-xs">
                <div className="flex items-center gap-2 font-medium">
                  <Users className="size-3.5" />
                  Broadcast to All
                </div>
              </SelectItem>
              {agentOptions.map((agent) => (
                <SelectItem key={agent.id} value={agent.id} className="text-xs">
                  {agent.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/5 p-4 scroll-smooth">
        {visibleMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center opacity-70 transition-opacity hover:opacity-100">
            <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted/50 ring-1 ring-border/50">
              <Bot className="size-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Swarm Initialized</p>
            <p className="text-xs text-muted-foreground">Awaiting your command, operator.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {visibleMessages.map((entry) => {
              const formatted = formatSwarmMessage(entry, swarm.config.agents, false);
              if (formatted.hideWhenNotRaw) return null;
              const isOperator = entry.sender === "operator";
              const targetName = formatted.targetAgentId
                ? getAgentName(formatted.targetAgentId)
                : "All Agents";
              
              return (
                <div
                  key={entry.id}
                  className={`flex w-full ${isOperator ? "justify-end" : "justify-start"} animate-in fade-in slide-in-from-bottom-2 duration-300`}
                >
                  <div className={`flex max-w-[90%] flex-col gap-1 sm:max-w-[85%] ${isOperator ? "items-end" : "items-start"}`}>
                    
                    <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                      {isOperator ? (
                        <>
                          <span className="flex items-center gap-1"><User className="size-3" /> You</span>
                          <ArrowRight className="size-3 opacity-50" />
                          <span className="truncate max-w-[80px] sm:max-w-none">{targetName}</span>
                        </>
                      ) : (
                        <>
                          <span className="flex items-center gap-1"><Bot className="size-3 text-primary/70" /> {getAgentName(entry.senderAgentId)}</span>
                          <ArrowRight className="size-3 opacity-50" />
                          <span className="truncate max-w-[80px] sm:max-w-none">{targetName}</span>
                        </>
                      )}
                      <span className="mx-1 opacity-30">•</span>
                      <span>{new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>

                    <div
                      className={`relative break-words px-4 py-3 text-[13.5px] shadow-sm ${
                        isOperator
                          ? "rounded-2xl rounded-tr-sm bg-primary text-primary-foreground"
                          : "rounded-2xl rounded-tl-sm border border-border/50 bg-background text-foreground backdrop-blur-sm"
                      }`}
                    >
                      {/* Removed className prop from here, placed break-words on wrapper */}
                      <ReactMarkdown components={markdownComponents}>
                        {formatted.text}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} className="h-1 w-full" />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border/50 bg-background/80 p-3 backdrop-blur-md">
        <div className="relative flex items-center">
          <Input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={targetAgentId ? `Message ${getAgentName(targetAgentId)}...` : "Broadcast to swarm..."}
            className="h-12 w-full rounded-full border-border/50 bg-muted/20 pl-4 pr-14 text-sm transition-colors hover:bg-muted/40 focus-visible:ring-primary/30"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSend();
              }
            }}
          />
          <Button 
            size="icon" 
            onClick={handleSend} 
            disabled={!message.trim()}
            className="absolute right-1.5 size-9 shrink-0 rounded-full shadow-sm transition-transform disabled:scale-100 disabled:opacity-50 hover:scale-105 active:scale-95"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
