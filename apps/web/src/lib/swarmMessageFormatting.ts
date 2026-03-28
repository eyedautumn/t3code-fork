import { SWARM_OPERATOR_TARGET_ID, type SwarmAgent, type SwarmMessage } from "@t3tools/contracts";
import { normalizeSwarmTargetToken, parseSwarmMessage } from "@t3tools/shared/swarmMessaging";

type ResolvedTarget = {
  targetAgentId: string | null;
  toOperator: boolean;
};

const LEADING_SWARM_MESSAGE_REGEXES = [
  /^\s*\[\[swarm\.message(?:\s+target=[^\]]+)?\]\]\s*/i,
  /^\s*\[swarm\.message\s+[^\]]+\]\s*/i,
  /^\s*\[\[message_swarm(?:\s+target=[^\]]+)?\]\]\s*/i,
  /^\s*\[message_swarm\s+[^\]]+\]\s*/i,
];
const SWARM_MESSAGE_CLOSE_REGEX = /\[swarm\.message_close\]\s*/gi;
const MESSAGE_SWARM_CLOSE_REGEX = /\[message_swarm_close\]\s*/gi;

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

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  const prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  const next = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = 0; i < left.length; i += 1) {
    next[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1;
      const insertCost = (next[j] ?? 0) + 1;
      const deleteCost = (prev[j + 1] ?? 0) + 1;
      const replaceCost = (prev[j] ?? 0) + cost;
      next[j + 1] = Math.min(insertCost, deleteCost, replaceCost);
    }
    for (let j = 0; j <= right.length; j += 1) {
      prev[j] = next[j] ?? 0;
    }
  }
  return prev[right.length] ?? Number.MAX_SAFE_INTEGER;
}

export type FormattedSwarmMessage = {
  text: string;
  targetAgentId: string | null;
  isDirective: boolean;
  hideWhenNotRaw: boolean;
};

function normalizeTargetToken(raw: string): string {
  return normalizeSwarmTargetToken(raw);
}

function resolveTarget(
  agents: ReadonlyArray<SwarmAgent>,
  targetRaw: string | null,
): ResolvedTarget {
  if (!targetRaw) return { targetAgentId: null, toOperator: false };
  const normalized = normalizeTargetToken(targetRaw).toLowerCase();
  if (!normalized) return { targetAgentId: null, toOperator: false };
  if (normalized === "operator" || normalized === "you") {
    return { targetAgentId: SWARM_OPERATOR_TARGET_ID, toOperator: true };
  }
  const byId = agents.find((agent) => agent.id.toLowerCase() === normalized);
  if (byId) return { targetAgentId: byId.id, toOperator: false };
  const byName = agents.find((agent) => agent.name.toLowerCase() === normalized);
  if (byName) return { targetAgentId: byName.id, toOperator: false };
  const byRole = agents.find((agent) => agent.role.toLowerCase() === normalized);
  if (byRole) return { targetAgentId: byRole.id, toOperator: false };
  const aliasTarget =
    normalized === "coord" ||
    normalized === "lead" ||
    normalized === "manager" ||
    normalized === "teamlead"
      ? "coordinator"
      : normalized;
  const targetTokens = aliasTarget
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const prefix = agents.find(
    (agent) =>
      agent.id.toLowerCase().startsWith(aliasTarget) ||
      agent.name.toLowerCase().startsWith(aliasTarget) ||
      agent.role.toLowerCase().startsWith(aliasTarget),
  );
  if (prefix) return { targetAgentId: prefix.id, toOperator: false };
  if (targetTokens.length > 0) {
    const scoredByTokens = agents
      .map((agent) => {
        const aliases = [
          agent.id.toLowerCase(),
          agent.name.toLowerCase(),
          agent.role.toLowerCase(),
        ];
        const score = aliases.reduce((best, alias) => {
          const aliasTokens = alias
            .split(/[^a-z0-9]+/i)
            .map((token) => token.trim())
            .filter((token) => token.length > 0);
          const exactTokenHits = targetTokens.filter((token) => aliasTokens.includes(token)).length;
          const partialTokenHits = targetTokens.filter((token) =>
            aliasTokens.some(
              (aliasToken) => aliasToken.includes(token) || token.includes(aliasToken),
            ),
          ).length;
          return Math.max(best, exactTokenHits * 10 + partialTokenHits);
        }, 0);
        return { id: agent.id, score };
      })
      .filter((entry) => entry.score > 0)
      .toSorted((left, right) => right.score - left.score);
    const best = scoredByTokens[0];
    if (best) {
      return { targetAgentId: best.id, toOperator: false };
    }
  }
  const scored = agents
    .map((agent) => ({
      id: agent.id,
      score: Math.min(
        levenshteinDistance(aliasTarget, agent.id.toLowerCase()),
        levenshteinDistance(aliasTarget, agent.name.toLowerCase()),
        levenshteinDistance(aliasTarget, agent.role.toLowerCase()),
      ),
    }))
    .toSorted((left, right) => left.score - right.score);
  const best = scored[0];
  if (best && best.score <= 3) {
    return { targetAgentId: best.id, toOperator: false };
  }
  return { targetAgentId: null, toOperator: false };
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

  const parsed = parseSwarmMessage(text);
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
    const target = resolveTarget(agents, firstDirective.targetRaw);
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
