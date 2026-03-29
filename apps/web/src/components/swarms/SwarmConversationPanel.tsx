// SwarmConversationPanel.tsx
import { useCallback, useMemo, useState } from "react";
import {
  SWARM_OPERATOR_TARGET_ID,
  type SwarmAgentRole,
  type SwarmState,
  type ThreadId,
} from "@t3tools/contracts";
import ReactMarkdown, { type Components } from "react-markdown";

import { formatSwarmMessage } from "../../lib/swarmMessageFormatting";
import { cn } from "../../lib/utils";
import { ROLE_COLORS, colorWithAlpha } from "./swarmRoleColors";

export type SwarmConversationPanelProps = {
  threadId: ThreadId;
  swarm: SwarmState;
};

const isThinkingMessage = (text: string) => {
  const trimmed = text.trimStart().toLowerCase();
  return (
    trimmed.startsWith("[thinking]") ||
    trimmed.startsWith("[reasoning]") ||
    trimmed.startsWith("[thoughts]")
  );
};

const OPERATOR_ACCENT = "#0f172a";
const OPERATOR_TEXT = "#60a5fa";
const OPERATOR_AVATAR_STYLE = {
  backgroundColor: colorWithAlpha(OPERATOR_ACCENT, 0.6),
  color: OPERATOR_TEXT,
  borderColor: colorWithAlpha(OPERATOR_ACCENT, 0.45),
};

const getRoleInitial = (name: string): string => name.charAt(0).toUpperCase();

const getAvatarStyle = (role: string) => {
  if (role === "operator") return OPERATOR_AVATAR_STYLE;
  const typedRole = role as SwarmAgentRole;
  const normalizedRole = ROLE_COLORS[typedRole] ? typedRole : "builder";
  const fill = ROLE_COLORS[normalizedRole];
  return {
    backgroundColor: colorWithAlpha(fill, 0.15),
    color: fill,
    borderColor: colorWithAlpha(fill, 0.45),
  };
};

function makeV2MarkdownComponents(textClass: string): Components {
  return {
    p: ({ node: _node, ...props }) => (
      <p className={cn("mb-2 leading-relaxed last:mb-0", textClass)} {...props} />
    ),
    ul: ({ node: _node, ...props }) => (
      <ul className={cn("mb-2 ml-4 list-disc space-y-1", textClass)} {...props} />
    ),
    ol: ({ node: _node, ...props }) => (
      <ol className={cn("mb-2 ml-4 list-decimal space-y-1", textClass)} {...props} />
    ),
    li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
    code: ({ node: _node, className, children, ...props }) => (
      <code
        className={cn(
          "rounded border border-white/[0.08] bg-white/[0.03] px-1 py-0.5 text-xs font-mono",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    ),
    pre: ({ node: _node, className, children, ...props }) => (
      <pre
        className={cn(
          "rounded-md border border-white/[0.08] bg-white/[0.03] p-3 text-xs font-mono",
          className,
        )}
        {...props}
      >
        {children}
      </pre>
    ),
  };
}

export function SwarmConversationPanel({ threadId, swarm }: SwarmConversationPanelProps) {
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

  const getAgentName = useCallback(
    (id?: string | null) => {
      if (id === SWARM_OPERATOR_TARGET_ID) return "Operator";
      return swarm.config.agents.find((a) => a.id === id)?.name ?? "Agent";
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
  }, [getAgentName, getAgentRole, visibleMessages, swarm.config.agents]);

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
          {messageGroups.map((group) => {
            const groupKey = `${group.sender}:${group.senderAgentId ?? "none"}:${group.timestamp}`;
            const isOperator = group.sender === "operator";
            return isOperator ? (
              <OperatorMessageGroup
                key={groupKey}
                group={group}
                getAgentName={getAgentName}
                markdownComponents={operatorMarkdown}
              />
            ) : (
              <AgentMessageGroup
                key={groupKey}
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
  getAvatarStyle: (role: string) => {
    backgroundColor: string;
    borderColor: string;
    color: string;
  };
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
          className="flex size-[28px] shrink-0 items-center justify-center rounded-full border text-[11px] font-bold leading-none"
          style={{
            backgroundColor: avatarStyle.backgroundColor,
            color: avatarStyle.color,
            borderColor: avatarStyle.borderColor,
          }}
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
