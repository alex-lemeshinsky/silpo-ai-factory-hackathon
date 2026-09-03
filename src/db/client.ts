import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getServerEnv } from "@/lib/env";
import * as schema from "./schema";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as { dbClient?: DbClient };

export function createDbClient(connectionString?: string): DbClient {
  let url = connectionString;
  if (!url) {
    try {
      url = getServerEnv().DATABASE_URL;
    } catch {
      url = process.env.DATABASE_URL;
    }
  }
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const queryClient = postgres(url);
  return drizzle(queryClient, { schema });
}

export function getDbClient(): DbClient {
  if (!globalForDb.dbClient) {
    globalForDb.dbClient = createDbClient();
  }
  return globalForDb.dbClient;
}
