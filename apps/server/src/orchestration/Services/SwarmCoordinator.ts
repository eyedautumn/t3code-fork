import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface SwarmCoordinatorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class SwarmCoordinator extends ServiceMap.Service<
  SwarmCoordinator,
  SwarmCoordinatorShape
>()("t3/orchestration/Services/SwarmCoordinator") {}
