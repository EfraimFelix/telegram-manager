import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { required } from "../src/lib/config";

async function main() {
  const client = postgres(required("DATABASE_URL"), { max: 1 });
  try { await migrate(drizzle(client), { migrationsFolder: "drizzle" }); }
  finally { await client.end(); }
  console.log("Database migrations applied.");
}
main().catch((error: unknown) => {
  console.error("Migration failed. Check database availability, configuration and IAM permissions.");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
