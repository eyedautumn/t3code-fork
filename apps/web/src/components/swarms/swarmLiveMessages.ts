import type { SwarmState } from "@t3tools/contracts";

import type { SwarmLiveMessage } from "../../store";
import { isThinkingMessage } from "../../lib/swarmMessageFormatting";

function classifyLiveMessageKind(text: string): SwarmLiveMessage["kind"] {
  const normalized = text.trimStart().toLowerCase();
  if (isThinkingMessage(text)) return "thinking";
  if (normalized.startsWith("[tool]") || normalized.startsWith("[command]")) return "tool";
  if (normalized.startsWith("[mcp]")) return "mcp";
  return "message";
}

function stripLiveMessagePrefix(text: string): string {
  return text.replace(/^\s*\[(thinking|reasoning|thoughts|tool|command|mcp)\]\s*/i, "");
}

export function deriveSwarmLiveMessages(swarm: SwarmState): SwarmLiveMessage[] {
  return swarm.messages
    .filter((message) => message.sender === "agent")
    .map((message) => {
      const text = message.text ?? "";
      const liveMessage: SwarmLiveMessage = {
        id: message.id,
        kind: classifyLiveMessageKind(text),
        text: stripLiveMessagePrefix(text),
        streaming: message.streaming,
        createdAt: message.createdAt,
        targetAgentId: message.targetAgentId,
        senderAgentId: message.senderAgentId,
      };
      if (message.senderAgentId) {
        liveMessage.agentId = message.senderAgentId;
      }
      return liveMessage;
    });
}
