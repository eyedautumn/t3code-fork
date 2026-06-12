import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { ORCHESTRATION_WS_METHODS } from "./orchestration.ts";
import { WsRpcGroup } from "./rpc.ts";

function getRpcGroupRequestTags(): ReadonlySet<string> {
  const requests = (WsRpcGroup as unknown as { readonly requests: ReadonlyMap<string, unknown> })
    .requests;
  return new Set(requests.keys());
}

type UntypedRpcGroup = {
  readonly of: <T extends Record<string, unknown>>(handlers: T) => T;
  readonly toHandlers: (handlers: Record<string, unknown>) => Effect.Effect<unknown, never, never>;
};

describe("WsRpcGroup", () => {
  it("contains every orchestration websocket method", () => {
    const requestTags = getRpcGroupRequestTags();

    expect(
      Object.values(ORCHESTRATION_WS_METHODS).filter((method) => !requestTags.has(method)),
    ).toEqual([]);
  });

  it.effect("builds a handler layer for the swarm context method", () => {
    const rpcGroup = WsRpcGroup as unknown as UntypedRpcGroup;

    return rpcGroup
      .toHandlers(
        rpcGroup.of({
          [ORCHESTRATION_WS_METHODS.getSwarmContext]: () => Effect.succeed(null as never),
        }),
      )
      .pipe(Effect.asVoid);
  });
});
