import { MessageId, ProviderDriverKind, type SwarmState } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../../types";
import { deriveSwarmLiveMessages } from "./swarmLiveMessages";

function makeSwarm(messages: SwarmState["messages"]): SwarmState {
  return {
    config: {
      name: "Swarm",
      mission: "Coordinate",
      agents: [
        {
          id: "agent-1",
          name: "Agent 1",
          role: "builder",
          provider: ProviderDriverKind.make("codex"),
          model: "gpt-5-codex",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
        },
      ],
      contextFiles: [],
    },
    agents: [],
    messages,
    tasks: [],
  };
}

describe("deriveSwarmLiveMessages", () => {
  it("projects agent swarm messages into activity stream entries", () => {
    const liveMessages = deriveSwarmLiveMessages(
      makeSwarm([
        {
          id: MessageId.make("operator-message"),
          sender: "operator",
          senderAgentId: null,
          targetAgentId: "agent-1",
          text: "Go",
          streaming: false,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
        {
          id: MessageId.make("thinking-message"),
          sender: "agent",
          senderAgentId: "agent-1",
          targetAgentId: null,
          text: "[thinking]\nInspecting files",
          streaming: true,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
        {
          id: MessageId.make("tool-message"),
          sender: "agent",
          senderAgentId: "agent-1",
          targetAgentId: null,
          text: "[tool]\nran bun lint",
          streaming: false,
          createdAt: "2026-02-27T00:00:02.000Z",
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
      ]),
    );

    expect(liveMessages).toEqual([
      {
        id: "thinking-message",
        kind: "thinking",
        agentId: "agent-1",
        text: "Inspecting files",
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        targetAgentId: null,
        senderAgentId: "agent-1",
      },
      {
        id: "tool-message",
        kind: "tool",
        agentId: "agent-1",
        text: "ran bun lint",
        streaming: false,
        createdAt: "2026-02-27T00:00:02.000Z",
        targetAgentId: null,
        senderAgentId: "agent-1",
      },
    ]);
  });
});
