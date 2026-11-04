import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/qa-schema.ts",
  out: "../../apps/api/qa/migrations",
});
