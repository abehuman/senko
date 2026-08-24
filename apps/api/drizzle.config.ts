import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	out: "./db/migrations",
	schema: "./src/db/schema.ts",
	strict: true,
	verbose: true,
});
