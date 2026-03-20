import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Add task/ownership projection support for swarms.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Ensure base table exists (older installs may have missed prior migrations).
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

  // Add tasks_json column for existing installations.
  yield* sql`ALTER TABLE projection_thread_swarms ADD COLUMN tasks_json TEXT NOT NULL DEFAULT '[]'`;
});
