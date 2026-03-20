import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const LEGACY_PROVIDER = "opencode";
const CANONICAL_PROVIDER = "codex";
const PROVIDER_KEYS = new Set(["provider", "providerName"]);

function normalizeProviderFields(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const normalized = normalizeProviderFields(entry);
      if (normalized.changed) {
        changed = true;
      }
      return normalized.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (PROVIDER_KEYS.has(key) && entry === LEGACY_PROVIDER) {
        next[key] = CANONICAL_PROVIDER;
        changed = true;
        continue;
      }
      const normalized = normalizeProviderFields(entry);
      if (normalized.changed) {
        changed = true;
      }
      next[key] = normalized.value;
    }
    return changed ? { value: next, changed } : { value, changed: false };
  }
  return { value, changed: false };
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Backfill swarm projection table for users whose DB predates migration 015.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_swarms (
      thread_id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      agents_json TEXT NOT NULL,
      messages_json TEXT NOT NULL,
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

  yield* sql`
    UPDATE provider_session_runtime
    SET
      provider_name = ${CANONICAL_PROVIDER},
      adapter_key = CASE
        WHEN adapter_key = ${LEGACY_PROVIDER} THEN ${CANONICAL_PROVIDER}
        ELSE adapter_key
      END
    WHERE provider_name = ${LEGACY_PROVIDER}
       OR adapter_key = ${LEGACY_PROVIDER}
  `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET provider_name = ${CANONICAL_PROVIDER}
    WHERE provider_name = ${LEGACY_PROVIDER}
  `;

  const rows = yield* sql`
    SELECT event_id as eventId, payload_json as payloadJson
    FROM orchestration_events
    WHERE payload_json LIKE ${`%${LEGACY_PROVIDER}%`}
  `;

  for (const row of rows) {
    const payloadJson = typeof row.payloadJson === "string" ? row.payloadJson : null;
    if (!payloadJson) {
      continue;
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(payloadJson) as unknown,
      catch: () => null,
    });
    if (parsed === null) {
      continue;
    }
    const normalized = normalizeProviderFields(parsed);
    if (!normalized.changed) {
      continue;
    }
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = ${JSON.stringify(normalized.value)}
      WHERE event_id = ${row.eventId}
    `;
  }
});
