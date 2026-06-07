import { type SwarmAgent, type SwarmMessage } from "@t3tools/contracts";
import { parseSwarmMessage } from "@t3tools/shared/swarmMessaging";
import { resolveSwarmTarget } from "@t3tools/shared/swarmTargets";

const LEADING_SWARM_MESSAGE_REGEXES = [
  /^\s*\[\[swarm\.message(?:\s+target=[^\]]+)?\]\]\s*/i,
  /^\s*\[swarm\.message\s+[^\]]+\]\s*/i,
  /^\s*\[\[message_swarm(?:\s+target=[^\]]+)?\]\]\s*/i,
  /^\s*\[message_swarm\s+[^\]]+\]\s*/i,
];
const SWARM_MESSAGE_CLOSE_REGEX = /\[swarm\.message_close\]\s*/gi;
const MESSAGE_SWARM_CLOSE_REGEX = /\[message_swarm_close\]\s*/gi;
const SWARM_DIRECTIVE_TRIGGER_REGEX =
  /\[\s*(?:swarm\.message(?:_close)?|message_swarm(?:_close)?)/i;
const PARSED_SWARM_MESSAGE_CACHE_LIMIT = 250;
const parsedMessageCache = new Map<string, ReturnType<typeof parseSwarmMessage>>();

function hasSwarmDirectiveHint(text: string): boolean {
  if (!text.includes("[")) return false;
  return SWARM_DIRECTIVE_TRIGGER_REGEX.test(text);
}

function getParsedSwarmMessage(text: string): ReturnType<typeof parseSwarmMessage> {
  const cached = parsedMessageCache.get(text);
  if (cached) {
    parsedMessageCache.delete(text);
    parsedMessageCache.set(text, cached);
    return cached;
  }
  const parsed = parseSwarmMessage(text);
  parsedMessageCache.set(text, parsed);
  if (parsedMessageCache.size > PARSED_SWARM_MESSAGE_CACHE_LIMIT) {
    const oldestKey = parsedMessageCache.keys().next().value as string | undefined;
    if (oldestKey) {
      parsedMessageCache.delete(oldestKey);
    }
  }
  return parsed;
}

function stripLeadingDirective(text: string): string {
  let result = text;
  for (const regex of LEADING_SWARM_MESSAGE_REGEXES) {
    const match = regex.exec(result);
    if (match) {
      result = result.slice(match[0].length);
      break;
    }
  }
  return result
    .replace(SWARM_MESSAGE_CLOSE_REGEX, "")
    .replace(MESSAGE_SWARM_CLOSE_REGEX, "")
    .trim();
}

export type FormattedSwarmMessage = {
  text: string;
  targetAgentId: string | null;
  isDirective: boolean;
  hideWhenNotRaw: boolean;
};

export function isRoutedSwarmMessage(message: Pick<SwarmMessage, "targetAgentId">): boolean {
  return message.targetAgentId != null;
}

export function isBackgroundSwarmNotice(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("Swarm agent ") ||
    trimmed.startsWith("Failed to start swarm agent ") ||
    trimmed.startsWith("Failed to send swarm prompt ") ||
    trimmed.startsWith("Unresolved swarm target ") ||
    trimmed.startsWith("Swarm is already running.")
  );
}

export function isThinkingMessage(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  return (
    trimmed.startsWith("[thinking]") ||
    trimmed.startsWith("[reasoning]") ||
    trimmed.startsWith("[thoughts]")
  );
}

export function formatSwarmMessage(
  message: SwarmMessage,
  agents: ReadonlyArray<SwarmAgent>,
  showRawDirective: boolean,
): FormattedSwarmMessage {
  const text = message.text ?? "";
  if (showRawDirective || message.sender !== "agent") {
    return {
      text,
      targetAgentId: message.targetAgentId,
      isDirective: false,
      hideWhenNotRaw: false,
    };
  }

  if (message.sender === "agent" && message.targetAgentId !== null) {
    const stripped = stripLeadingDirective(text);
    const isDirective = stripped !== text;
    return {
      text: stripped.length > 0 ? stripped : text,
      targetAgentId: message.targetAgentId,
      isDirective,
      hideWhenNotRaw: false,
    };
  }

  if (!hasSwarmDirectiveHint(text)) {
    return {
      text,
      targetAgentId: message.targetAgentId,
      isDirective: false,
      hideWhenNotRaw: false,
    };
  }

  const parsed = getParsedSwarmMessage(text);
  if (parsed.directives.length === 0 && parsed.hasCloseToken && parsed.publicText.length === 0) {
    return {
      text: "",
      targetAgentId: message.targetAgentId,
      isDirective: true,
      hideWhenNotRaw: true,
    };
  }

  if (message.targetAgentId === null && parsed.directives.length > 0) {
    return {
      text,
      targetAgentId: message.targetAgentId,
      isDirective: false,
      hideWhenNotRaw: false,
    };
  }

  // If the backend already set a concrete routing target, trust that routing and
  // avoid showing a UI-truncated body when parsing ambiguously embedded markers
  // (e.g. prose that references "[swarm.message ...]").
  if (message.targetAgentId !== null && parsed.directives.length > 0) {
    const firstDirective = parsed.directives[0];
    const parsedBody = firstDirective?.body ?? "";
    const directiveMarkerCount = (text.match(/\[swarm\.message(?!_close)/gi) ?? []).length;
    const likelyTruncated =
      parsed.publicText.length === 0 &&
      directiveMarkerCount > 1 &&
      parsedBody.length > 0 &&
      parsedBody.length < Math.max(32, Math.floor(text.length * 0.4));
    if (likelyTruncated) {
      return {
        text,
        targetAgentId: message.targetAgentId,
        isDirective: false,
        hideWhenNotRaw: false,
      };
    }
  }

  if (parsed.publicText.length > 0) {
    return {
      text: parsed.publicText,
      targetAgentId: message.targetAgentId,
      isDirective: parsed.directives.length > 0,
      hideWhenNotRaw: false,
    };
  }

  const firstDirective = parsed.directives[0];
  if (firstDirective) {
    const target = resolveSwarmTarget(agents, firstDirective.targetRaw);
    return {
      text: firstDirective.body,
      targetAgentId: target.targetAgentId ?? firstDirective.targetRaw ?? message.targetAgentId,
      isDirective: true,
      hideWhenNotRaw: false,
    };
  }

  return {
    text,
    targetAgentId: message.targetAgentId,
    isDirective: false,
    hideWhenNotRaw: false,
  };
}
