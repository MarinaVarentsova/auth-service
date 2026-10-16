import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

// Dedicated bounded pool for read-only session checks; legacy pool is unchanged.
export const sessionVerificationPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 3000,
  query_timeout: 4000,
  idleTimeoutMillis: 10000,
});
sessionVerificationPool.on("error", () => {}); // Never log connection secrets.

export * from "./schema";
