import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

let globalClient: DbClient | undefined;

export function createDbClient(connectionString?: string): DbClient {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const queryClient = postgres(url);
  return drizzle(queryClient, { schema });
}

export function getDbClient(): DbClient {
  if (!globalClient) {
    globalClient = createDbClient();
  }
  return globalClient;
}
