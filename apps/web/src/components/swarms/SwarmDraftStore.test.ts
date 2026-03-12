import { act } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import type { ProjectId } from "@t3tools/contracts";

import { useSwarmDraftStore } from "./SwarmDraftStore";

describe("SwarmDraftStore", () => {
  beforeEach(() => {
    act(() => {
      useSwarmDraftStore.getState().reset(null);
    });
  });

  it("builds a config with defaults when mission is missing", () => {
    act(() => {
      useSwarmDraftStore.getState().setProject("proj" as ProjectId);
    });
    const config = useSwarmDraftStore.getState().buildConfig();
    expect(config).not.toBeNull();
    expect(config?.agents.length).toBeGreaterThan(0);
    expect(config?.name).toBeTruthy();
  });

  it("switches templates and replaces agents", () => {
    act(() => {
      useSwarmDraftStore.getState().setProject("proj" as ProjectId);
      useSwarmDraftStore.getState().setTemplate("review");
    });
    const reviewAgents = useSwarmDraftStore.getState().agents;
    expect(reviewAgents.length).toBeGreaterThan(0);

    act(() => {
      useSwarmDraftStore.getState().setTemplate("explore");
    });
    const exploreAgents = useSwarmDraftStore.getState().agents;
    expect(exploreAgents).not.toEqual(reviewAgents);
  });
});
