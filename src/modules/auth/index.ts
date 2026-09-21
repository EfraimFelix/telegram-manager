import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb } from "../../db";
import * as schema from "../../db/schema";
import { appSecrets, required } from "../../lib/config";

async function createAuth() {
  const { key } = await appSecrets();
  if (key.length < 32) throw new Error("Application secret must be at least 32 characters");
  const baseURL = required("BETTER_AUTH_URL");
  return betterAuth({
    secret: key, baseURL,
    database: drizzleAdapter(getDb(), { provider: "pg", schema, transaction: true }),
    emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
    trustedOrigins: [new URL(baseURL).origin],
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 100, customRules: {
      "/sign-in/email": { window: 60, max: 10 }, "/sign-up/email": { window: 60, max: 5 },
    } },
    logger: { disabled: true },
  });
}

let pending: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  pending ??= createAuth().catch((error) => { pending = undefined; throw error; });
  return pending;
}
