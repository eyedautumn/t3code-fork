import {
  IsoDateTime,
  ThreadId,
  SwarmAgentState,
  SwarmConfig,
  SwarmMessage,
  SwarmTask,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadSwarm = Schema.Struct({
  threadId: ThreadId,
  config: SwarmConfig,
  agents: Schema.Array(SwarmAgentState),
  messages: Schema.Array(SwarmMessage),
  tasks: Schema.Array(SwarmTask),
  updatedAt: IsoDateTime,
});
export type ProjectionThreadSwarm = typeof ProjectionThreadSwarm.Type;

export const UpsertProjectionThreadSwarmInput = ProjectionThreadSwarm;
export type UpsertProjectionThreadSwarmInput = typeof UpsertProjectionThreadSwarmInput.Type;

export const GetProjectionThreadSwarmInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadSwarmInput = typeof GetProjectionThreadSwarmInput.Type;

export const DeleteProjectionThreadSwarmInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadSwarmInput = typeof DeleteProjectionThreadSwarmInput.Type;

export interface ProjectionThreadSwarmRepositoryShape {
  readonly upsert: (
    input: UpsertProjectionThreadSwarmInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByThreadId: (
    input: GetProjectionThreadSwarmInput,
  ) => Effect.Effect<ProjectionThreadSwarm | null, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadSwarmInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionThreadSwarm>, ProjectionRepositoryError>;
}

export class ProjectionThreadSwarmRepository extends ServiceMap.Service<
  ProjectionThreadSwarmRepository,
  ProjectionThreadSwarmRepositoryShape
>()("t3/persistence/Services/ProjectionThreadSwarms/ProjectionThreadSwarmRepository") {}
