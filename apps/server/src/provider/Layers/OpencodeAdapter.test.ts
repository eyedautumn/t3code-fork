import { describe, expect, it } from "vitest";
import { ThreadId, TurnId } from "@t3tools/contracts";

import { __test } from "./OpencodeAdapter.ts";

describe("OpencodeAdapter stream mapping", () => {
  it("picks the most recently updated session when multiple sessions share the same title", () => {
    const selected = __test.selectMostRecentSessionByTitle(
      [
        {
          id: "older-session",
          title: "Session swarm:thread-1:agent-1",
          time: { updated: 1000 },
        } as any,
        {
          id: "newer-session",
          title: "Session swarm:thread-1:agent-1",
          time: { updated: 2000 },
        } as any,
      ],
      "Session swarm:thread-1:agent-1",
    );

    expect(selected?.id).toBe("newer-session");
  });

  it("returns undefined when no sessions match the expected title", () => {
    const selected = __test.selectMostRecentSessionByTitle(
      [{ id: "session-1", title: "Session swarm:other-thread:other-agent" } as any],
      "Session swarm:thread-1:agent-1",
    );

    expect(selected).toBeUndefined();
  });

  it("prefers the most recent title-matched session over a stale resume session id", () => {
    const selected = __test.selectSessionForThread({
      sessions: [
        {
          id: "stale-resume-session",
          title: "Session swarm:other-thread:other-agent",
          time: { updated: 500 },
        } as any,
        {
          id: "current-thread-session",
          title: "Session swarm:thread-1:agent-1",
          time: { updated: 2000 },
        } as any,
      ],
      expectedTitle: "Session swarm:thread-1:agent-1",
      resumeSessionId: "stale-resume-session",
    });

    expect(selected?.id).toBe("current-thread-session");
  });

  it("falls back to the resume session id when no title-matched session exists", () => {
    const selected = __test.selectSessionForThread({
      sessions: [
        {
          id: "resume-session",
          title: "Session swarm:other-thread:other-agent",
          time: { updated: 500 },
        } as any,
      ],
      expectedTitle: "Session swarm:thread-1:agent-1",
      resumeSessionId: "resume-session",
    });

    expect(selected?.id).toBe("resume-session");
  });

  it("maps same-session message.part.delta events to content.delta", () => {
    const streamState = __test.makeTurnStreamState("prompt");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    const events = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "message-1",
          partID: "part-1",
          partType: "text",
          field: "text",
          delta: "hello",
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("content.delta");
    if (events[0]?.type !== "content.delta") {
      throw new Error("Expected content.delta");
    }
    expect(events[0].payload.delta).toBe("hello");
    expect(events[0].payload.streamKind).toBe("assistant_text");
  });

  it("accepts child-session deltas after a session.updated parent linkage event", () => {
    const streamState = __test.makeTurnStreamState("prompt");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    const linkageEvents = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "session.updated",
        properties: {
          info: {
            id: "child-session-1",
            parentID: "session-1",
          },
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(linkageEvents).toHaveLength(0);
    expect(streamState.acceptedSessionIds.has("session-1")).toBe(true);
    expect(streamState.acceptedSessionIds.has("child-session-1")).toBe(true);

    const events = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "child-session-1",
          messageID: "message-2",
          partID: "part-2",
          partType: "text",
          field: "text",
          delta: "from child",
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("content.delta");
    if (events[0]?.type !== "content.delta") {
      throw new Error("Expected content.delta");
    }
    expect(events[0].payload.delta).toBe("from child");
  });

  it("accepts session handoff when session.updated title matches the active provider thread title", () => {
    const streamState = __test.makeTurnStreamState("prompt");
    const threadId = ThreadId.makeUnsafe("swarm:thread-1:agent-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    const linkageEvents = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "session.updated",
        properties: {
          info: {
            id: "handoff-session-1",
            title: `Session ${threadId}`,
          },
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(linkageEvents).toHaveLength(0);
    expect(streamState.acceptedSessionIds.has("session-1")).toBe(true);
    expect(streamState.acceptedSessionIds.has("handoff-session-1")).toBe(true);

    const events = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "handoff-session-1",
          messageID: "message-2",
          partID: "part-2",
          partType: "text",
          field: "text",
          delta: "[swarm.message squad-coordinator-1] I need an assignment.",
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("content.delta");
    if (events[0]?.type !== "content.delta") {
      throw new Error("Expected content.delta");
    }
    expect(events[0].payload.delta).toContain("I need an assignment");
  });

  it("does not accept unrelated sessions when session.updated title does not match the active provider thread title", () => {
    const streamState = __test.makeTurnStreamState("prompt");
    const threadId = ThreadId.makeUnsafe("swarm:thread-1:agent-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "session.updated",
        properties: {
          info: {
            id: "other-session-1",
            title: "Session swarm:other-thread:other-agent",
          },
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    const events = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "other-session-1",
          messageID: "message-2",
          partID: "part-2",
          partType: "text",
          field: "text",
          delta: "should be ignored",
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(events).toHaveLength(0);
  });

  it("reconstructs assistant text from message.updated snapshots when no streaming delta arrived", () => {
    const streamState = __test.makeTurnStreamState("prompt");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    const events = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          messageID: "message-3",
          info: {
            role: "assistant",
            finish: "stop",
          },
          parts: [{ id: "part-3", type: "text", text: "final reply" }],
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(events.map((event) => event.type)).toEqual(["content.delta", "item.completed"]);
    expect(events[0]?.type).toBe("content.delta");
    if (events[0]?.type !== "content.delta") {
      throw new Error("Expected content.delta");
    }
    expect(events[0].payload.delta).toBe("final reply");
    expect(events[0].payload.streamKind).toBe("assistant_text");
  });

  it("treats message.updated snapshots with missing role metadata as assistant output", () => {
    const streamState = __test.makeTurnStreamState("prompt");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    const events = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          messageID: "message-3b",
          info: {
            finish: "stop",
          },
          parts: [{ id: "part-3b", type: "text", text: "[swarm.message coord-1] ping" }],
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(events.map((event) => event.type)).toEqual(["content.delta", "item.completed"]);
    expect(events[0]?.type).toBe("content.delta");
    if (events[0]?.type !== "content.delta") {
      throw new Error("Expected content.delta");
    }
    expect(events[0].payload.delta).toBe("[swarm.message coord-1] ping");
    expect(events[0].payload.streamKind).toBe("assistant_text");
  });

  it("treats assistant text parts with missing partType as assistant_text", () => {
    const streamState = __test.makeTurnStreamState("prompt");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    const events = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "message-4",
          partID: "part-4",
          role: "assistant",
          field: "text",
          delta: "[swarm.message target=scout] investigate this",
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(events[0]?.type).toBe("content.delta");
    if (events[0]?.type !== "content.delta") {
      throw new Error("Expected content.delta");
    }
    expect(events[0].payload.streamKind).toBe("assistant_text");
  });

  it("waits to finalize until trailing assistant text after idle has been processed", () => {
    const streamState = __test.makeTurnStreamState("prompt");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    const idleEvents = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "session.idle",
        properties: {
          sessionID: "session-1",
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(idleEvents).toHaveLength(0);
    expect(streamState.idle).toBe(true);
    expect(streamState.completed).toBe(false);

    const trailingEvents = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          messageID: "message-5",
          role: "assistant",
          part: {
            id: "part-5",
            type: "text",
            text: "[swarm.message coordinator] ready for assignment",
          },
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(trailingEvents).toHaveLength(1);
    expect(trailingEvents[0]?.type).toBe("content.delta");

    const completionEvents = __test.finalizeTurnFromIdle(threadId, turnId, streamState);
    expect(completionEvents.map((event) => event.type)).toEqual([
      "item.completed",
      "turn.completed",
    ]);
    expect(streamState.completed).toBe(true);
  });

  it("refreshes idle grace window when assistant text arrives after idle", () => {
    const streamState = __test.makeTurnStreamState("prompt");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    streamState.idle = true;
    streamState.idleStartedAt = 1;

    const events = __test.mapSseEventToRuntimeEventsForTest(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "message-6",
          partID: "part-6",
          partType: "text",
          field: "text",
          delta: "[swarm.message coord-1] hello",
        },
      },
      "session-1",
      threadId,
      turnId,
      streamState,
    );

    expect(events[0]?.type).toBe("content.delta");
    expect(streamState.idleStartedAt).toBeTypeOf("number");
    expect((streamState.idleStartedAt ?? 0) > 1).toBe(true);
  });
});
