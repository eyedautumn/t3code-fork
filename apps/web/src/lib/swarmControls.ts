import type { ThreadId } from "@t3tools/contracts";

import { readNativeApi } from "../nativeApi";
import { newCommandId } from "./utils";

export async function stopSwarmSessions(threadId: ThreadId): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const createdAt = new Date().toISOString();
  await api.orchestration.dispatchCommand({
    type: "thread.session.stop",
    commandId: newCommandId(),
    threadId,
    createdAt,
  });
}

export async function startSwarmSessions(threadId: ThreadId, _swarm?: unknown): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const createdAt = new Date().toISOString();
  await api.orchestration.dispatchCommand({
    type: "thread.swarm.start",
    commandId: newCommandId(),
    threadId,
    createdAt,
  });
}
