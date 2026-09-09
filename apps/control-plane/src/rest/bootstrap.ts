import type { PoolClient } from "pg";
import { quoteIdent, quoteLiteral } from "../data/identifiers.js";
import { ANON_ROLE, AUTHENTICATOR_ROLE, SERVICE_ROLE } from "./jwt.js";

/**
 * Prepare a database to be served over HTTP.
 *
 * Three roles, and the relationships between them are the entire security
 * model:
 *
 *  - `authenticator` is what PostgREST logs in as. It can do nothing itself —
 *    `NOINHERIT` — and only becomes something by `SET ROLE` to whatever the
 *    request's JWT names.
 *  - `anon` is what an unauthenticated request becomes.
 *  - `service_role` bypasses row-level security entirely, for server-side work.
 *
 * **`anon` is granted nothing here, and that is a deliberate difference from
 * how Supabase sets this up.** There, `anon` gets blanket DML on `public` and
 * row-level security is the only thing standing between the internet and every
 * table — which is why forgetting to enable RLS on one table is such a
 * well-known way to publish a database by accident. Here a table becomes
 * reachable only through an explicit "expose" action that grants privileges and
 * enables RLS in the same transaction, so the dangerous state is not reachable
 * by forgetting something.
 */
export async function bootstrapApiRoles(
  client: PoolClient,
  authenticatorPassword: string,
): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(ANON_ROLE)}) THEN
        CREATE ROLE ${quoteIdent(ANON_ROLE)} NOLOGIN NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(SERVICE_ROLE)}) THEN
        CREATE ROLE ${quoteIdent(SERVICE_ROLE)} NOLOGIN NOINHERIT BYPASSRLS;
      END IF;
    END
    $$;
  `);

  // The password is rotated on every enable, so a previously issued one stops
  // working even if it leaked.
  await client.query(
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(AUTHENTICATOR_ROLE)}) THEN
         ALTER ROLE ${quoteIdent(AUTHENTICATOR_ROLE)} LOGIN NOINHERIT PASSWORD ${quoteLiteral(authenticatorPassword)};
       ELSE
         CREATE ROLE ${quoteIdent(AUTHENTICATOR_ROLE)} LOGIN NOINHERIT PASSWORD ${quoteLiteral(authenticatorPassword)};
       END IF;
     END
     $$;`,
  );

  await client.query(`GRANT ${quoteIdent(ANON_ROLE)} TO ${quoteIdent(AUTHENTICATOR_ROLE)}`);
  await client.query(`GRANT ${quoteIdent(SERVICE_ROLE)} TO ${quoteIdent(AUTHENTICATOR_ROLE)}`);

  // Schema usage only. Without it PostgREST cannot see the schema at all; with
  // it and nothing else, it sees an empty API — which is the correct starting
  // point for a database that has just been put on the internet.
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(ANON_ROLE)}, ${quoteIdent(SERVICE_ROLE)}`);
  await client.query(
    `GRANT ALL ON ALL TABLES IN SCHEMA public TO ${quoteIdent(SERVICE_ROLE)}`,
  );
  await client.query(
    `GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdent(SERVICE_ROLE)}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${quoteIdent(SERVICE_ROLE)}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${quoteIdent(SERVICE_ROLE)}`,
  );
}

/**
 * The `auth` schema: how a policy reads the caller's identity.
 *
 * PostgREST puts the verified JWT into the `request.jwt.claims` setting for the
 * duration of each request. These wrappers turn that into something a policy
 * can be written against without every author having to know the mechanism —
 * and, more importantly, without them having to get the `NULL` handling right,
 * since `current_setting` on a missing key throws rather than returning null.
 *
 * The names match the convention Supabase established. That is a deliberate
 * compatibility choice: policies people already know how to write should work.
 */
export async function bootstrapAuthSchema(client: PoolClient): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS auth`);
  await client.query(`GRANT USAGE ON SCHEMA auth TO ${quoteIdent(ANON_ROLE)}, ${quoteIdent(SERVICE_ROLE)}`);

  await client.query(`
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE AS $$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claims', true), ''),
        '{}'
      )::jsonb
    $$;
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
    LANGUAGE sql STABLE AS $$
      SELECT nullif(auth.jwt() ->> 'sub', '')
    $$;
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE AS $$
      SELECT nullif(auth.jwt() ->> 'role', '')
    $$;
  `);

  // A claim accessor, so a policy can key off anything the identity provider
  // put in the token — a tenant id, an organisation, a plan.
  await client.query(`
    CREATE OR REPLACE FUNCTION auth.claim(name text) RETURNS text
    LANGUAGE sql STABLE AS $$
      SELECT nullif(auth.jwt() ->> name, '')
    $$;
  `);

  await client.query(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO ${quoteIdent(ANON_ROLE)}, ${quoteIdent(SERVICE_ROLE)}`,
  );
}

/** Undo the grants that make a database reachable, leaving the data alone. */
export async function revokeApiAccess(client: PoolClient): Promise<void> {
  await client.query(
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${quoteIdent(ANON_ROLE)}`,
  );
  await client.query(`REVOKE USAGE ON SCHEMA public FROM ${quoteIdent(ANON_ROLE)}`);
  // The authenticator can no longer log in, which stops PostgREST dead even if
  // a container somehow survives.
  await client.query(`ALTER ROLE ${quoteIdent(AUTHENTICATOR_ROLE)} NOLOGIN`);
}
