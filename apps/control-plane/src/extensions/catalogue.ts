/**
 * Curated metadata about extensions.
 *
 * What is actually installable is read from `pg_available_extensions` in the
 * project's own database — that is authoritative and image-specific, and
 * hardcoding a list would go stale the moment an image changed. This file adds
 * only what the catalog cannot tell us: what an extension is for, and whether
 * turning it on costs a restart.
 *
 * An extension not listed here still appears, just without the description.
 * Being unopinionated about the long tail is deliberate; a database whose
 * superuser can `CREATE EXTENSION` anything should not pretend otherwise.
 */

export type ExtensionCategory =
  | "search"
  | "geospatial"
  | "scheduling"
  | "security"
  | "observability"
  | "utility";

export interface ExtensionMeta {
  name: string;
  title: string;
  description: string;
  category: ExtensionCategory;
  /**
   * Library name for `shared_preload_libraries`.
   *
   * Present means enabling this extension requires a restart: Postgres reads
   * `shared_preload_libraries` once at startup and a library that was not
   * loaded then cannot be loaded later. There is no way to make this instant.
   */
  preloadLibrary?: string;
  /** Settings the extension needs alongside its preload, applied at the same time. */
  settings?: Record<string, string>;
  docsUrl?: string;
}

export const EXTENSION_CATALOGUE: ExtensionMeta[] = [
  {
    name: "vector",
    title: "pgvector",
    description:
      "Vector similarity search: an embedding column type with exact and approximate nearest-neighbour indexes.",
    category: "search",
    docsUrl: "https://github.com/pgvector/pgvector",
  },
  {
    name: "postgis",
    title: "PostGIS",
    description: "Geographic objects, spatial indexes and several hundred spatial functions.",
    category: "geospatial",
    docsUrl: "https://postgis.net/documentation/",
  },
  {
    name: "postgis_topology",
    title: "PostGIS Topology",
    description: "Topological data model on top of PostGIS. Requires PostGIS.",
    category: "geospatial",
  },
  {
    name: "pg_cron",
    title: "pg_cron",
    description: "Cron-style job scheduling inside the database.",
    category: "scheduling",
    preloadLibrary: "pg_cron",
    // Without this, pg_cron schedules against `postgres` by default, which is
    // right here but worth being explicit about rather than relying on.
    settings: { "cron.database_name": "postgres" },
    docsUrl: "https://github.com/citusdata/pg_cron",
  },
  {
    name: "pg_stat_statements",
    title: "pg_stat_statements",
    description:
      "Cumulative statistics for every query shape the server runs. The basis of the query insights in M8.",
    category: "observability",
    preloadLibrary: "pg_stat_statements",
    docsUrl: "https://www.postgresql.org/docs/current/pgstatstatements.html",
  },
  {
    name: "pgcrypto",
    title: "pgcrypto",
    description: "Hashing, HMAC, symmetric and public-key encryption functions.",
    category: "security",
  },
  {
    name: "uuid-ossp",
    title: "uuid-ossp",
    description:
      "UUID generation. Postgres 13+ has gen_random_uuid() built in; this adds the other variants.",
    category: "utility",
  },
  {
    name: "hstore",
    title: "hstore",
    description: "Key/value pairs in a single column. Largely superseded by jsonb.",
    category: "utility",
  },
  {
    name: "citext",
    title: "citext",
    description: "Case-insensitive text type, for things like email addresses.",
    category: "utility",
  },
  {
    name: "pg_trgm",
    title: "pg_trgm",
    description: "Trigram matching for fuzzy text search and similarity ranking.",
    category: "search",
  },
  {
    name: "btree_gin",
    title: "btree_gin",
    description: "GIN operator classes for scalar types, so one index can mix them with arrays or jsonb.",
    category: "search",
  },
  {
    name: "unaccent",
    title: "unaccent",
    description: "Strips accents from text, usually paired with full-text search.",
    category: "search",
  },
];

const BY_NAME = new Map(EXTENSION_CATALOGUE.map((e) => [e.name, e]));

export function metaFor(name: string): ExtensionMeta | undefined {
  return BY_NAME.get(name);
}

/** Does enabling this extension require restarting the database? */
export function requiresRestart(name: string): boolean {
  return metaFor(name)?.preloadLibrary !== undefined;
}
