import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getServerEnv } from "@/lib/env";
import * as schema from "./schema";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as { dbClient?: DbClient };

export function createDbClient(connectionString?: string): DbClient {
  const url = connectionString ?? getServerEnv().DATABASE_URL;
  const queryClient = postgres(url);
  return drizzle(queryClient, { schema });
}

export function getDbClient(): DbClient {
  if (!globalForDb.dbClient) {
    globalForDb.dbClient = createDbClient();
  }
  return globalForDb.dbClient;
}
