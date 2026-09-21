import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { drizzle as dataApi } from "drizzle-orm/aws-data-api/pg";
import { drizzle as pg } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { required } from "../lib/config";
import * as schema from "./schema";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
let database: Database | undefined;
export function getDb(): Database {
  if (database) return database;
  database = process.env.DB_RESOURCE_ARN
    ? dataApi(new RDSDataClient({ maxAttempts: 3 }), { schema, database: required("DB_NAME"), resourceArn: required("DB_RESOURCE_ARN"), secretArn: required("DB_SECRET_ARN") })
    : pg(postgres(required("DATABASE_URL"), { max: 5, prepare: false }), { schema });
  return database;
}
