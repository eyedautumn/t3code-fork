const SWARM_MESSAGE_TOOL_REGEX =
  /\[\[swarm\.message(?:\s+target=(?<targetBracket>[^\]]+))?\]\]\s*/i;
const SWARM_MESSAGE_BRACKET_REGEX = /\[swarm\.message\s+(?<targetSquare>[^\]]+)\]\s*/i;
const SWARM_MESSAGE_BRACKET_REGEX_NO_BRACKET =
  /swarm\.message\s+(?<targetSquareNoBracket>[^\]]+)\]\s*/i;
const SWARM_MESSAGE_CLOSE_REGEX = /\[swarm\.message_close\]\s*/i;
const SWARM_MESSAGE_CLOSE_REGEX_NO_BRACKET = /swarm\.message_close\]\s*/i;
const MESSAGE_SWARM_TOOL_REGEX =
  /\[\[message_swarm(?:\s+target=(?<targetBracketAlias>[^\]]+))?\]\]\s*/i;
const MESSAGE_SWARM_BRACKET_REGEX = /\[message_swarm\s+(?<targetSquareAlias>[^\]]+)\]\s*/i;
const MESSAGE_SWARM_BRACKET_REGEX_NO_BRACKET =
  /message_swarm\s+(?<targetSquareAliasNoBracket>[^\]]+)\]\s*/i;
const MESSAGE_SWARM_CLOSE_REGEX = /\[message_swarm_close\]\s*/i;
const MESSAGE_SWARM_CLOSE_REGEX_NO_BRACKET = /message_swarm_close\]\s*/i;
const MESSAGE_SWARM_FUNCTION_REGEX =
  /send_message_swarm\(\s*(?<targetFunction>(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,)]+?))\s*,\s*(?<bodyFunction>[\s\S]*?)\s*\)/i;

export type ParsedSwarmDirective = {
  targetRaw: string;
  body: string;
  rawText: string;
};

export type ParsedSwarmMessage = {
  directives: ParsedSwarmDirective[];
  publicText: string;
  hasCloseToken: boolean;
};

type SwarmControlMatch =
  | {
      kind: "directive";
      index: number;
      length: number;
      targetRaw: string;
      bodyFromFunction: string | null;
      rawText: string;
    }
  | {
      kind: "close";
      index: number;
      length: number;
      rawText: string;
    };

export function normalizeSwarmTargetToken(raw: string): string {
  let token = raw.trim();
  token = token.replace(/^target\s*=\s*/i, "");
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  return token.replace(/^[^\p{L}\p{N}_:-]+|[^\p{L}\p{N}_:-]+$/gu, "");
}

function findNextSwarmControl(text: string, fromIndex: number): SwarmControlMatch | null {
  const closeMatch = (() => {
    SWARM_MESSAGE_CLOSE_REGEX.lastIndex = 0;
    SWARM_MESSAGE_CLOSE_REGEX_NO_BRACKET.lastIndex = 0;
    MESSAGE_SWARM_CLOSE_REGEX.lastIndex = 0;
    MESSAGE_SWARM_CLOSE_REGEX_NO_BRACKET.lastIndex = 0;
    const direct = SWARM_MESSAGE_CLOSE_REGEX.exec(text.slice(fromIndex));
    const directNoBracket = SWARM_MESSAGE_CLOSE_REGEX_NO_BRACKET.exec(text.slice(fromIndex));
    const alias = MESSAGE_SWARM_CLOSE_REGEX.exec(text.slice(fromIndex));
    const aliasNoBracket = MESSAGE_SWARM_CLOSE_REGEX_NO_BRACKET.exec(text.slice(fromIndex));
    const matches = [direct, directNoBracket, alias, aliasNoBracket].filter(
      Boolean,
    ) as RegExpExecArray[];
    if (matches.length === 0) return null;
    const winner = matches.reduce((a, b) => (a.index <= b.index ? a : b));
    return {
      kind: "close" as const,
      index: fromIndex + winner.index,
      length: winner[0].length,
      rawText: winner[0],
    };
  })();

  const directiveMatches = [
    SWARM_MESSAGE_TOOL_REGEX,
    SWARM_MESSAGE_BRACKET_REGEX,
    SWARM_MESSAGE_BRACKET_REGEX_NO_BRACKET,
    MESSAGE_SWARM_TOOL_REGEX,
    MESSAGE_SWARM_BRACKET_REGEX,
    MESSAGE_SWARM_BRACKET_REGEX_NO_BRACKET,
    MESSAGE_SWARM_FUNCTION_REGEX,
  ]
    .map((regex) => {
      regex.lastIndex = 0;
      const match = regex.exec(text.slice(fromIndex));
      if (!match) return null;
      const targetRaw = (
        match.groups?.targetBracket ??
        match.groups?.targetSquare ??
        match.groups?.targetSquareNoBracket ??
        match.groups?.targetBracketAlias ??
        match.groups?.targetSquareAlias ??
        match.groups?.targetSquareAliasNoBracket ??
        match.groups?.targetFunction ??
        ""
      ).trim();
      return {
        kind: "directive" as const,
        index: fromIndex + match.index,
        length: match[0].length,
        targetRaw,
        bodyFromFunction: match.groups?.bodyFunction?.trim() ?? null,
        rawText: match[0],
      };
    })
    .filter((entry): entry is Exclude<typeof entry, null> => entry !== null)
    .toSorted((left, right) => left.index - right.index);

  const directiveMatch = directiveMatches[0] ?? null;
  if (!closeMatch) return directiveMatch;
  if (!directiveMatch) return closeMatch;
  return closeMatch.index <= directiveMatch.index ? closeMatch : directiveMatch;
}

function findNextDirectiveBoundary(text: string, fromIndex: number): SwarmControlMatch | null {
  let cursor = fromIndex;
  while (cursor < text.length) {
    const next = findNextSwarmControl(text, cursor);
    if (!next) {
      return null;
    }
    if (next.kind === "close") {
      return next;
    }
    const normalizedTarget = normalizeSwarmTargetToken(next.targetRaw);
    if (normalizedTarget.length > 0) {
      return next;
    }
    // Treat invalid directive-shaped tokens as plain text inside the body.
    cursor = next.index + next.length;
  }
  return null;
}

export function parseSwarmMessage(text: string): ParsedSwarmMessage {
  const directives: ParsedSwarmDirective[] = [];
  const publicChunks: string[] = [];
  let cursor = 0;
  let hasCloseToken = false;

  while (cursor < text.length) {
    const match = findNextSwarmControl(text, cursor);
    if (!match) {
      publicChunks.push(text.slice(cursor));
      break;
    }

    if (match.index > cursor) {
      publicChunks.push(text.slice(cursor, match.index));
    }

    if (match.kind === "close") {
      hasCloseToken = true;
      cursor = match.index + match.length;
      continue;
    }

    const normalizedTarget = normalizeSwarmTargetToken(match.targetRaw);
    if (!normalizedTarget) {
      publicChunks.push(match.rawText);
      cursor = match.index + match.length;
      continue;
    }

    if (match.bodyFromFunction && match.bodyFromFunction.length > 0) {
      directives.push({
        targetRaw: normalizedTarget,
        body: match.bodyFromFunction,
        rawText: match.rawText,
      });
      cursor = match.index + match.length;
      continue;
    }

    const bodyStart = match.index + match.length;
    const nextControl = findNextDirectiveBoundary(text, bodyStart);
    const bodyEnd = nextControl?.index ?? text.length;
    const rawBody = text.slice(bodyStart, bodyEnd);
    const body = rawBody.trim();
    if (!body) {
      publicChunks.push(match.rawText);
      cursor = bodyStart;
      continue;
    }

    directives.push({
      targetRaw: normalizedTarget,
      body,
      rawText: `${match.rawText}${rawBody}`,
    });
    cursor = bodyEnd;
  }

  return {
    directives,
    publicText: publicChunks.join("").trim(),
    hasCloseToken,
  };
}
