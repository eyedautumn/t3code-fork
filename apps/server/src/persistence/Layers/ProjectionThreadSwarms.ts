import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  IsoDateTime,
  SwarmAgentState,
  SwarmConfig,
  SwarmMessage,
  SwarmTask,
  ThreadId,
} from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadSwarmInput,
  GetProjectionThreadSwarmInput,
  ProjectionThreadSwarm,
  ProjectionThreadSwarmRepository,
  type ProjectionThreadSwarmRepositoryShape,
} from "../Services/ProjectionThreadSwarms.ts";

const ProjectionThreadSwarmDbRow = Schema.Struct({
  threadId: ThreadId,
  config: Schema.fromJsonString(SwarmConfig),
  agents: Schema.fromJsonString(Schema.Array(SwarmAgentState)),
  messages: Schema.fromJsonString(Schema.Array(SwarmMessage)),
  tasks: Schema.fromJsonString(Schema.Array(SwarmTask)),
  updatedAt: IsoDateTime,
});

const makeProjectionThreadSwarmRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadSwarm,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_swarms (
          thread_id,
          config_json,
          agents_json,
          messages_json,
          tasks_json,
          updated_at
        )
        VALUES (
          ${row.threadId},
          ${JSON.stringify(row.config)},
          ${JSON.stringify(row.agents)},
          ${JSON.stringify(row.messages)},
          ${JSON.stringify(row.tasks)},
          ${row.updatedAt}
        )
        ON CONFLICT(thread_id) DO UPDATE SET
          config_json = excluded.config_json,
          agents_json = excluded.agents_json,
          messages_json = excluded.messages_json,
          tasks_json = excluded.tasks_json,
          updated_at = excluded.updated_at
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadSwarmInput,
    Result: ProjectionThreadSwarmDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          config_json AS "config",
          agents_json AS "agents",
          messages_json AS "messages",
          tasks_json AS "tasks",
          updated_at AS "updatedAt"
        FROM projection_thread_swarms
        WHERE thread_id = ${threadId}
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSwarmDbRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          config_json AS "config",
          agents_json AS "agents",
          messages_json AS "messages",
          tasks_json AS "tasks",
          updated_at AS "updatedAt"
        FROM projection_thread_swarms
        ORDER BY updated_at DESC
      `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteProjectionThreadSwarmInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_swarms
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadSwarmRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSwarmRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadSwarmRepositoryShape["getByThreadId"] = (input) =>
    getRow(input).pipe(
      Effect.map((row) => (Option.isSome(row) ? row.value : null)),
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSwarmRepository.getByThreadId:query")),
    );

  const listAll: ProjectionThreadSwarmRepositoryShape["listAll"] = () =>
    listRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSwarmRepository.listAll:query")),
    );

  const deleteByThreadId: ProjectionThreadSwarmRepositoryShape["deleteByThreadId"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSwarmRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    listAll,
    deleteByThreadId,
  } satisfies ProjectionThreadSwarmRepositoryShape;
});

export const ProjectionThreadSwarmRepositoryLive = Layer.effect(
  ProjectionThreadSwarmRepository,
  makeProjectionThreadSwarmRepository,
);
