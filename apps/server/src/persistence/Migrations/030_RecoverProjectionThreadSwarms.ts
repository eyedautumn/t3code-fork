import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_swarms (
      thread_id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      agents_json TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      tasks_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_swarms_updated_at
    ON projection_thread_swarms(updated_at)
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES (
      'projection.thread-swarms',
      0,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  `;

  yield* sql`
    UPDATE projection_state
    SET
      last_applied_sequence = 0,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE projector = 'projection.thread-swarms'
      AND NOT EXISTS (SELECT 1 FROM projection_thread_swarms)
  `;
});
