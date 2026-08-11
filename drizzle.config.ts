import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    // `||` (not `??`) so an empty env var falls back too, giving a clean
    // connection error instead of "Invalid URL" when DATABASE_URL is unset.
    url: process.env.DATABASE_URL || "postgres://localhost:5432/placeholder",
  },
});
