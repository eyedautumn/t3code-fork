import { SWARM_OPERATOR_TARGET_ID, type SwarmAgent } from "@t3tools/contracts";

import { normalizeSwarmTargetToken } from "./swarmMessaging.ts";

export type ResolvedSwarmTarget = {
  targetAgentId: string | null;
  toOperator: boolean;
};

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const next = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = 0; i < left.length; i += 1) {
    next[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1;
      const insertCost = (next[j] ?? 0) + 1;
      const deleteCost = (previous[j + 1] ?? 0) + 1;
      const replaceCost = (previous[j] ?? 0) + cost;
      next[j + 1] = Math.min(insertCost, deleteCost, replaceCost);
    }
    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = next[j] ?? 0;
    }
  }
  return previous[right.length] ?? Number.MAX_SAFE_INTEGER;
}

function normalizeAliasTarget(normalized: string): string {
  switch (normalized) {
    case "coord":
    case "cord":
    case "cordinator":
    case "coordinator":
    case "lead":
    case "manager":
    case "teamlead":
      return "coordinator";
    default:
      return normalized;
  }
}

function splitTargetTokens(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function resolveSwarmTarget(
  agents: ReadonlyArray<SwarmAgent>,
  targetRaw: string | null | undefined,
): ResolvedSwarmTarget {
  if (!targetRaw) return { targetAgentId: null, toOperator: false };
  const normalized = normalizeSwarmTargetToken(targetRaw).toLowerCase();
  if (!normalized) return { targetAgentId: null, toOperator: false };
  if (normalized === "operator" || normalized === "you" || normalized === "human") {
    return { targetAgentId: SWARM_OPERATOR_TARGET_ID, toOperator: true };
  }

  const exact = agents.find(
    (agent) =>
      agent.id.toLowerCase() === normalized ||
      agent.name.toLowerCase() === normalized ||
      agent.role.toLowerCase() === normalized,
  );
  if (exact) return { targetAgentId: exact.id, toOperator: false };

  const aliasTarget = normalizeAliasTarget(normalized);
  const prefix = agents.find(
    (agent) =>
      agent.id.toLowerCase().startsWith(aliasTarget) ||
      agent.name.toLowerCase().startsWith(aliasTarget) ||
      agent.role.toLowerCase().startsWith(aliasTarget),
  );
  if (prefix) return { targetAgentId: prefix.id, toOperator: false };

  const targetTokens = splitTargetTokens(aliasTarget);
  if (targetTokens.length > 0) {
    const scoredByTokens = agents
      .map((agent) => {
        const aliases = [
          agent.id.toLowerCase(),
          agent.name.toLowerCase(),
          agent.role.toLowerCase(),
        ];
        const score = aliases.reduce((best, alias) => {
          const aliasTokens = splitTargetTokens(alias);
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
