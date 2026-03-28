import { describe, expect, it } from "vitest";

import { getSwarmMessageRouteLabel } from "./swarmMessagePresentation";

const getAgentName = (id: string) => (id === "agent-2" ? "Builder" : id);

describe("getSwarmMessageRouteLabel", () => {
  it("keeps operator broadcasts as broadcasts", () => {
    expect(
      getSwarmMessageRouteLabel({
        sender: "operator",
        senderName: "Operator",
        targetAgentId: null,
        getAgentName,
      }),
    ).toBe("Operator -> All Agents");
  });

  it("renders agent transcript text as output instead of a fake broadcast", () => {
    expect(
      getSwarmMessageRouteLabel({
        sender: "agent",
        senderName: "Builder",
        targetAgentId: null,
        getAgentName,
      }),
    ).toBe("Builder output");
  });

  it("renders directed agent messages with an explicit target", () => {
    expect(
      getSwarmMessageRouteLabel({
        sender: "agent",
        senderName: "Builder",
        targetAgentId: "agent-2",
        getAgentName,
      }),
    ).toBe("Builder -> Builder");
  });
});
