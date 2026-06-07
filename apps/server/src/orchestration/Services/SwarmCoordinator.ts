import { Context } from "effect";
import type { Effect, Scope } from "effect";
import type { ThreadId } from "@t3tools/contracts";

export interface SwarmCoordinatorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly startThreadSwarm: (threadId: ThreadId, createdAt: string) => Effect.Effect<void, never>;
}

export class SwarmCoordinator extends Context.Service<SwarmCoordinator, SwarmCoordinatorShape>()(
  "t3/orchestration/Services/SwarmCoordinator",
) {}
