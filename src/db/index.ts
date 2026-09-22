import { drizzle as pg } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { required } from "../lib/config";
import * as schema from "./schema";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
let database: Database | undefined;
export function getDb(): Database {
  if (database) return database;
  database = pg(postgres(required("DATABASE_URL"), { max: 5, prepare: false }), { schema });
  return database;
}
