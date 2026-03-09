import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const LEGACY_PROVIDER = "opencode";
const CANONICAL_PROVIDER = "codex";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.provider', ${CANONICAL_PROVIDER})
    WHERE json_extract(payload_json, '$.provider') = ${LEGACY_PROVIDER}
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.providerName', ${CANONICAL_PROVIDER})
    WHERE json_extract(payload_json, '$.providerName') = ${LEGACY_PROVIDER}
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.session.providerName', ${CANONICAL_PROVIDER})
    WHERE json_extract(payload_json, '$.session.providerName') = ${LEGACY_PROVIDER}
  `;
});
