import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle workspace source packages (@justpostgres/shared) but leave native
  // and heavyweight runtime deps to node_modules.
  noExternal: [/^@justpostgres\//],
  external: ["better-sqlite3", "dockerode", "pino", "pino-pretty"],
});
