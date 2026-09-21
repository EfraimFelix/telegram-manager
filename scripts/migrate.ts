import "dotenv/config";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { drizzle as dataApi } from "drizzle-orm/aws-data-api/pg";
import { migrate as migrateDataApi } from "drizzle-orm/aws-data-api/pg/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { required } from "../src/lib/config";

async function main() {
  if (process.env.DB_RESOURCE_ARN) {
    const client = new RDSDataClient({ maxAttempts: 3 });
    try {
      await migrateDataApi(dataApi(client, { database: required("DB_NAME"), resourceArn: required("DB_RESOURCE_ARN"), secretArn: required("DB_SECRET_ARN") }), { migrationsFolder: "drizzle" });
    } finally { client.destroy(); }
  } else {
    const client = postgres(required("DATABASE_URL"), { max: 1 });
    try { await migrate(drizzle(client), { migrationsFolder: "drizzle" }); }
    finally { await client.end(); }
  }
  console.log("Database migrations applied.");
}
main().catch(() => { console.error("Migration failed. Check database availability, configuration and IAM permissions."); process.exitCode = 1; });
