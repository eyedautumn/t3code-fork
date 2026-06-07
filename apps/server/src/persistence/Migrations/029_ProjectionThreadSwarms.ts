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
    SELECT
      'projection.thread-swarms',
      COALESCE(MAX(sequence), 0),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM orchestration_events
  `;
});
