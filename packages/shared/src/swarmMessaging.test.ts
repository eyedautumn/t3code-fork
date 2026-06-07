import { describe, expect, it } from "vitest";

import {
  normalizeSwarmTargetToken,
  parseSwarmMessage,
  type ParsedSwarmDirective,
} from "./swarmMessaging.js";

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

  it("does not parse explanatory inline mentions as directives", () => {
    const parsed = parseSwarmMessage(
      "Awaiting the plan to share with the operator via [swarm.message operator] before edits.",
    );

    expect(parsed.directives).toEqual([]);
    expect(parsed.publicText).toBe(
      "Awaiting the plan to share with the operator via [swarm.message operator] before edits.",
    );
  });

  it("does not parse markers inside inline code spans as directives", () => {
    const parsed = parseSwarmMessage(
      "Use `[swarm.message operator]` only when reporting to the human.",
    );

    expect(parsed.directives).toEqual([]);
    expect(parsed.publicText).toBe(
      "Use `[swarm.message operator]` only when reporting to the human.",
    );
  });

  it("keeps explanatory marker mentions inside an active directive body", () => {
    const parsed = parseSwarmMessage(
      "[swarm.message trio-cordinator-1] MESSAGE FROM trio-reviewer-3: Awaiting the full plan from you to share with the operator via [swarm.message operator] before edits.",
    );

    expect(parsed.publicText).toBe("");
    expect(parsed.directives).toEqual([
      {
        targetRaw: "trio-cordinator-1",
        body: "MESSAGE FROM trio-reviewer-3: Awaiting the full plan from you to share with the operator via [swarm.message operator] before edits.",
        rawText:
          "[swarm.message trio-cordinator-1] MESSAGE FROM trio-reviewer-3: Awaiting the full plan from you to share with the operator via [swarm.message operator] before edits.",
      },
    ]);
  });

  it("parses multiple directives from one message", () => {
    const parsed = parseSwarmMessage(
      "[swarm.message builder] First handoff. [swarm.message reviewer] Second handoff.",
    );

    expect(parsed.publicText).toBe("");
    expect(
      parsed.directives.map((entry: ParsedSwarmDirective) => [entry.targetRaw, entry.body]),
    ).toEqual([
      ["builder", "First handoff."],
      ["reviewer", "Second handoff."],
    ]);
  });

  it("treats a blank line after a single-bracket directive as public text boundary", () => {
    const parsed = parseSwarmMessage(
      "[swarm.message review-scout-2] MESSAGE FROM coordinator: Scout 2, explore ReplicatedStorage.\n\nMeanwhile I'll explore ServerStorage myself.",
    );

    expect(parsed.publicText).toBe("Meanwhile I'll explore ServerStorage myself.");
    expect(parsed.directives).toEqual([
      {
        targetRaw: "review-scout-2",
        body: "MESSAGE FROM coordinator: Scout 2, explore ReplicatedStorage.",
        rawText:
          "[swarm.message review-scout-2] MESSAGE FROM coordinator: Scout 2, explore ReplicatedStorage.",
      },
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
