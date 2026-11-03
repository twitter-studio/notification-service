import { defineConfig } from "drizzle-kit";

// migration は drizzle-kit で schema.ts から作り、wrangler の d1 migrations で当てる。手で書いた SQL と schema.ts がずれないようにするため。
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
