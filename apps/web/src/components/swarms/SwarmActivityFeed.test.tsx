import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SwarmState } from "@t3tools/contracts";
import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { toBeInTheDocument } from "@testing-library/jest-dom/matchers";

expect.extend({ toBeInTheDocument });

import { SwarmActivityFeed } from "./SwarmActivityFeed";

const baseSwarm: SwarmState = {
  config: {
    name: "Demo",
    mission: "Test",
    targetPath: "apps",
    agents: [
      {
        id: "agent-1",
        name: "Coordinator",
        role: "coordinator",
        provider: "codex",
        model: "claude",
        runtimeMode: "full-access",
        interactionMode: "default",
        serviceTier: "flex",
        modelOptions: {},
      },
      {
        id: "agent-2",
        name: "Builder",
        role: "builder",
        provider: "codex",
        model: "claude",
        runtimeMode: "full-access",
        interactionMode: "default",
        serviceTier: "flex",
        modelOptions: {},
      },
    ],
  },
  agents: [],
  messages: [
    {
      id: MessageId.makeUnsafe("m-1"),
      sender: "operator",
      senderAgentId: null,
      targetAgentId: null,
      text: "Hello",
      streaming: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    {
      id: MessageId.makeUnsafe("m-2"),
      sender: "agent",
      senderAgentId: "agent-2",
      targetAgentId: null,
      text: "ack",
      streaming: false,
      createdAt: "2024-01-01T00:00:01.000Z",
      updatedAt: "2024-01-01T00:00:01.000Z",
    },
  ],
  tasks: [],
};

describe("SwarmActivityFeed", () => {
   it("renders sender to target labels", () => {
     render(<SwarmActivityFeed swarm={baseSwarm} />);
     expect(screen.getByText("Operator → All Agents")).toBeInTheDocument();
     expect(screen.getByText("Builder → All Agents")).toBeInTheDocument();
   });

   it("filters by agent selection", async () => {
     render(<SwarmActivityFeed swarm={baseSwarm} />);
     const combobox = screen.getAllByRole("combobox")[0];
     if (!combobox) {
       throw new Error("combobox not found");
     }
     fireEvent.click(combobox);
     const builderOption = await screen.findByRole("option", { name: /Builder/i });
     fireEvent.click(builderOption);

     await waitFor(() => {
       expect(screen.getAllByText("Builder → All Agents").length).toBeGreaterThan(0);
     });
   });
});
