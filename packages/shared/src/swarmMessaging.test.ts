import { describe, expect, it } from "vitest";

import { normalizeSwarmTargetToken, parseSwarmMessage } from "./swarmMessaging";

describe("swarmMessaging", () => {
  it("parses directives embedded in public text", () => {
    const parsed = parseSwarmMessage(
      "Implemented the fix. [swarm.message coord-1] Please review. [swarm.message_close]",
    );

    expect(parsed.publicText).toBe("Implemented the fix.");
    expect(parsed.hasCloseToken).toBe(true);
    expect(parsed.directives).toEqual([
      {
        targetRaw: "coord-1",
        body: "Please review.",
        rawText: "[swarm.message coord-1] Please review. ",
      },
    ]);
  });

  it("parses multiple directives from one message", () => {
    const parsed = parseSwarmMessage(
      "[swarm.message builder] First handoff. [swarm.message reviewer] Second handoff.",
    );

    expect(parsed.publicText).toBe("");
    expect(parsed.directives.map((entry) => [entry.targetRaw, entry.body])).toEqual([
      ["builder", "First handoff."],
      ["reviewer", "Second handoff."],
    ]);
  });

  it("parses single-bracket directives without requiring a close marker", () => {
    const parsed = parseSwarmMessage("[swarm.message coord-1] Please review this change.");

    expect(parsed.hasCloseToken).toBe(false);
    expect(parsed.publicText).toBe("");
    expect(parsed.directives).toEqual([
      {
        targetRaw: "coord-1",
        body: "Please review this change.",
        rawText: "[swarm.message coord-1] Please review this change.",
      },
    ]);
  });

  it("normalizes quoted targets", () => {
    expect(normalizeSwarmTargetToken('"coord-1"')).toBe("coord-1");
    expect(normalizeSwarmTargetToken("'reviewer'")).toBe("reviewer");
  });

  it("normalizes target= prefixes used in single-bracket directives", () => {
    expect(normalizeSwarmTargetToken("target=coord-1")).toBe("coord-1");
    expect(
      parseSwarmMessage("[swarm.message target=coord-1] Please review. [swarm.message_close]")
        .directives[0],
    ).toMatchObject({
      targetRaw: "coord-1",
      body: "Please review.",
    });
  });

  it("does not truncate directive body when it contains invalid swarm.message-like text", () => {
    const parsed = parseSwarmMessage(
      "[swarm.message trio-builder-2] Please confirm how [swarm.message …] directives flow and report gaps.",
    );

    expect(parsed.directives).toHaveLength(1);
    expect(parsed.directives[0]).toMatchObject({
      targetRaw: "trio-builder-2",
      body: "Please confirm how [swarm.message …] directives flow and report gaps.",
    });
    expect(parsed.publicText).toBe("");
  });
});
