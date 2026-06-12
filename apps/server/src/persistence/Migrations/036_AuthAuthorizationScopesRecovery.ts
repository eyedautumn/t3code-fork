import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import {
  AuthAdministrativeScopes,
  AuthEnvironmentScopes,
  AuthStandardClientScopes,
} from "@t3tools/contracts";

/**
 * Recovery migration for older packaged installs that already consumed the
 * original auth migration numbers but still have the pre-scoped auth tables.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodeScopes = Schema.encodeEffect(Schema.fromJsonString(AuthEnvironmentScopes));

  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  const pairingLinkExists = pairingLinkColumns.length > 0;
  const sessionExists = sessionColumns.length > 0;
  const needsPairingLinkRecovery =
    !pairingLinkColumns.some((column) => column.name === "scopes") ||
    !pairingLinkColumns.some((column) => column.name === "proof_key_thumbprint");
  const needsSessionRecovery = !sessionColumns.some((column) => column.name === "scopes");

  if (!needsPairingLinkRecovery && !needsSessionRecovery) {
    return;
  }

  const createPairingLinksTable = () => sql`
    CREATE TABLE auth_pairing_links (
      id TEXT PRIMARY KEY,
      credential TEXT NOT NULL UNIQUE,
      method TEXT NOT NULL,
      scopes TEXT NOT NULL,
      subject TEXT NOT NULL,
      label TEXT,
      proof_key_thumbprint TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    )
  `;

  const createSessionsTable = () => sql`
    CREATE TABLE auth_sessions (
      session_id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      scopes TEXT NOT NULL,
      method TEXT NOT NULL,
      client_label TEXT,
      client_ip_address TEXT,
      client_user_agent TEXT,
      client_device_type TEXT NOT NULL DEFAULT 'unknown',
      client_os TEXT,
      client_browser TEXT,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_connected_at TEXT,
      revoked_at TEXT
    )
  `;

  if (needsPairingLinkRecovery) {
    if (pairingLinkExists) {
      yield* sql`ALTER TABLE auth_pairing_links RENAME TO auth_pairing_links_legacy`;
    }
    yield* createPairingLinksTable();
    if (pairingLinkExists) {
      yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          proof_key_thumbprint,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
          SELECT
          id,
          credential,
          method,
          CASE role
            WHEN 'owner' THEN ${yield* encodeScopes(AuthAdministrativeScopes)}
            ELSE ${yield* encodeScopes(AuthStandardClientScopes)}
          END,
          subject,
          label,
          NULL,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        FROM auth_pairing_links_legacy
      `;
      yield* sql`DROP TABLE auth_pairing_links_legacy`;
    }

    yield* sql`
      CREATE INDEX idx_auth_pairing_links_active
      ON auth_pairing_links(revoked_at, consumed_at, expires_at)
    `;
  }

  if (needsSessionRecovery) {
    if (sessionExists) {
      yield* sql`ALTER TABLE auth_sessions RENAME TO auth_sessions_legacy`;
    }
    yield* createSessionsTable();
    if (sessionExists) {
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          scopes,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          last_connected_at,
          revoked_at
        )
          SELECT
          session_id,
          subject,
          CASE role
            WHEN 'owner' THEN ${yield* encodeScopes(AuthAdministrativeScopes)}
            ELSE ${yield* encodeScopes(AuthStandardClientScopes)}
          END,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          last_connected_at,
          revoked_at
        FROM auth_sessions_legacy
      `;
      yield* sql`DROP TABLE auth_sessions_legacy`;
    }

    yield* sql`
      CREATE INDEX idx_auth_sessions_active
      ON auth_sessions(revoked_at, expires_at, issued_at)
    `;
  }
});
