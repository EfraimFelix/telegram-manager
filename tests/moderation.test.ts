import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../src/db/schema";
import { moderateMessage } from "../src/modules/moderation/service";
import { monthStart } from "../src/modules/usage/limits";
import { telegram, TelegramError } from "../src/modules/telegram/client";
import type { ModerationEngine } from "../src/modules/moderation/jev";

vi.mock("../src/modules/telegram/crypto", () => ({ decryptToken: async () => "fake-token" }));
vi.mock("../src/modules/telegram/client", async (original) => ({ ...await original<typeof import("../src/modules/telegram/client")>(), telegram: vi.fn() }));
const client = new PGlite();
const db = drizzle(client, { schema: s });
let orgId: string, communityId: string, ruleId: string, messageId: string;
const evaluate = vi.fn<ModerationEngine>();

beforeAll(async () => { await migrate(db, { migrationsFolder: "drizzle" }); });
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, organizations, communities, moderation_messages, usage_monthly CASCADE`);
  vi.clearAllMocks();
  await db.insert(s.user).values({ id: "owner", name: "Owner", email: "owner@example.test" });
  [orgId, communityId, ruleId, messageId] = Array.from({ length: 4 }, () => randomUUID());
  await db.insert(s.organizations).values({ id: orgId, ownerUserId: "owner", name: "Workspace" });
  const [bot] = await db.insert(s.botConnections).values({ organizationId: orgId, externalId: "10", username: "test_bot", encryptedToken: "ciphertext", webhookSecretHash: "hash", status: "active" }).returning();
  await db.insert(s.communities).values({ id: communityId, organizationId: orgId, botConnectionId: bot.id, externalId: "-100123", name: "Community", moderationEnabled: true });
  await db.insert(s.moderationRules).values({ id: ruleId, communityId, name: "No politics", ruleText: "Political discussions are not allowed.", action: "DELETE", priority: 300, createdBy: "owner" });
  await db.insert(s.moderationMessages).values({ id: messageId, communityId, platformMessageId: "1", revision: 1, text: "Example", sentAt: new Date() });
  evaluate.mockImplementation(async (_text, rules) => ({ evaluations: rules.map((r) => ({ ruleId: r.id, probability: 0.99 })), model: "test-model", inputTokens: 42, latencyMs: 3 }));
  vi.mocked(telegram).mockResolvedValue(true);
});

describe("processing against PostgreSQL", () => {
  it("stores evaluations, decisions, external action and usage once across duplicate deliveries", async () => {
    await moderateMessage(db, messageId, evaluate);
    await moderateMessage(db, messageId, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(await db.select().from(s.moderationRuleEvaluations)).toHaveLength(1);
    expect((await db.select().from(s.moderationActions))[0].status).toBe("success");
    expect((await db.select().from(s.usageMonthly))[0]).toMatchObject({ messagesModerated: 1, jevRequests: 1, actionsDelete: 1, jevInputTokens: 42 });
  });
  it("uncertainty creates REVIEW and never calls Telegram", async () => {
    evaluate.mockResolvedValue({ evaluations: [{ ruleId, probability: 0.82 }], model: "test", inputTokens: 20, latencyMs: 1 });
    await moderateMessage(db, messageId, evaluate);
    expect((await db.select().from(s.moderationDecisions))[0].action).toBe("REVIEW");
    expect(telegram).not.toHaveBeenCalled();
  });
  it.each(["disabled", "no-rules", "inactive", "quota", "superseded"])("skips inference and charging for %s", async (scenario) => {
    if (scenario === "disabled") await db.update(s.communities).set({ moderationEnabled: false });
    if (scenario === "no-rules") await db.update(s.moderationRules).set({ enabled: false });
    if (scenario === "inactive") await db.update(s.organizations).set({ status: "suspended" });
    if (scenario === "quota") await db.insert(s.usageMonthly).values({ organizationId: orgId, yearMonth: monthStart(), messagesModerated: 5000 });
    if (scenario === "superseded") await db.insert(s.moderationMessages).values({ communityId, platformMessageId: "1", revision: 2, text: "Edited", sentAt: new Date() });
    await moderateMessage(db, messageId, evaluate);
    expect(evaluate).not.toHaveBeenCalled();
    expect(telegram).not.toHaveBeenCalled();
    expect((await db.select().from(s.moderationDecisions))[0].evaluated).toBe(false);
    expect((await db.select().from(s.usageMonthly))[0].jevRequests).toBe(0);
  });
  it("fails open and rolls back on provider failure", async () => {
    evaluate.mockRejectedValue(new Error("Provider unavailable"));
    await expect(moderateMessage(db, messageId, evaluate)).rejects.toThrow();
    expect(telegram).not.toHaveBeenCalled();
    expect(await db.select().from(s.moderationDecisions)).toHaveLength(0);
    expect(await db.select().from(s.moderationRuleEvaluations)).toHaveLength(0);
  });
  it("retries deletion without reevaluating or charging twice", async () => {
    vi.mocked(telegram).mockRejectedValueOnce(new TelegramError(429, "Rate limited", 1));
    await expect(moderateMessage(db, messageId, evaluate)).rejects.toThrow();
    await moderateMessage(db, messageId, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(telegram).toHaveBeenCalledTimes(2);
    expect((await db.select().from(s.usageMonthly))[0].messagesModerated).toBe(1);
  });
  it("treats already deleted messages as successful on recovery", async () => {
    vi.mocked(telegram).mockRejectedValue(new TelegramError(400, "Bad Request: message to delete not found"));
    await moderateMessage(db, messageId, evaluate);
    expect((await db.select().from(s.moderationActions))[0].status).toBe("success");
  });
  it("records permission failures without retrying forever", async () => {
    vi.mocked(telegram).mockRejectedValue(new TelegramError(403, "Forbidden: bot was removed"));
    await moderateMessage(db, messageId, evaluate);
    await moderateMessage(db, messageId, evaluate);
    expect((await db.select().from(s.moderationActions))[0].status).toBe("failed");
    expect(telegram).toHaveBeenCalledTimes(1);
  });
  it("preserves rule text and action after the rule is edited", async () => {
    await moderateMessage(db, messageId, evaluate);
    await db.update(s.moderationRules).set({ ruleText: "New rule", action: "REVIEW", deletedAt: new Date() }).where(eq(s.moderationRules.id, ruleId));
    expect((await db.select().from(s.moderationRuleEvaluations))[0]).toMatchObject({ ruleText: "Political discussions are not allowed.", configuredAction: "DELETE" });
  });
  it("a new UTC month has an independent quota", async () => {
    await db.insert(s.usageMonthly).values({ organizationId: orgId, yearMonth: "2020-01-01", messagesModerated: 5000 });
    await moderateMessage(db, messageId, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid responses before saving a decision", async () => {
    evaluate.mockResolvedValue({ evaluations: [], model: "test", inputTokens: 10, latencyMs: 2 });
    await expect(moderateMessage(db, messageId, evaluate)).rejects.toThrow();
    expect(telegram).not.toHaveBeenCalled();
  });
});
