import { describe, expect, it } from "vitest";
import { MessageId, type SwarmMessage, type SwarmState } from "@t3tools/contracts";

import { formatSwarmMessage } from "./swarmMessageFormatting";

const agents: SwarmState["config"]["agents"] = [
  {
    id: "coord-1",
    name: "Coordinator",
    role: "coordinator",
    provider: "codex",
    model: "claude-code",
    runtimeMode: "full-access",
    interactionMode: "default",
    serviceTier: "flex",
    modelOptions: {},
  },
  {
    id: "builder-1",
    name: "Builder",
    role: "builder",
    provider: "opencode",
    model: "opencode/big-pickle",
    runtimeMode: "full-access",
    interactionMode: "default",
    serviceTier: "flex",
    modelOptions: {},
  },
];

function makeMessage(text: string, overrides?: Partial<SwarmMessage>): SwarmMessage {
  return {
    id: MessageId.makeUnsafe("msg-1"),
    sender: "agent",
    senderAgentId: "builder-1",
    targetAgentId: null,
    text,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatSwarmMessage", () => {
  it("keeps raw text visible when a null-target agent message still contains inline directives", () => {
    const formatted = formatSwarmMessage(
      makeMessage(
        "Implemented the fix. [swarm.message coord-1] Please review. [swarm.message_close]",
      ),
      agents,
      false,
    );

    expect(formatted.text).toContain("[swarm.message coord-1]");
    expect(formatted.isDirective).toBe(false);
    expect(formatted.hideWhenNotRaw).toBe(false);
  });

  it("hides close-only directive placeholders", () => {
    const formatted = formatSwarmMessage(makeMessage("[swarm.message_close]"), agents, false);

    expect(formatted.text).toBe("");
    expect(formatted.hideWhenNotRaw).toBe(true);
  });

  it("formats single-bracket target= directives", () => {
    const formatted = formatSwarmMessage(
      makeMessage("[swarm.message target=coord-1] Please review. [swarm.message_close]", {
        targetAgentId: "coord-1",
      }),
      agents,
      false,
    );

    expect(formatted.text).toBe("Please review.");
    expect(formatted.targetAgentId).toBe("coord-1");
    expect(formatted.isDirective).toBe(true);
  });

  it("keeps raw directive text visible when the backend has not routed it", () => {
    const formatted = formatSwarmMessage(
      makeMessage("[swarm.message target=coord-1] Please review. [swarm.message_close]"),
      agents,
      false,
    );

    expect(formatted.text).toContain("[swarm.message target=coord-1]");
    expect(formatted.targetAgentId).toBeNull();
    expect(formatted.isDirective).toBe(false);
  });

  it("keeps full directed text when body references swarm.message syntax in prose", () => {
    const formatted = formatSwarmMessage(
      makeMessage(
        "[swarm.message coord-1] Please map where [swarm.message ...] directives are parsed and explain the live handoff gap.",
        {
          targetAgentId: "coord-1",
        },
      ),
      agents,
      false,
    );

    expect(formatted.targetAgentId).toBe("coord-1");
    expect(formatted.text).toContain("Please map where");
    expect(formatted.text).toContain("[swarm.message ...]");
    expect(formatted.text).toContain("live handoff gap");
  });
});
