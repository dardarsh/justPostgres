import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Only used by drizzle-kit for introspection/push; migrations at runtime are
  // applied by src/db/migrate.ts against JP_DATA_DIR.
  dbCredentials: { url: process.env.JP_SQLITE_URL ?? "./data/justpostgres.sqlite" },
});
