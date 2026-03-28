// SwarmConversationPanel.tsx
import { useMemo, useState, useRef, useEffect } from "react";
import { SWARM_OPERATOR_TARGET_ID, type SwarmState, type ThreadId } from "@t3tools/contracts";
import ReactMarkdown, { type Components } from "react-markdown";
import { Send, Bot, User, Users, ClipboardList, Radio, Terminal } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Card } from "../ui/card";
import { formatSwarmMessage } from "../../lib/swarmMessageFormatting";
import { getSwarmMessageRouteLabel } from "../../lib/swarmMessagePresentation";
import { cn } from "../../lib/utils";

export type SwarmConversationPanelProps = {
  threadId: ThreadId;
  swarm: SwarmState;
  onSend?: (text: string, targetAgentId: string | null) => Promise<void> | void;
};

const isThinkingMessage = (text: string) => {
  const trimmed = text.trimStart().toLowerCase();
  return (
    trimmed.startsWith("[thinking]") ||
    trimmed.startsWith("[reasoning]") ||
    trimmed.startsWith("[thoughts]")
  );
};

const ROLE_AVATAR_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  coordinator: { bg: "bg-zinc-800", text: "text-zinc-300", border: "border-zinc-600" },
  builder: { bg: "bg-zinc-800", text: "text-zinc-400", border: "border-zinc-600" },
  reviewer: { bg: "bg-red-950/60", text: "text-red-400", border: "border-red-800/50" },
  scout: { bg: "bg-emerald-950/60", text: "text-emerald-400", border: "border-emerald-800/50" },
  operator: { bg: "bg-blue-950/60", text: "text-blue-400", border: "border-blue-700/50" },
};

// ─── V1 (unchanged) ──────────────────────────────────────────────────────────

export function SwarmConversationPanelV1({ threadId, swarm, onSend }: SwarmConversationPanelProps) {
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
    () =>
      sortedMessages.filter((entry) => !entry.streaming && !isThinkingMessage(entry.text ?? "")),
    [sortedMessages],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleMessages]);

  const handleSend = () => {
    if (!message.trim() || !onSend) return;
    void onSend(message.trim(), targetAgentId);
    setMessage("");
  };

  const getAgentName = (id?: string | null) =>
    id === SWARM_OPERATOR_TARGET_ID
      ? "Operator"
      : id
        ? (agentOptions.find((a) => a.id === id)?.name ?? id)
        : "Agent";

  const markdownComponents: Components = {
    p: ({ node: _node, ...props }) => <p className="mb-2 leading-relaxed last:mb-0" {...props} />,
    ul: ({ node: _node, ...props }) => <ul className="mb-2 ml-4 list-disc space-y-1" {...props} />,
    ol: ({ node: _node, ...props }) => (
      <ol className="mb-2 ml-4 list-decimal space-y-1" {...props} />
    ),
    li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
    h1: ({ node: _node, ...props }) => <h1 className="mb-2 mt-4 text-lg font-bold" {...props} />,
    h2: ({ node: _node, ...props }) => <h2 className="mb-2 mt-4 text-base font-bold" {...props} />,
    h3: ({ node: _node, ...props }) => <h3 className="mb-2 mt-3 text-sm font-bold" {...props} />,
    a: ({ node: _node, ...props }) => (
      <a
        className="underline underline-offset-2 opacity-90 hover:opacity-100"
        target="_blank"
        rel="noreferrer"
        {...props}
      />
    ),
    blockquote: ({ node: _node, ...props }) => (
      <blockquote
        className="my-2 border-l-2 border-foreground/30 pl-3 italic opacity-80"
        {...props}
      />
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
            <code className={className} {...props}>
              {children}
            </code>
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
            <p className="truncate text-[11px] text-muted-foreground">
              Monitor and command your swarm
            </p>
          </div>
        </div>

        <div className="flex w-full shrink-0 items-center gap-2 2xl:w-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-8 flex-1 gap-1.5 border-primary/20 bg-background hover:bg-primary/5 hover:text-primary 2xl:flex-none"
            onClick={() => {
              if (!onSend) return;
              const prompt =
                "Give a concise swarm task status: active tasks, owners, owned files, dependencies, and current risks.";
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
                {targetAgentId ? (
                  <Bot className="size-3.5 shrink-0 text-primary" />
                ) : (
                  <Radio className="size-3.5 shrink-0 text-primary" />
                )}
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
              const senderName = isOperator ? "You" : getAgentName(entry.senderAgentId);
              const routeLabel = getSwarmMessageRouteLabel({
                sender: entry.sender,
                senderName,
                targetAgentId: formatted.targetAgentId,
                getAgentName: (id) => getAgentName(id),
              });

              return (
                <div
                  key={entry.id}
                  className={`flex w-full ${isOperator ? "justify-end" : "justify-start"} animate-in fade-in slide-in-from-bottom-2 duration-300`}
                >
                  <div
                    className={`flex max-w-[90%] flex-col gap-1 sm:max-w-[85%] ${isOperator ? "items-end" : "items-start"}`}
                  >
                    <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                      {isOperator ? (
                        <span className="flex items-center gap-1">
                          <User className="size-3" /> {routeLabel}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <Bot className="size-3 text-primary/70" /> {routeLabel}
                        </span>
                      )}
                      <span className="mx-1 opacity-30">•</span>
                      <span>
                        {new Date(entry.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>

                    <div
                      className={`relative break-words px-4 py-3 text-[13.5px] shadow-sm ${
                        isOperator
                          ? "rounded-2xl rounded-tr-sm bg-primary text-primary-foreground"
                          : "rounded-2xl rounded-tl-sm border border-border/50 bg-background text-foreground backdrop-blur-sm"
                      }`}
                    >
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
            placeholder={
              targetAgentId ? `Message ${getAgentName(targetAgentId)}...` : "Broadcast to swarm..."
            }
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

// ─── V2 markdown helpers ─────────────────────────────────────────────────────

function hasPreParent(node: any): boolean {
  if (!node) return false;
  let current = node;
  while (current) {
    if (current.tagName === "pre") return true;
    current = current.parent ?? current.parentNode;
  }
  return false;
}

function makeV2MarkdownComponents(textColorClass: string = "text-zinc-300"): Components {
  return {
    p: ({ ...props }) => <p className="mb-2 last:mb-0 leading-[1.6]" {...props} />,
    ul: ({ ...props }) => <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0" {...props} />,
    ol: ({ ...props }) => (
      <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0" {...props} />
    ),
    li: ({ ...props }) => <li className="pl-0.5 leading-[1.6]" {...props} />,
    h1: ({ ...props }) => <h1 className="mb-2 mt-3 text-[15px] font-bold first:mt-0" {...props} />,
    h2: ({ ...props }) => <h2 className="mb-2 mt-3 text-[14px] font-bold first:mt-0" {...props} />,
    h3: ({ ...props }) => (
      <h3 className="mb-1.5 mt-2.5 text-[13px] font-semibold first:mt-0" {...props} />
    ),
    a: ({ ...props }) => (
      <a
        className="underline underline-offset-2 opacity-80 hover:opacity-100"
        target="_blank"
        rel="noreferrer"
        {...props}
      />
    ),
    blockquote: ({ ...props }) => (
      <blockquote
        className="my-2 border-l-2 border-zinc-600 pl-3 italic text-zinc-400"
        {...props}
      />
    ),
    strong: ({ ...props }) => <strong className="font-semibold text-zinc-100" {...props} />,
    hr: () => <hr className="my-3 border-white/[0.06]" />,
    pre: ({ children, ...props }) => (
      <pre
        className="my-2 overflow-x-auto rounded-lg bg-[#000000]/40 p-3 font-mono text-[12px] text-zinc-400 border border-white/[0.04] last:mb-0"
        {...props}
      >
        {children}
      </pre>
    ),
    code: ({ node, className, children, ...props }: any) => {
      const hasLanguage = /language-(\w+)/.test(className || "");
      const isBlock = hasLanguage || hasPreParent(node);

      if (isBlock) {
        return (
          <code className={cn("font-mono", className)} {...props}>
            {children}
          </code>
        );
      }

      return (
        <code
          className={cn(
            "inline rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[12px] break-all",
            textColorClass,
          )}
          {...props}
        >
          {children}
        </code>
      );
    },
  };
}

// ─── V2 Chat View ────────────────────────────────────────────────────────────

export function SwarmConversationPanelV2({ threadId, swarm }: SwarmConversationPanelProps) {
  const sortedMessages = useMemo(
    () => swarm.messages.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [swarm.messages],
  );

  const visibleMessages = useMemo(
    () =>
      sortedMessages.filter(
        (entry) =>
          !entry.streaming &&
          !isThinkingMessage(entry.text ?? "") &&
          (entry.sender === "operator" || entry.targetAgentId !== null),
      ),
    [sortedMessages],
  );

  const getAgentName = (id?: string | null) => {
    if (id === SWARM_OPERATOR_TARGET_ID) return "Operator";
    return swarm.config.agents.find((a) => a.id === id)?.name ?? "Agent";
  };

  const getAgentRole = (id?: string | null): string => {
    if (!id) return "builder";
    return swarm.config.agents.find((a) => a.id === id)?.role ?? "builder";
  };

  const getRoleInitial = (name: string): string => {
    return name.charAt(0).toUpperCase();
  };

  const getAvatarStyle = (role: string) => {
    return ROLE_AVATAR_COLORS[role] ?? ROLE_AVATAR_COLORS.builder!;
  };

  type FormattedEntry = {
    entry: (typeof visibleMessages)[number];
    formatted: ReturnType<typeof formatSwarmMessage>;
  };
  type MessageGroup = {
    senderAgentId: string | null | undefined;
    sender: string;
    senderName: string;
    role: string;
    timestamp: string;
    items: FormattedEntry[];
  };

  const messageGroups = useMemo(() => {
    const groups: MessageGroup[] = [];

    for (const entry of visibleMessages) {
      const isOperator = entry.sender === "operator";
      const senderName = isOperator ? "You" : getAgentName(entry.senderAgentId);
      const role = isOperator ? "operator" : getAgentRole(entry.senderAgentId);
      const formatted = formatSwarmMessage(entry, swarm.config.agents, false);

      const lastGroup = groups[groups.length - 1];

      if (
        lastGroup &&
        lastGroup.senderAgentId === entry.senderAgentId &&
        lastGroup.sender === entry.sender
      ) {
        lastGroup.items.push({ entry, formatted });
      } else {
        groups.push({
          senderAgentId: entry.senderAgentId,
          sender: entry.sender,
          senderName,
          role,
          timestamp: entry.createdAt,
          items: [{ entry, formatted }],
        });
      }
    }
    return groups;
  }, [visibleMessages, swarm.config.agents]);

  const agentMarkdown = useMemo(() => makeV2MarkdownComponents("text-zinc-300"), []);
  const operatorMarkdown = useMemo(() => makeV2MarkdownComponents("text-zinc-200"), []);

  const groupHasOperatorTarget = (group: MessageGroup) =>
    group.items.some((item) => item.formatted.targetAgentId === SWARM_OPERATOR_TARGET_ID);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-[#0c0c11] px-5 pt-4 pb-32 scroll-smooth"
      data-thread-id={threadId}
    >
      {visibleMessages.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <span className="font-mono text-sm text-zinc-700">Awaiting messages...</span>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-5">
          {messageGroups.map((group, groupIdx) => {
            const isOperator = group.sender === "operator";
            return isOperator ? (
              <OperatorMessageGroup
                key={groupIdx}
                group={group}
                getAgentName={getAgentName}
                markdownComponents={operatorMarkdown}
              />
            ) : (
              <AgentMessageGroup
                key={groupIdx}
                group={group}
                getAgentName={getAgentName}
                getRoleInitial={getRoleInitial}
                getAvatarStyle={getAvatarStyle}
                markdownComponents={agentMarkdown}
                hasOperatorTarget={groupHasOperatorTarget(group)}
              />
            );
          })}
          <div className="h-8 w-full shrink-0" />
        </div>
      )}
    </div>
  );
}

// ─── Agent Message Group (left-aligned, full-width pills) ───────────────────

function AgentMessageGroup({
  group,
  getAgentName,
  getRoleInitial,
  getAvatarStyle,
  markdownComponents,
  hasOperatorTarget,
}: {
  group: {
    senderAgentId: string | null | undefined;
    senderName: string;
    role: string;
    timestamp: string;
    items: {
      entry: SwarmState["messages"][number];
      formatted: ReturnType<typeof formatSwarmMessage>;
    }[];
  };
  getAgentName: (id?: string | null) => string;
  getRoleInitial: (name: string) => string;
  getAvatarStyle: (role: string) => { bg: string; text: string; border: string };
  markdownComponents: Components;
  hasOperatorTarget: boolean;
}) {
  const avatarStyle = getAvatarStyle(group.role);
  const initial = getRoleInitial(group.senderName);
  const timeStr = new Date(group.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(() => new Set());
  const TEXT_TRUNCATE_LENGTH = 300;

  const toggleExpand = (id: string) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex w-full flex-col gap-1.5">
      {/* Header row */}
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            "flex size-[28px] shrink-0 items-center justify-center rounded-full border text-[11px] font-bold leading-none",
            avatarStyle.bg,
            avatarStyle.text,
            avatarStyle.border,
          )}
        >
          {initial}
        </div>

        <span className="text-[13px] font-semibold text-zinc-200">{group.senderName}</span>

        {hasOperatorTarget && (
          <span className="rounded-[3px] bg-yellow-500/15 border border-yellow-500/25 px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wider text-yellow-500 leading-tight">
            @YOU
          </span>
        )}

        <span className="rounded-[3px] bg-red-500/15 border border-red-500/25 px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wider text-red-500 leading-tight">
          ESC
        </span>

        <span className="text-[11px] font-mono text-zinc-600">{timeStr}</span>
      </div>

      {/* Full-width message pills */}
      <div className="flex w-full flex-col gap-2">
        {group.items.map(({ entry, formatted }) => {
          if (formatted.hideWhenNotRaw) return null;

          const targetName = formatted.targetAgentId ? getAgentName(formatted.targetAgentId) : null;
          const isToOperator = formatted.targetAgentId === SWARM_OPERATOR_TARGET_ID;
          const isLong = formatted.text.length > TEXT_TRUNCATE_LENGTH;
          const isExpanded = expandedMessages.has(entry.id);
          const displayText =
            isLong && !isExpanded ? formatted.text.slice(0, TEXT_TRUNCATE_LENGTH) : formatted.text;

          return (
            <div key={entry.id} className="flex w-full flex-col">
              <div
                className={cn(
                  "w-full rounded-xl px-4 py-3 text-[13px] text-zinc-300 leading-[1.6]",
                  isToOperator
                    ? "border-l-2 border-yellow-500/40 border-y border-r border-y-white/[0.04] border-r-white/[0.04] bg-[#141310]"
                    : "border border-white/[0.04] bg-[#131318]",
                )}
              >
                <ReactMarkdown components={markdownComponents}>{displayText}</ReactMarkdown>
                {isLong && (
                  <button
                    onClick={() => toggleExpand(entry.id)}
                    className="ml-1 inline text-[12px] font-medium text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {isExpanded ? "less" : "... more"}
                  </button>
                )}
                {/* Target label inside the bubble */}
                {targetName && (
                  <div
                    className={cn(
                      "mt-1.5 text-[11px] font-medium",
                      isToOperator ? "text-yellow-600/50" : "text-zinc-600",
                    )}
                  >
                    → {targetName}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Operator Message Group (right-aligned, gradient bubble) ─────────────────

function OperatorMessageGroup({
  group,
  getAgentName,
  markdownComponents,
}: {
  group: {
    senderAgentId: string | null | undefined;
    senderName: string;
    role: string;
    timestamp: string;
    items: {
      entry: SwarmState["messages"][number];
      formatted: ReturnType<typeof formatSwarmMessage>;
    }[];
  };
  getAgentName: (id?: string | null) => string;
  markdownComponents: Components;
}) {
  const timeStr = new Date(group.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(() => new Set());
  const TEXT_TRUNCATE_LENGTH = 300;

  const toggleExpand = (id: string) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex w-full flex-col items-end gap-1.5">
      {/* Header: timestamp + "You" right-aligned */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-mono text-zinc-600">{timeStr}</span>
        <span className="text-[13px] font-semibold text-zinc-200">You</span>
      </div>

      {/* Message bubbles right-aligned */}
      <div className="flex w-full flex-col items-end gap-2">
        {group.items.map(({ entry, formatted }) => {
          if (formatted.hideWhenNotRaw) return null;

          const targetName = formatted.targetAgentId ? getAgentName(formatted.targetAgentId) : null;
          const isLong = formatted.text.length > TEXT_TRUNCATE_LENGTH;
          const isExpanded = expandedMessages.has(entry.id);
          const displayText =
            isLong && !isExpanded ? formatted.text.slice(0, TEXT_TRUNCATE_LENGTH) : formatted.text;

          return (
            <div key={entry.id} className="flex max-w-[75%] flex-col items-end">
              <div
                className="v2-operator-bubble rounded-xl border border-white/[0.06] px-4 py-3 text-[13px] text-zinc-200 leading-[1.6]"
                style={{
                  background:
                    "linear-gradient(to left, #18181d 0%, #1e1e24 35%, #252528 70%, #2a2a2e 100%)",
                }}
              >
                <ReactMarkdown components={markdownComponents}>{displayText}</ReactMarkdown>
                {isLong && (
                  <button
                    onClick={() => toggleExpand(entry.id)}
                    className="ml-1 inline text-[12px] font-medium text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {isExpanded ? "less" : "... more"}
                  </button>
                )}
                {/* Target label inside the bubble */}
                {targetName && (
                  <div className="mt-1.5 text-[11px] font-medium text-zinc-500">
                    to {targetName}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { SwarmConversationPanelV1 as SwarmConversationPanel };
