import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema";
import { moderateMessage } from "../src/modules/moderation/service";
import type { ModerationEngine } from "../src/modules/moderation/jev";
import { telegram, TelegramError } from "../src/modules/telegram/client";

vi.mock("../src/modules/telegram/crypto", () => ({ decryptToken: async () => "fake-token" }));
vi.mock("../src/modules/telegram/client", async (original) => ({ ...await original<typeof import("../src/modules/telegram/client")>(), telegram: vi.fn() }));

const client = new PGlite();
const db = drizzle(client, { schema });
const evaluate = vi.fn<ModerationEngine>();
let orgId: string;
let communityId: string;
let botId: string;

beforeAll(async () => { await migrate(db, { migrationsFolder: "drizzle" }); });
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  await db.execute(sql.raw("TRUNCATE users, organizations, communities, moderation_messages, usage_monthly CASCADE"));
  vi.clearAllMocks();
  orgId = randomUUID(); communityId = randomUUID();
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.test" });
  await db.insert(schema.organizations).values({ id: orgId, ownerUserId: "owner", name: "Workspace" });
  const [bot] = await db.insert(schema.botConnections).values({ organizationId: orgId, externalId: "10", username: "test_bot", encryptedToken: "ciphertext", webhookSecretHash: "hash", status: "active" }).returning();
  botId = bot.id;
  await db.insert(schema.communities).values({ id: communityId, organizationId: orgId, botConnectionId: botId, externalId: "-100123", name: "Community", telegramChatType: "supergroup", moderationEnabled: true, publicWarningsEnabled: true });
  evaluate.mockImplementation(async (_text, rules) => ({ evaluations: rules.map((r) => ({ ruleId: r.id, probability: 0.99 })), model: "test-model", inputTokens: 42, latencyMs: 3 }));
  vi.mocked(telegram).mockImplementation(async (_token, method) => (method === "getChatMember" ? { status: "member" } : true) as never);
});

async function addRule(action: "WARN" | "MUTE" | "BAN", options: Partial<typeof schema.moderationRules.$inferInsert> = {}) {
  const [rule] = await db.insert(schema.moderationRules).values({ communityId, name: action, ruleText: "Rule " + action, action, actionDurationSeconds: action === "MUTE" ? 3600 : null, createdBy: "owner", ...options }).returning();
  return rule;
}
async function addMessage(platformMessageId: string, platformUserId = "22", revision = 1, sentAt = new Date()) {
  const [message] = await db.insert(schema.moderationMessages).values({ communityId, platformMessageId, platformUserId, revision, text: "Example", sentAt }).returning();
  return message;
}

describe("moderation decision and execution", () => {
  it("persists a MATCHED decision with independent WARN and DELETE executions", async () => {
    const rule = await addRule("WARN", { deleteMessage: true });
    const message = await addMessage("1");
    await moderateMessage(db, message.id, evaluate);
    expect((await db.select().from(schema.moderationDecisions))[0].state).toBe("MATCHED");
    expect((await db.select().from(schema.moderationWarnings))[0].warningNumber).toBe(1);
    expect((await db.select().from(schema.moderationActions)).map((item) => item.action).sort()).toEqual(["DELETE", "WARN"]);
    expect((await db.select().from(schema.moderationActions)).every((item) => item.status === "SUCCESS")).toBe(true);
    expect(vi.mocked(telegram).mock.calls.map(([, method]) => method)).toEqual(["getChatMember", "sendMessage", "deleteMessage"]);
    expect(rule.action).toBe("WARN");
  });
  it.each([[0.75, "REVIEW"], [0.94999, "REVIEW"], [0.95, "MATCHED"]])("applies exact threshold %s as %s", async (probability, state) => {
    const rule = await addRule("WARN");
    const message = await addMessage(String(probability));
    evaluate.mockResolvedValue({ evaluations: [{ ruleId: rule.id, probability }], model: "test", inputTokens: 1, latencyMs: 1 });
    await moderateMessage(db, message.id, evaluate);
    expect((await db.select().from(schema.moderationDecisions))[0].state).toBe(state);
  });
  it("accumulates warnings and applies mute on warning three and ban on warning four", async () => {
    await db.update(schema.communities).set({ warningMuteAt: 3, warningBanAt: 4, warningMuteDurationSeconds: 3600, warningBanDurationSeconds: null }).where(eq(schema.communities.id, communityId));
    await addRule("WARN");
    for (let index = 1; index <= 4; index += 1) await moderateMessage(db, (await addMessage(String(index))).id, evaluate);
    const warnings = await db.select().from(schema.moderationWarnings);
    const actions = await db.select().from(schema.moderationActions);
    expect(warnings.map((item) => item.warningNumber)).toEqual([1, 2, 3, 4]);
    expect(actions.map((item) => item.action)).toEqual(["WARN", "WARN", "MUTE", "BAN"]);
    expect(vi.mocked(telegram).mock.calls.map(([, method]) => method)).toContain("restrictChatMember");
    expect(vi.mocked(telegram).mock.calls.map(([, method]) => method)).toContain("banChatMember");
  });
  it("does not add another warning when an edited message is evaluated again", async () => {
    await addRule("WARN");
    const first = await addMessage("edited", "22", 1);
    await moderateMessage(db, first.id, evaluate);
    const second = await addMessage("edited", "22", 2);
    await moderateMessage(db, second.id, evaluate);
    expect(await db.select().from(schema.moderationWarnings)).toHaveLength(1);
  });
  it("chooses direct BAN over escalation and keeps DELETE independent", async () => {
    await db.update(schema.communities).set({ warningMuteAt: 1, warningBanAt: 2 }).where(eq(schema.communities.id, communityId));
    await addRule("WARN", { priority: 900 });
    await addRule("BAN", { priority: 1, deleteMessage: true });
    const message = await addMessage("direct-ban");
    await moderateMessage(db, message.id, evaluate);
    expect((await db.select().from(schema.moderationActions)).map((item) => item.action).sort()).toEqual(["BAN", "DELETE"]);
    expect((await db.select().from(schema.moderationWarnings)).length).toBe(1);
  });
  it("skips MUTE for a basic group without blocking DELETE", async () => {
    await db.update(schema.communities).set({ telegramChatType: "group" }).where(eq(schema.communities.id, communityId));
    await addRule("MUTE", { deleteMessage: true });
    const message = await addMessage("basic-group");
    await moderateMessage(db, message.id, evaluate);
    const actions = await db.select().from(schema.moderationActions);
    expect(actions.find((item) => item.action === "MUTE")?.status).toBe("SKIPPED");
    expect(actions.find((item) => item.action === "DELETE")?.status).toBe("SUCCESS");
  });
  it("still evaluates old messages and skips only DELETE after Telegram's deletion window", async () => {
    await addRule("WARN", { deleteMessage: true });
    const message = await addMessage("old", "22", 1, new Date(Date.now() - 49 * 3_600_000));
    await moderateMessage(db, message.id, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.moderationActions)).find((item) => item.action === "DELETE")?.status).toBe("SKIPPED");
    expect((await db.select().from(schema.moderationActions)).find((item) => item.action === "WARN")?.status).toBe("SUCCESS");
  });
  it("keeps a warning counted while public warning execution is disabled", async () => {
    await db.update(schema.communities).set({ publicWarningsEnabled: false }).where(eq(schema.communities.id, communityId));
    await addRule("WARN");
    const message = await addMessage("private-warning");
    await moderateMessage(db, message.id, evaluate);
    expect(await db.select().from(schema.moderationWarnings)).toHaveLength(1);
    expect((await db.select().from(schema.moderationActions))[0].status).toBe("SKIPPED");
    expect(vi.mocked(telegram).mock.calls.map(([, method]) => method)).toEqual(["getChatMember"]);
  });
  it("executes DELETE even when the message has no identifiable user", async () => {
    await addRule("BAN", { deleteMessage: true });
    const message = await addMessage("unknown-user", "", 1);
    await moderateMessage(db, message.id, evaluate);
    const actions = await db.select().from(schema.moderationActions);
    expect(actions.find((item) => item.action === "BAN")?.status).toBe("SKIPPED");
    expect(actions.find((item) => item.action === "DELETE")?.status).toBe("SUCCESS");
  });
  it("retries a temporary punishment failure without repeating a completed DELETE", async () => {
    await addRule("WARN", { deleteMessage: true });
    const message = await addMessage("retry");
    vi.mocked(telegram).mockImplementationOnce(async () => ({ status: "member" }) as never).mockImplementationOnce(async () => { throw new TelegramError(429, "Rate limited"); }).mockResolvedValue(true);
    await expect(moderateMessage(db, message.id, evaluate)).rejects.toThrow();
    await moderateMessage(db, message.id, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(1);
    const actions = await db.select().from(schema.moderationActions);
    expect(actions.find((item) => item.action === "WARN")?.status).toBe("SUCCESS");
    expect(actions.find((item) => item.action === "DELETE")?.status).toBe("SUCCESS");
  });
});
