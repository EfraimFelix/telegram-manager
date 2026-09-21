import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema";
import { persistIncoming } from "../src/functions/worker";

const client = new PGlite();
const db = drizzle(client, { schema });

beforeAll(async () => { await migrate(db, { migrationsFolder: "drizzle" }); });
afterAll(async () => { await client.close(); });
beforeEach(async () => { await db.execute(sql`TRUNCATE users, organizations, communities, moderation_messages, usage_monthly CASCADE`); });

describe("worker ingestion", () => {
  it("persists a message and received usage exactly once", async () => {
    const organizationId = randomUUID();
    await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.test" });
    await db.insert(schema.organizations).values({ id: organizationId, ownerUserId: "owner", name: "Workspace" });
    const [bot] = await db.insert(schema.botConnections).values({
      organizationId, externalId: "10", username: "bot", encryptedToken: "ciphertext", webhookSecretHash: "hash", status: "active",
    }).returning();
    await db.insert(schema.communities).values({ organizationId, botConnectionId: bot.id, externalId: "-100123", name: "Group" });
    const job = {
      botId: bot.id,
      message: { platformMessageId: "7", platformUserId: "42", externalId: "-100123", revision: 1, text: "Hello", messageType: "text" as const, sentAt: new Date() },
    };

    expect(await persistIncoming(db, job)).toEqual(await persistIncoming(db, job));
    expect(await db.select().from(schema.moderationMessages)).toHaveLength(1);
    expect(await db.select().from(schema.usageMonthly)).toMatchObject([{ messagesReceived: 1 }]);
  });
});
