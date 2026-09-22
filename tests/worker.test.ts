import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema";
import { persistConnection, persistIncoming } from "../src/functions/worker";
import { secretHash } from "../src/modules/telegram/crypto";
import { telegram } from "../src/modules/telegram/client";

vi.mock("../src/modules/telegram/crypto", () => ({ decryptToken: async () => "fake-token", secretHash: (value: string) => value === "code" ? "code-hash" : "code-hash" }));
vi.mock("../src/modules/telegram/client", () => ({ telegram: vi.fn() }));

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

  it("discovers a group through the official bot without creating a community", async () => {
    const organizationId = randomUUID();
    await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.test" });
    await db.insert(schema.organizations).values({ id: organizationId, ownerUserId: "owner", name: "Workspace" });
    const [bot] = await db.insert(schema.botConnections).values({ organizationId: null, scope: "SYSTEM", externalId: "10", username: "bot", encryptedToken: "ciphertext", webhookSecretHash: "hash", status: "active" }).returning();
    const [attempt] = await db.insert(schema.communityConnectionAttempts).values({ organizationId, botConnectionId: bot.id, createdBy: "owner", codeHash: secretHash("code"), expiresAt: new Date(Date.now() + 60_000) }).returning();
    vi.mocked(telegram).mockImplementation(async (_token, method) => method === "getChat" ? { id: -100456, type: "supergroup", title: "Group" } as never : { status: "administrator", can_delete_messages: true, can_restrict_members: true } as never);

    await persistConnection(db, { kind: "connection", botId: bot.id, connection: { codeHash: secretHash("code"), telegramUserId: "42", externalId: "-100456", chatType: "supergroup", messageId: "8" } });
    const [saved] = await db.select().from(schema.communityConnectionAttempts).where(eq(schema.communityConnectionAttempts.id, attempt.id));
    expect(saved).toMatchObject({ state: "DISCOVERED", candidateExternalId: "-100456", candidateName: "Group", botIsAdmin: true, userIsAdmin: true });
    expect(await db.select().from(schema.communities)).toHaveLength(0);
  });
});
