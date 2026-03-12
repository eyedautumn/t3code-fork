import { ThreadId } from "@t3tools/contracts";

const SWARM_SESSION_PREFIX = "swarm:";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function encodeSwarmSessionThreadId(threadId: ThreadId, agentId: string): ThreadId {
  const threadPart = encodeBase64Url(threadId);
  const agentPart = encodeBase64Url(agentId);
  return ThreadId.makeUnsafe(`${SWARM_SESSION_PREFIX}${threadPart}:${agentPart}`);
}

export function decodeSwarmSessionThreadId(
  threadId: ThreadId,
): { threadId: ThreadId; agentId: string } | null {
  const raw = String(threadId);
  if (!raw.startsWith(SWARM_SESSION_PREFIX)) {
    return null;
  }
  const rest = raw.slice(SWARM_SESSION_PREFIX.length);
  const [threadPart, agentPart, extra] = rest.split(":");
  if (!threadPart || !agentPart || extra !== undefined) {
    return null;
  }
  try {
    const decodedThreadId = decodeBase64Url(threadPart);
    const decodedAgentId = decodeBase64Url(agentPart);
    if (!decodedThreadId || !decodedAgentId) {
      return null;
    }
    return {
      threadId: ThreadId.makeUnsafe(decodedThreadId),
      agentId: decodedAgentId,
    };
  } catch {
    return null;
  }
}

export function isSwarmSessionThreadId(threadId: ThreadId): boolean {
  return decodeSwarmSessionThreadId(threadId) !== null;
}
