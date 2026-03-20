import type { ThreadId } from "@t3tools/contracts";

const STORAGE_KEY = "swarm-thread-ids";

function safeParse(): Set<ThreadId> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed as ThreadId[]);
  } catch {
    return new Set();
  }
}

function safePersist(ids: Set<ThreadId>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // ignore storage errors
  }
}

export function getSwarmHints(): Set<ThreadId> {
  return safeParse();
}

export function addSwarmHint(threadId: ThreadId): Set<ThreadId> {
  const next = getSwarmHints();
  next.add(threadId);
  safePersist(next);
  return next;
}
