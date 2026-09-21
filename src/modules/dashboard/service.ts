import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  botConnections, communities, moderationActions, moderationDecisions, moderationFeedback,
  moderationMessages, moderationRuleEvaluations, moderationRules, organizations, ruleTestUsage, usageMonthly,
} from "../../db/schema";
import { required } from "../../lib/config";
import { evaluateRules } from "../moderation/jev";
import { decide } from "../moderation/policy";
import { telegram } from "../telegram/client";
import { decryptToken, encryptToken, secretHash, webhookSecret } from "../telegram/crypto";
import { FREE_LIMITS, monthStart } from "../usage/limits";
import { lockOrganization, type Actor } from "./access";
import type { DashboardData, TestRulesResult } from "./contracts";
import type { DashboardCommand } from "./validation";
import { AppError } from "./http";

type TelegramUser = { id: number; is_bot: boolean; username?: string };
type TelegramChat = { id: number; type: string; title?: string; username?: string };
type TelegramMember = { status: string; can_delete_messages?: boolean };

export async function dashboardData(actor: Actor, organizationId: string): Promise<DashboardData> {
  const db = getDb();
  const month = monthStart();
  const today = new Date().toISOString().slice(0, 10);
  const [organization, bot, communityRows, ruleRows, usage, tests] = await Promise.all([
    db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).then(([row]) => row),
    db.select({ id: botConnections.id, username: botConnections.username, status: botConnections.status }).from(botConnections).where(eq(botConnections.organizationId, organizationId)).then(([row]) => row ?? null),
    db.select().from(communities).where(eq(communities.organizationId, organizationId)).orderBy(communities.createdAt),
    db.select({ rule: moderationRules }).from(moderationRules).innerJoin(communities, eq(communities.id, moderationRules.communityId))
      .where(and(eq(communities.organizationId, organizationId), isNull(moderationRules.deletedAt))).orderBy(desc(moderationRules.priority)),
    db.select().from(usageMonthly).where(and(eq(usageMonthly.organizationId, organizationId), eq(usageMonthly.yearMonth, month))).then(([row]) => row),
    db.select({ count: ruleTestUsage.count }).from(ruleTestUsage).where(and(eq(ruleTestUsage.organizationId, organizationId), eq(ruleTestUsage.day, today))).then(([row]) => row?.count ?? 0),
  ]);
  const messages = await db.select({ message: moderationMessages, communityName: communities.name })
    .from(moderationMessages).innerJoin(communities, eq(communities.id, moderationMessages.communityId))
    .where(eq(communities.organizationId, organizationId)).orderBy(desc(moderationMessages.receivedAt)).limit(50);
  const messageIds = messages.map(({ message }) => message.id);
  const decisions = messageIds.length ? await db.select().from(moderationDecisions).where(inArray(moderationDecisions.messageId, messageIds)) : [];
  const decisionIds = decisions.map((item) => item.id);
  const [evaluations, actions, feedback] = await Promise.all([
    messageIds.length ? db.select().from(moderationRuleEvaluations).where(inArray(moderationRuleEvaluations.messageId, messageIds)) : [],
    decisionIds.length ? db.select().from(moderationActions).where(inArray(moderationActions.decisionId, decisionIds)) : [],
    decisionIds.length ? db.select().from(moderationFeedback).where(inArray(moderationFeedback.decisionId, decisionIds)) : [],
  ]);
  const decisionByMessage = new Map(decisions.map((item) => [item.messageId, item]));
  const actionByDecision = new Map(actions.map((item) => [item.decisionId, item]));
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - 6);
  const activity = await db.select({ receivedAt: moderationMessages.receivedAt, decision: moderationDecisions.action, evaluated: moderationDecisions.evaluated })
    .from(moderationMessages).innerJoin(communities, eq(communities.id, moderationMessages.communityId))
    .leftJoin(moderationDecisions, eq(moderationDecisions.messageId, moderationMessages.id))
    .where(and(eq(communities.organizationId, organizationId), gte(moderationMessages.receivedAt, since)));
  const dailyStats = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(since); date.setUTCDate(since.getUTCDate() + offset);
    return { date: date.toISOString().slice(0, 10), received: 0, moderated: 0, deleted: 0, review: 0, allowed: 0 };
  });
  for (const item of activity) {
    const day = dailyStats.find((entry) => entry.date === item.receivedAt.toISOString().slice(0, 10));
    if (!day) continue;
    day.received += 1;
    if (item.evaluated) day.moderated += 1;
    if (item.decision === "DELETE") day.deleted += 1;
    if (item.decision === "REVIEW") day.review += 1;
    if (item.decision === "ALLOW") day.allowed += 1;
  }
  const emptyUsage = { yearMonth: month, messagesReceived: 0, messagesModerated: 0, jevRequests: 0, jevInputTokens: 0, ruleEvaluations: 0, actionsDelete: 0, actionsReview: 0, actionsAllow: 0 };
  const currentUsage = usage ?? emptyUsage;
  return {
    user: { name: actor.name, email: actor.email }, organization: organization ?? { id: organizationId, name: `${actor.name}'s workspace` }, bot,
    communities: communityRows.map(({ id, name, externalId, username, status, moderationEnabled }) => ({ id, name, externalId, username, status, moderationEnabled })),
    rules: ruleRows.map(({ rule }) => ({ id: rule.id, communityId: rule.communityId, name: rule.name, ruleText: rule.ruleText, action: rule.action as "DELETE" | "REVIEW", priority: rule.priority, enabled: rule.enabled })),
    usage: { ...currentUsage, testsToday: tests }, limits: { communities: FREE_LIMITS.communities, enabledRules: FREE_LIMITS.activeRules, messagesPerMonth: FREE_LIMITS.messages, testsPerDay: FREE_LIMITS.ruleTestsPerDay },
    recentLogs: messages.map(({ message, communityName }) => {
      const decision = decisionByMessage.get(message.id);
      const action = decision ? actionByDecision.get(decision.id) : undefined;
      return { id: message.id, communityId: message.communityId, communityName, platformUserId: message.platformUserId, text: message.text, receivedAt: message.receivedAt.toISOString(), processingStatus: message.processingStatus,
        decision: decision ? { id: decision.id, action: decision.action, winningRuleId: decision.winningRuleId, reason: decision.reason, policyVersion: decision.policyVersion,
          inputTokens: decision.inputTokens, latencyMs: decision.latencyMs, evaluated: decision.evaluated } : null,
        evaluations: evaluations.filter((item) => item.messageId === message.id),
        action: action ? { action: action.action, status: action.status, executedAt: action.executedAt?.toISOString() ?? null } : null,
        feedback: decision ? feedback.filter((item) => item.decisionId === decision.id).map((item) => ({ expectedAction: item.expectedAction, comment: item.comment, createdAt: item.createdAt.toISOString() })) : [],
      };
    }), dailyStats,
    costEstimate: { currency: "USD", inputTokens: currentUsage.jevInputTokens, pricePerMillionTokens: 0.042, estimatedUsd: currentUsage.jevInputTokens / 1_000_000 * 0.042 },
  };
}

export async function executeDashboardCommand(actor: Actor, organizationId: string, command: DashboardCommand) {
  switch (command.action) {
    case "connectBot": return connectBot(actor, organizationId, command.token);
    case "addCommunity": return addCommunity(actor, organizationId, command.chatId);
    case "toggleModeration": return toggleModeration(actor, organizationId, command.communityId, command.enabled);
    case "saveRule": return saveRule(actor, organizationId, command);
    case "deleteRule": return deleteRule(actor, organizationId, command.id);
    case "testRules": return testRules(actor, organizationId, command.communityId, command.text);
    case "feedback": return saveFeedback(actor, organizationId, command.decisionId, command.expectedAction, command.comment);
  }
}

async function connectBot(actor: Actor, organizationId: string, token: string) {
  const db = getDb();
  const me = await telegram<TelegramUser>(token, "getMe");
  if (!me.is_bot || !me.username) throw new AppError(400, "INVALID_BOT", "Telegram did not return a valid bot account.");
  const encryptedToken = await encryptToken(token);
  const botId = await db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId, actor);
    const [claimed] = await tx.select().from(botConnections).where(eq(botConnections.externalId, String(me.id)));
    if (claimed && claimed.organizationId !== organizationId) throw new AppError(409, "BOT_IN_USE", "This bot is connected to another workspace.");
    const [current] = await tx.select().from(botConnections).where(eq(botConnections.organizationId, organizationId));
    if (current && current.externalId !== String(me.id)) throw new AppError(409, "BOT_REPLACEMENT_UNSUPPORTED", "This workspace is already connected to a different bot.");
    const id = current?.id ?? randomUUID();
    const values = { externalId: String(me.id), username: me.username!, encryptedToken, webhookSecretHash: secretHash(await webhookSecret(id)), status: "pending" };
    if (current) await tx.update(botConnections).set(values).where(eq(botConnections.id, current.id));
    else await tx.insert(botConnections).values({ id, organizationId, ...values });
    return id;
  });
  const base = required("WEBHOOK_BASE_URL").replace(/\/?$/, "/");
  await telegram<boolean>(token, "setWebhook", { url: `${base}${botId}`, secret_token: await webhookSecret(botId), allowed_updates: ["message", "edited_message"], max_connections: 20 });
  await db.update(botConnections).set({ status: "active" }).where(eq(botConnections.id, botId));
  return { ok: true } as const;
}

async function addCommunity(actor: Actor, organizationId: string, chatId: string) {
  const db = getDb();
  const [bot] = await db.select().from(botConnections).where(eq(botConnections.organizationId, organizationId));
  if (!bot || bot.status !== "active") throw new AppError(409, "BOT_REQUIRED", "Connect the bot before adding a community.");
  const token = await decryptToken(bot.encryptedToken);
  const chat = await telegram<TelegramChat>(token, "getChat", { chat_id: chatId });
  if (!['group', 'supergroup'].includes(chat.type)) throw new AppError(400, "INVALID_CHAT", "Choose a Telegram group or supergroup.");
  const member = await telegram<TelegramMember>(token, "getChatMember", { chat_id: chat.id, user_id: Number(bot.externalId) });
  if (!['administrator', 'creator'].includes(member.status) || (member.status !== 'creator' && member.can_delete_messages !== true)) {
    throw new AppError(400, "BOT_PERMISSIONS", "Make the bot an administrator with permission to delete messages.");
  }
  await db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId, actor);
    const [{ value: total }] = await tx.select({ value: count() }).from(communities).where(eq(communities.organizationId, organizationId));
    if (total >= FREE_LIMITS.communities) throw new AppError(409, "COMMUNITY_LIMIT", "The free plan includes one community.");
    const [claimed] = await tx.select().from(communities).where(and(eq(communities.platform, "telegram"), eq(communities.externalId, String(chat.id))));
    if (claimed) throw new AppError(409, "COMMUNITY_IN_USE", "This community is already connected.");
    await tx.insert(communities).values({ organizationId, botConnectionId: bot.id, externalId: String(chat.id), name: chat.title ?? chat.username ?? "Telegram community", username: chat.username });
  });
  return { ok: true } as const;
}

async function toggleModeration(actor: Actor, organizationId: string, communityId: string, enabled: boolean) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId, actor);
    const [community] = await tx.select().from(communities).where(and(eq(communities.id, communityId), eq(communities.organizationId, organizationId)));
    if (!community) throw new AppError(404, "COMMUNITY_NOT_FOUND", "Community not found.");
    if (enabled) {
      const [{ value }] = await tx.select({ value: count() }).from(moderationRules).where(and(eq(moderationRules.communityId, communityId), eq(moderationRules.enabled, true), isNull(moderationRules.deletedAt)));
      if (!value) throw new AppError(409, "RULE_REQUIRED", "Enable at least one rule first.");
    }
    await tx.update(communities).set({ moderationEnabled: enabled }).where(eq(communities.id, communityId));
  });
  return { ok: true } as const;
}

async function saveRule(actor: Actor, organizationId: string, command: Extract<DashboardCommand, { action: "saveRule" }>) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId, actor);
    const [community] = await tx.select().from(communities).where(and(eq(communities.id, command.communityId), eq(communities.organizationId, organizationId)));
    if (!community) throw new AppError(404, "COMMUNITY_NOT_FOUND", "Community not found.");
    const [existing] = command.id ? await tx.select().from(moderationRules).where(and(eq(moderationRules.id, command.id), eq(moderationRules.communityId, community.id), isNull(moderationRules.deletedAt))) : [];
    if (command.id && !existing) throw new AppError(404, "RULE_NOT_FOUND", "Rule not found.");
    if (command.enabled && !existing?.enabled) {
      const [{ value }] = await tx.select({ value: count() }).from(moderationRules).where(and(eq(moderationRules.communityId, community.id), eq(moderationRules.enabled, true), isNull(moderationRules.deletedAt)));
      if (value >= FREE_LIMITS.activeRules) throw new AppError(409, "RULE_LIMIT", "The free plan includes three active rules.");
    }
    const values = { name: command.name, ruleText: command.ruleText, action: command.ruleAction, priority: command.priority, enabled: command.enabled };
    if (existing) await tx.update(moderationRules).set(values).where(eq(moderationRules.id, existing.id));
    else await tx.insert(moderationRules).values({ communityId: community.id, createdBy: actor.id, ...values });
  });
  return { ok: true } as const;
}

async function deleteRule(actor: Actor, organizationId: string, ruleId: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId, actor);
    const [rule] = await tx.select({ id: moderationRules.id }).from(moderationRules).innerJoin(communities, eq(communities.id, moderationRules.communityId))
      .where(and(eq(moderationRules.id, ruleId), eq(communities.organizationId, organizationId), isNull(moderationRules.deletedAt)));
    if (!rule) throw new AppError(404, "RULE_NOT_FOUND", "Rule not found.");
    await tx.update(moderationRules).set({ enabled: false, deletedAt: new Date() }).where(eq(moderationRules.id, ruleId));
  });
  return { ok: true } as const;
}

async function testRules(actor: Actor, organizationId: string, communityId: string, text: string): Promise<TestRulesResult> {
  const db = getDb();
  const rules = await db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId, actor);
    const [community] = await tx.select().from(communities).where(and(eq(communities.id, communityId), eq(communities.organizationId, organizationId)));
    if (!community) throw new AppError(404, "COMMUNITY_NOT_FOUND", "Community not found.");
    const rules = await tx.select().from(moderationRules).where(and(eq(moderationRules.communityId, communityId), eq(moderationRules.enabled, true), isNull(moderationRules.deletedAt)));
    if (!rules.length) throw new AppError(409, "RULE_REQUIRED", "Enable at least one rule first.");
    const day = new Date().toISOString().slice(0, 10);
    await tx.insert(ruleTestUsage).values({ organizationId, day }).onConflictDoNothing();
    const [reserved] = await tx.update(ruleTestUsage).set({ count: sql`${ruleTestUsage.count} + 1` })
      .where(and(eq(ruleTestUsage.organizationId, organizationId), eq(ruleTestUsage.day, day), lt(ruleTestUsage.count, FREE_LIMITS.ruleTestsPerDay))).returning();
    if (!reserved) throw new AppError(429, "TEST_LIMIT", "The daily rule-test limit has been reached.");
    return rules;
  });
  const result = await evaluateRules(text, rules);
  return { ...result, evaluations: result.evaluations, decision: decide(rules, result.evaluations) };
}

async function saveFeedback(actor: Actor, organizationId: string, decisionId: string, expectedAction: "ALLOW" | "REVIEW" | "DELETE", comment?: string) {
  const db = getDb();
  const [decision] = await db.select({ id: moderationDecisions.id }).from(moderationDecisions)
    .innerJoin(moderationMessages, eq(moderationMessages.id, moderationDecisions.messageId))
    .innerJoin(communities, eq(communities.id, moderationMessages.communityId))
    .where(and(eq(moderationDecisions.id, decisionId), eq(communities.organizationId, organizationId)));
  if (!decision) throw new AppError(404, "DECISION_NOT_FOUND", "Decision not found.");
  await db.insert(moderationFeedback).values({ decisionId, userId: actor.id, expectedAction, comment })
    .onConflictDoUpdate({ target: [moderationFeedback.decisionId, moderationFeedback.userId], set: { expectedAction, comment } });
  return { ok: true } as const;
}
