import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeScopes,
  AuthEnvironmentScopes,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import AuthAuthorizationScopesRecovery from "./036_AuthAuthorizationScopesRecovery.ts";

const layer = it.layer(NodeServices.layer);
const encodeScopes = Schema.encodeSync(Schema.fromJsonString(AuthEnvironmentScopes));

layer("036_AuthAuthorizationScopesRecovery", (it) => {
  it.effect("rebuilds legacy role-based auth tables into the scoped schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE auth_pairing_links (
          id TEXT PRIMARY KEY,
          credential TEXT NOT NULL UNIQUE,
          method TEXT NOT NULL,
          role TEXT NOT NULL,
          subject TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        )
      `;
      yield* sql`
        CREATE TABLE auth_sessions (
          session_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          role TEXT NOT NULL,
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

      yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          role,
          subject,
          label,
          created_at,
          expires_at
        )
        VALUES (
          'pairing-link',
          'pairing-token',
          'desktop-bootstrap',
          'owner',
          'desktop',
          'Legacy desktop',
          '2026-06-01T00:00:00.000Z',
          '2026-06-01T01:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
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
        VALUES (
          'session-legacy',
          'desktop-bootstrap',
          'owner',
          'browser-session-cookie',
          'Desktop app',
          '127.0.0.1',
          'Mozilla/5.0',
          'desktop',
          'Linux',
          'Electron',
          '2026-06-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z',
          NULL,
          NULL
        )
      `;

      yield* AuthAuthorizationScopesRecovery;

      const pairingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_sessions)
      `;
      const pairingRows = yield* sql<{
        readonly id: string;
        readonly subject: string;
        readonly scopes: string;
        readonly method: string;
      }>`
        SELECT
          id,
          subject,
          scopes,
          method
        FROM auth_pairing_links
        ORDER BY created_at DESC
      `;
      const sessionRows = yield* sql<{
        readonly sessionId: string;
        readonly subject: string;
        readonly scopes: string;
        readonly method: string;
        readonly clientLabel: string | null;
        readonly clientDeviceType: string;
      }>`
        SELECT
          session_id AS "sessionId",
          subject,
          scopes,
          method,
          client_label AS "clientLabel",
          client_device_type AS "clientDeviceType"
        FROM auth_sessions
        ORDER BY issued_at DESC
      `;

      assert.isTrue(pairingColumns.some((column) => column.name === "scopes"));
      assert.isTrue(pairingColumns.some((column) => column.name === "proof_key_thumbprint"));
      assert.isFalse(pairingColumns.some((column) => column.name === "role"));
      assert.isTrue(sessionColumns.some((column) => column.name === "scopes"));
      assert.isFalse(sessionColumns.some((column) => column.name === "role"));

      assert.deepStrictEqual(pairingRows, [
        {
          id: "pairing-link",
          subject: "desktop",
          scopes: encodeScopes(AuthAdministrativeScopes),
          method: "desktop-bootstrap",
        },
      ]);
      assert.deepStrictEqual(sessionRows, [
        {
          sessionId: "session-legacy",
          subject: "desktop-bootstrap",
          scopes: encodeScopes(AuthAdministrativeScopes),
          method: "browser-session-cookie",
          clientLabel: "Desktop app",
          clientDeviceType: "desktop",
        },
      ]);

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
        VALUES (
          'pairing-link-post-migration',
          'pairing-token-post-migration',
          'one-time-token',
          ${encodeScopes(AuthStandardClientScopes)},
          'one-time-token',
          'Fresh pairing',
          NULL,
          '2026-06-01T00:00:00.000Z',
          '2026-06-01T01:00:00.000Z',
          NULL,
          NULL
        )
      `;
      const migratedPairingRows = yield* sql<{
        readonly id: string;
        readonly scopes: string;
      }>`
        SELECT id, scopes
        FROM auth_pairing_links
        ORDER BY created_at DESC
      `;
      assert.deepStrictEqual(migratedPairingRows, [
        {
          id: "pairing-link",
          scopes: encodeScopes(AuthAdministrativeScopes),
        },
        {
          id: "pairing-link-post-migration",
          scopes: encodeScopes(AuthStandardClientScopes),
        },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeSqliteClient.layerMemory()))),
  );
});
