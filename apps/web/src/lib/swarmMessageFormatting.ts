import { SWARM_OPERATOR_TARGET_ID, type SwarmAgent, type SwarmMessage } from "@t3tools/contracts";

const SWARM_MESSAGE_DOUBLE_REGEX =
  /\[\[swarm\.message(?:\s+target=(?<targetDouble>[^\]]+))?\]\]\s*(?<bodyDouble>[\s\S]*)$/i;
const SWARM_MESSAGE_SINGLE_REGEX =
  /\[swarm\.message\s+(?<targetSingle>[^\]]+)\]\s*(?<bodySingle>[\s\S]*)$/i;
const MESSAGE_SWARM_DOUBLE_REGEX =
  /\[\[message_swarm(?:\s+target=(?<targetDoubleAlias>[^\]]+))?\]\]\s*(?<bodyDoubleAlias>[\s\S]*)$/i;
const MESSAGE_SWARM_SINGLE_REGEX =
  /\[message_swarm\s+(?<targetSingleAlias>[^\]]+)\]\s*(?<bodySingleAlias>[\s\S]*)$/i;
const MESSAGE_SWARM_FUNCTION_REGEX =
  /send_message_swarm\(\s*(?<targetFunction>(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,)]+?))\s*,\s*(?<bodyFunction>[\s\S]*?)\s*\)$/i;
const SWARM_MESSAGE_CLOSE_REGEX = /\[swarm\.message_close\]\s*/i;
const MESSAGE_SWARM_CLOSE_REGEX = /\[message_swarm_close\]\s*/i;

type ResolvedTarget = {
  targetAgentId: string | null;
  toOperator: boolean;
};

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
  const trimmed = raw.trim();
  let token = trimmed;
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  return token.replace(/^[^\p{L}\p{N}_:-]+|[^\p{L}\p{N}_:-]+$/gu, "");
}

function resolveTarget(agents: ReadonlyArray<SwarmAgent>, targetRaw: string | null): ResolvedTarget {
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
        const aliases = [agent.id.toLowerCase(), agent.name.toLowerCase(), agent.role.toLowerCase()];
        const score = aliases.reduce((best, alias) => {
          const aliasTokens = alias
            .split(/[^a-z0-9]+/i)
            .map((token) => token.trim())
            .filter((token) => token.length > 0);
          const exactTokenHits = targetTokens.filter((token) => aliasTokens.includes(token)).length;
          const partialTokenHits = targetTokens.filter((token) =>
            aliasTokens.some((aliasToken) => aliasToken.includes(token) || token.includes(aliasToken)),
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

  const closeMatch = SWARM_MESSAGE_CLOSE_REGEX.exec(text);
  const closeAliasMatch = MESSAGE_SWARM_CLOSE_REGEX.exec(text);
  const closeToken = (() => {
    if (closeMatch && closeAliasMatch) {
      return closeMatch.index <= closeAliasMatch.index ? closeMatch : closeAliasMatch;
    }
    return closeMatch ?? closeAliasMatch;
  })();

  const doubleMatch = SWARM_MESSAGE_DOUBLE_REGEX.exec(text);
  const singleMatch = SWARM_MESSAGE_SINGLE_REGEX.exec(text);
  const doubleAliasMatch = MESSAGE_SWARM_DOUBLE_REGEX.exec(text);
  const singleAliasMatch = MESSAGE_SWARM_SINGLE_REGEX.exec(text);
  const functionMatch = MESSAGE_SWARM_FUNCTION_REGEX.exec(text);
  const match = (() => {
    const allMatches = [doubleMatch, singleMatch, doubleAliasMatch, singleAliasMatch, functionMatch].filter(
      (candidate): candidate is RegExpExecArray => candidate !== null,
    );
    if (allMatches.length === 0) {
      return null;
    }
    return allMatches.reduce((earliest, candidate) =>
      candidate.index < earliest.index ? candidate : earliest,
    );
  })();

  if (closeToken && (!match || closeToken.index < match.index)) {
    return {
      text: "",
      targetAgentId: message.targetAgentId,
      isDirective: true,
      hideWhenNotRaw: true,
    };
  }
  const targetRaw = (
    match?.groups?.targetDouble ??
    match?.groups?.targetSingle ??
    match?.groups?.targetDoubleAlias ??
    match?.groups?.targetSingleAlias ??
    match?.groups?.targetFunction ??
    null
  )?.trim() ?? null;
  const body = (
    match?.groups?.bodyDouble ??
    match?.groups?.bodySingle ??
    match?.groups?.bodyDoubleAlias ??
    match?.groups?.bodySingleAlias ??
    match?.groups?.bodyFunction ??
    null
  )?.trim() ?? null;
  const rawBody = body ?? "";
  const closeIndex = (() => {
    if (rawBody.length === 0) return -1;
    const closeIndices = [SWARM_MESSAGE_CLOSE_REGEX.exec(rawBody)?.index, MESSAGE_SWARM_CLOSE_REGEX.exec(rawBody)?.index]
      .filter((index): index is number => index !== undefined);
    if (closeIndices.length === 0) {
      return -1;
    }
    return Math.min(...closeIndices);
  })();
  const normalizedBody = closeIndex >= 0 ? rawBody.slice(0, closeIndex).trim() : rawBody;

  if (normalizedBody && normalizedBody.length > 0 && match) {
    const target = resolveTarget(agents, targetRaw);
    return {
      text: normalizedBody,
      targetAgentId: target.targetAgentId ?? targetRaw ?? message.targetAgentId,
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
