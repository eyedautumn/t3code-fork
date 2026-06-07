import { ProviderDriverKind, type SwarmAgent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveSwarmTarget } from "./swarmTargets.js";

const agents: SwarmAgent[] = [
  {
    id: "trio-coordinator-1",
    name: "Coordinator",
    role: "coordinator",
    provider: ProviderDriverKind.make("opencode"),
    model: "opencode-default",
    runtimeMode: "full-access",
    interactionMode: "default",
  },
  {
    id: "trio-builder-2",
    name: "Builder",
    role: "builder",
    provider: ProviderDriverKind.make("opencode"),
    model: "opencode-default",
    runtimeMode: "full-access",
    interactionMode: "default",
  },
  {
    id: "trio-reviewer-3",
    name: "Reviewer",
    role: "reviewer",
    provider: ProviderDriverKind.make("opencode"),
    model: "opencode-default",
    runtimeMode: "full-access",
    interactionMode: "default",
  },
];

describe("resolveSwarmTarget", () => {
  it("resolves common OpenCode coordinator id typos", () => {
    expect(resolveSwarmTarget(agents, "trio-cordinator-1")).toMatchObject({
      targetAgentId: "trio-coordinator-1",
    });
  });

  it("resolves role aliases", () => {
    expect(resolveSwarmTarget(agents, "cordinator")).toMatchObject({
      targetAgentId: "trio-coordinator-1",
    });
  });

  it("resolves operator aliases", () => {
    expect(resolveSwarmTarget(agents, "human")).toMatchObject({
      targetAgentId: "__swarm.operator__",
      toOperator: true,
    });
  });
});
