import { randomBytes } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { botConnections, communities, communityConnectionAttempts, moderationActions, moderationDecisions, moderationFeedback, moderationMessages, moderationRuleEvaluations, moderationRules, moderationWarnings, organizations, ruleTestUsage, usageMonthly } from "../../db/schema";
import { evaluateRules } from "../moderation/jev";
import { decide } from "../moderation/decision";
import { telegram } from "../telegram/client";
import { decryptToken, secretHash } from "../telegram/crypto";
import { FREE_LIMITS, monthStart } from "../usage/limits";
import { lockOrganization, type Actor } from "./access";
import type { DashboardData, TestRulesResult } from "./contracts";
import type { DashboardCommand } from "./validation";
import { AppError } from "./http";

type TelegramChat = { id: number; type: string; title?: string; username?: string };
type TelegramMember = { status: string; can_delete_messages?: boolean; can_restrict_members?: boolean };
const CONNECTION_TTL_MS = 15 * 60 * 1_000;
const STARTER_RULE = { name: "Spam & promotion", ruleText: "Flag unsolicited advertisements, repeated promotional messages, and referral spam. Allow relevant links shared as part of a genuine conversation." };

function isAdmin(member: TelegramMember | undefined) { return member?.status === "administrator" || member?.status === "creator"; }

function permissionError(chatType: string, bot: TelegramMember | undefined, user: TelegramMember | undefined) {
  if (!isAdmin(user)) return { code: "USER_PERMISSIONS", message: "The Telegram account that started the connection must be a group administrator." };
  if (!bot || !isAdmin(bot)) return { code: "BOT_PERMISSIONS", message: "Make the Telegram Manager bot an administrator in this group." };
  if (bot.status !== "creator" && bot.can_delete_messages !== true) return { code: "BOT_DELETE_PERMISSION", message: "Grant the bot permission to delete messages." };
  if (chatType === "supergroup" && bot.status !== "creator" && bot.can_restrict_members !== true) return { code: "BOT_RESTRICT_PERMISSION", message: "Grant the bot permission to restrict members." };
  return null;
}

export async function dashboardData(actor: Actor, organizationId: string): Promise<DashboardData> {
  const db = getDb();
  const month = monthStart();
  const today = new Date().toISOString().slice(0, 10);
  const [organization, bot, attempt, communityRows, ruleRows, usage, tests] = await Promise.all([
    db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).then(([row]) => row),
    db.select({ id: botConnections.id, username: botConnections.username, status: botConnections.status }).from(botConnections).where(eq(botConnections.scope, "SYSTEM")).then(([row]) => row ?? null),
    db.select().from(communityConnectionAttempts).where(eq(communityConnectionAttempts.organizationId, organizationId)).orderBy(desc(communityConnectionAttempts.createdAt)).limit(1).then(([row]) => row ?? null),
    db.select().from(communities).where(eq(communities.organizationId, organizationId)).orderBy(communities.createdAt),
    db.select({ rule: moderationRules }).from(moderationRules).innerJoin(communities, eq(communities.id, moderationRules.communityId)).where(and(eq(communities.organizationId, organizationId), isNull(moderationRules.deletedAt))).orderBy(desc(moderationRules.priority)),
    db.select().from(usageMonthly).where(and(eq(usageMonthly.organizationId, organizationId), eq(usageMonthly.yearMonth, month))).then(([row]) => row),
    db.select({ count: ruleTestUsage.count }).from(ruleTestUsage).where(and(eq(ruleTestUsage.organizationId, organizationId), eq(ruleTestUsage.day, today))).then(([row]) => row?.count ?? 0),
  ]);
  const messages = await db.select({ message: moderationMessages, communityName: communities.name }).from(moderationMessages).innerJoin(communities, eq(communities.id, moderationMessages.communityId)).where(eq(communities.organizationId, organizationId)).orderBy(desc(moderationMessages.receivedAt)).limit(50);
  const messageIds = messages.map(({ message }) => message.id);
  const decisions = messageIds.length ? await db.select().from(moderationDecisions).where(inArray(moderationDecisions.messageId, messageIds)) : [];
  const decisionIds = decisions.map((item) => item.id);
  const [evaluations, actions, warnings, feedback] = await Promise.all([
    messageIds.length ? db.select().from(moderationRuleEvaluations).where(inArray(moderationRuleEvaluations.messageId, messageIds)) : [],
    decisionIds.length ? db.select().from(moderationActions).where(inArray(moderationActions.decisionId, decisionIds)) : [],
    decisionIds.length ? db.select().from(moderationWarnings).where(inArray(moderationWarnings.decisionId, decisionIds)) : [],
    decisionIds.length ? db.select().from(moderationFeedback).where(inArray(moderationFeedback.decisionId, decisionIds)) : [],
  ]);
  const decisionByMessage = new Map(decisions.map((item) => [item.messageId, item]));
  const actionsByDecision = new Map<string, typeof actions>();
  for (const action of actions) actionsByDecision.set(action.decisionId, [...(actionsByDecision.get(action.decisionId) ?? []), action]);
  const warningByDecision = new Map(warnings.map((warning) => [warning.decisionId, warning]));
  const since = new Date(); since.setUTCHours(0, 0, 0, 0); since.setUTCDate(since.getUTCDate() - 6);
  const activity = await db.select({ receivedAt: moderationMessages.receivedAt, state: moderationDecisions.state }).from(moderationMessages).innerJoin(communities, eq(communities.id, moderationMessages.communityId)).leftJoin(moderationDecisions, eq(moderationDecisions.messageId, moderationMessages.id)).where(and(eq(communities.organizationId, organizationId), gte(moderationMessages.receivedAt, since)));
  const dailyStats = Array.from({ length: 7 }, (_, offset) => { const date = new Date(since); date.setUTCDate(since.getUTCDate() + offset); return { date: date.toISOString().slice(0, 10), received: 0, moderated: 0, noMatch: 0, review: 0, matched: 0 }; });
  for (const item of activity) { const day = dailyStats.find((entry) => entry.date === item.receivedAt.toISOString().slice(0, 10)); if (!day) continue; day.received += 1; if (item.state && item.state !== "SKIPPED") day.moderated += 1; if (item.state === "NO_MATCH") day.noMatch += 1; if (item.state === "REVIEW") day.review += 1; if (item.state === "MATCHED") day.matched += 1; }
  const emptyUsage = { yearMonth: month, messagesReceived: 0, messagesModerated: 0, jevRequests: 0, jevInputTokens: 0, ruleEvaluations: 0, decisionsNoMatch: 0, decisionsReview: 0, decisionsMatched: 0, warningsRecorded: 0, actionsWarn: 0, actionsDelete: 0, actionsMute: 0, actionsBan: 0 };
  const currentUsage = usage ?? emptyUsage;
  return {
    user: { name: actor.name, email: actor.email }, organization: organization ?? { id: organizationId, name: actor.name + "'s workspace" }, bot,
    connectionAttempt: attempt ? { id: attempt.id, state: attempt.expiresAt <= new Date() && ["PENDING", "DISCOVERED"].includes(attempt.state) ? "EXPIRED" : attempt.state, expiresAt: attempt.expiresAt.toISOString(), candidate: attempt.candidateExternalId ? { externalId: attempt.candidateExternalId, name: attempt.candidateName, username: attempt.candidateUsername, chatType: attempt.candidateChatType, botIsAdmin: attempt.botIsAdmin, userIsAdmin: attempt.userIsAdmin } : null, errorCode: attempt.errorCode, errorMessage: attempt.errorMessage } : null,
    communities: communityRows.map(({ id, name, externalId, username, status, moderationEnabled, telegramChatType, warningWindowDays, publicWarningsEnabled, warningMuteAt, warningMuteDurationSeconds, warningBanAt, warningBanDurationSeconds }) => ({ id, name, externalId, username, status, moderationEnabled, telegramChatType, warningWindowDays, publicWarningsEnabled, warningMuteAt, warningMuteDurationSeconds, warningBanAt, warningBanDurationSeconds })),
    rules: ruleRows.map(({ rule }) => ({ id: rule.id, communityId: rule.communityId, name: rule.name, ruleText: rule.ruleText, action: rule.action, actionDurationSeconds: rule.actionDurationSeconds, deleteMessage: rule.deleteMessage, priority: rule.priority, enabled: rule.enabled })),
    usage: { ...currentUsage, testsToday: tests }, limits: { communities: FREE_LIMITS.communities, enabledRules: FREE_LIMITS.activeRules, messagesPerMonth: FREE_LIMITS.messages, testsPerDay: FREE_LIMITS.ruleTestsPerDay },
    recentLogs: messages.map(({ message, communityName }) => {
      const decision = decisionByMessage.get(message.id); const actionList = decision ? actionsByDecision.get(decision.id) ?? [] : []; const warning = decision ? warningByDecision.get(decision.id) : undefined;
      return { id: message.id, communityId: message.communityId, communityName, platformUserId: message.platformUserId, text: message.text, receivedAt: message.receivedAt.toISOString(), processingStatus: message.processingStatus,
        decision: decision ? { id: decision.id, state: decision.state, winningRuleId: decision.winningRuleId, reason: decision.reason, decisionVersion: decision.decisionVersion, inputTokens: decision.inputTokens, latencyMs: decision.latencyMs } : null,
        evaluations: evaluations.filter((item) => item.messageId === message.id), actions: actionList.map((item) => ({ action: item.action, ruleId: item.ruleId, durationSeconds: item.durationSeconds, status: item.status, externalResult: item.externalResult, executedAt: item.executedAt?.toISOString() ?? null })),
        warning: warning ? { warningNumber: warning.warningNumber, expiresAt: warning.expiresAt.toISOString() } : null,
        feedback: decision ? feedback.filter((item) => item.decisionId === decision.id).map((item) => ({ expectedState: item.expectedState as "NO_MATCH" | "REVIEW" | "MATCHED", comment: item.comment, createdAt: item.createdAt.toISOString() })) : [],
      };
    }), dailyStats, costEstimate: { currency: "USD", inputTokens: currentUsage.jevInputTokens, pricePerMillionTokens: 0.042, estimatedUsd: currentUsage.jevInputTokens / 1_000_000 * 0.042 },
  };
}

export async function executeDashboardCommand(actor: Actor, organizationId: string, command: DashboardCommand) {
  switch (command.action) {
    case "startConnection": return startConnection(actor, organizationId);
    case "confirmConnection": return confirmConnection(actor, organizationId, command.attemptId);
    case "toggleModeration": return toggleModeration(actor, organizationId, command.communityId, command.enabled);
    case "saveCommunitySettings": return saveCommunitySettings(actor, organizationId, command);
    case "saveRule": return saveRule(actor, organizationId, command);
    case "deleteRule": return deleteRule(actor, organizationId, command.id);
    case "testRules": return testRules(actor, organizationId, command.communityId, command.text);
    case "feedback": return saveFeedback(actor, organizationId, command.decisionId, command.expectedState, command.comment);
  }
}

async function startConnection(actor: Actor, organizationId: string) {
  const db = getDb();
  const [bot] = await db.select().from(botConnections).where(and(eq(botConnections.scope, "SYSTEM"), eq(botConnections.status, "active")));
  if (!bot) throw new AppError(503, "SYSTEM_BOT_UNAVAILABLE", "The official Telegram Manager bot is not configured yet.");
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + CONNECTION_TTL_MS);
  const attempt = await db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId, actor);
    const [{ value: total }] = await tx.select({ value: count() }).from(communities).where(eq(communities.organizationId, organizationId));
    if (total >= FREE_LIMITS.communities) throw new AppError(409, "COMMUNITY_LIMIT", "This workspace already has its community connected.");
    const [created] = await tx.insert(communityConnectionAttempts).values({ organizationId, botConnectionId: bot.id, createdBy: actor.id, codeHash: secretHash(code), expiresAt }).returning({ id: communityConnectionAttempts.id, expiresAt: communityConnectionAttempts.expiresAt });
    return created;
  });
  const startUrl = `https://t.me/${bot.username}?startgroup=${code}&admin=delete_messages+restrict_members`;
  return { ok: true, attempt: { id: attempt.id, state: "PENDING", expiresAt: attempt.expiresAt.toISOString(), startUrl } } as const;
}

async function confirmConnection(actor: Actor, organizationId: string, attemptId: string) {
  const db = getDb();
  const [attempt] = await db.select({ attempt: communityConnectionAttempts, bot: botConnections }).from(communityConnectionAttempts).innerJoin(botConnections, eq(botConnections.id, communityConnectionAttempts.botConnectionId)).where(and(eq(communityConnectionAttempts.id, attemptId), eq(communityConnectionAttempts.organizationId, organizationId)));
  if (!attempt) throw new AppError(404, "CONNECTION_NOT_FOUND", "Connection attempt not found.");
  if (attempt.attempt.state === "COMPLETED" && attempt.attempt.communityId) return { ok: true, communityId: attempt.attempt.communityId } as const;
  if (!["PENDING", "DISCOVERED"].includes(attempt.attempt.state)) throw new AppError(409, "CONNECTION_UNAVAILABLE", "Start a new connection attempt.");
  if (attempt.attempt.expiresAt <= new Date()) {
    await db.update(communityConnectionAttempts).set({ state: "EXPIRED", errorCode: "EXPIRED", errorMessage: "This connection link expired." }).where(eq(communityConnectionAttempts.id, attemptId));
    throw new AppError(409, "CONNECTION_EXPIRED", "This connection link expired. Start again.");
  }
  if (!attempt.attempt.candidateExternalId || !attempt.attempt.telegramUserId) throw new AppError(409, "CONNECTION_PENDING", "Open the Telegram link and choose the group first.");

  const token = await decryptToken(attempt.bot.encryptedToken);
  const chat = await telegram<TelegramChat>(token, "getChat", { chat_id: attempt.attempt.candidateExternalId });
  const botMember = await telegram<TelegramMember>(token, "getChatMember", { chat_id: chat.id, user_id: Number(attempt.bot.externalId) });
  const userMember = await telegram<TelegramMember>(token, "getChatMember", { chat_id: chat.id, user_id: Number(attempt.attempt.telegramUserId) });
  const permission = permissionError(chat.type, botMember, userMember);
  if (permission) {
    await db.update(communityConnectionAttempts).set({ candidateName: chat.title ?? chat.username ?? "Telegram community", candidateUsername: chat.username, candidateChatType: chat.type, botIsAdmin: isAdmin(botMember), userIsAdmin: isAdmin(userMember), errorCode: permission.code, errorMessage: permission.message }).where(eq(communityConnectionAttempts.id, attemptId));
    throw new AppError(409, permission.code, permission.message);
  }

  return db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId, actor);
    const [current] = await tx.select().from(communityConnectionAttempts).where(eq(communityConnectionAttempts.id, attemptId)).for("update");
    if (!current || current.state === "COMPLETED") return { ok: true, communityId: current?.communityId ?? null } as const;
    const [{ value: total }] = await tx.select({ value: count() }).from(communities).where(eq(communities.organizationId, organizationId));
    if (total >= FREE_LIMITS.communities) throw new AppError(409, "COMMUNITY_LIMIT", "This workspace already has its community connected.");
    const [claimed] = await tx.select({ id: communities.id }).from(communities).where(and(eq(communities.platform, "telegram"), eq(communities.externalId, String(chat.id))));
    if (claimed) {
      await tx.update(communityConnectionAttempts).set({ state: "FAILED", errorCode: "COMMUNITY_IN_USE", errorMessage: "This group is already connected to another workspace." }).where(eq(communityConnectionAttempts.id, attemptId));
      throw new AppError(409, "COMMUNITY_IN_USE", "This group is already connected to another workspace.");
    }
    const [community] = await tx.insert(communities).values({ organizationId, botConnectionId: attempt.bot.id, externalId: String(chat.id), name: chat.title ?? chat.username ?? "Telegram community", username: chat.username, telegramChatType: chat.type, moderationEnabled: true }).returning({ id: communities.id });
    await tx.insert(moderationRules).values({ communityId: community.id, createdBy: actor.id, name: STARTER_RULE.name, ruleText: STARTER_RULE.ruleText, action: "WARN", actionDurationSeconds: null, deleteMessage: true, enabled: true });
    await tx.update(communityConnectionAttempts).set({ state: "COMPLETED", communityId: community.id, candidateName: chat.title ?? chat.username ?? "Telegram community", candidateUsername: chat.username, candidateChatType: chat.type, botIsAdmin: true, userIsAdmin: true, errorCode: null, errorMessage: null, consumedAt: new Date() }).where(eq(communityConnectionAttempts.id, attemptId));
    return { ok: true, communityId: community.id } as const;
  });
}

async function verifyModerationPermissions(organizationId: string, communityId: string) {
  const db = getDb(); const [community] = await db.select().from(communities).where(and(eq(communities.id, communityId), eq(communities.organizationId, organizationId))); if (!community) throw new AppError(404, "COMMUNITY_NOT_FOUND", "Community not found."); const [bot] = await db.select().from(botConnections).where(eq(botConnections.id, community.botConnectionId)); if (!bot || bot.status !== "active") throw new AppError(409, "BOT_REQUIRED", "Connect the bot before enabling moderation.");
  const rules = await db.select().from(moderationRules).where(and(eq(moderationRules.communityId, communityId), eq(moderationRules.enabled, true), isNull(moderationRules.deletedAt))); const needsDelete = rules.some((rule) => rule.deleteMessage); const needsRestrict = rules.some((rule) => rule.action === "MUTE" || rule.action === "BAN") || community.warningMuteAt !== null || community.warningBanAt !== null;
  const member = await telegram<TelegramMember>(await decryptToken(bot.encryptedToken), "getChatMember", { chat_id: community.externalId, user_id: Number(bot.externalId) }); if (!["administrator", "creator"].includes(member.status)) throw new AppError(400, "BOT_PERMISSIONS", "Make the bot an administrator before enabling moderation."); if (needsDelete && member.status !== "creator" && member.can_delete_messages !== true) throw new AppError(400, "BOT_PERMISSIONS", "Grant the bot permission to delete messages."); if (needsRestrict && community.telegramChatType === "supergroup" && member.status !== "creator" && member.can_restrict_members !== true) throw new AppError(400, "BOT_PERMISSIONS", "Grant the bot permission to restrict members.");
}

async function toggleModeration(actor: Actor, organizationId: string, communityId: string, enabled: boolean) {
  const db = getDb(); if (enabled) { await verifyModerationPermissions(organizationId, communityId); const [{ value }] = await db.select({ value: count() }).from(moderationRules).where(and(eq(moderationRules.communityId, communityId), eq(moderationRules.enabled, true), isNull(moderationRules.deletedAt))); if (!value) throw new AppError(409, "RULE_REQUIRED", "Enable at least one rule first."); }
  await db.transaction(async (tx) => { await lockOrganization(tx, organizationId, actor); const [community] = await tx.select().from(communities).where(and(eq(communities.id, communityId), eq(communities.organizationId, organizationId))); if (!community) throw new AppError(404, "COMMUNITY_NOT_FOUND", "Community not found."); await tx.update(communities).set({ moderationEnabled: enabled }).where(eq(communities.id, communityId)); }); return { ok: true } as const;
}

async function saveCommunitySettings(actor: Actor, organizationId: string, command: Extract<DashboardCommand, { action: "saveCommunitySettings" }>) {
  const db = getDb(); await db.transaction(async (tx) => { await lockOrganization(tx, organizationId, actor); const [community] = await tx.select().from(communities).where(and(eq(communities.id, command.communityId), eq(communities.organizationId, organizationId))); if (!community) throw new AppError(404, "COMMUNITY_NOT_FOUND", "Community not found."); await tx.update(communities).set({ warningWindowDays: command.warningWindowDays, publicWarningsEnabled: command.publicWarningsEnabled, warningMuteAt: command.warningMuteAt, warningMuteDurationSeconds: command.warningMuteDurationSeconds, warningBanAt: command.warningBanAt, warningBanDurationSeconds: command.warningBanDurationSeconds }).where(eq(communities.id, command.communityId)); }); return { ok: true } as const;
}

async function saveRule(actor: Actor, organizationId: string, command: Extract<DashboardCommand, { action: "saveRule" }>) {
  const db = getDb(); await db.transaction(async (tx) => { await lockOrganization(tx, organizationId, actor); const [community] = await tx.select().from(communities).where(and(eq(communities.id, command.communityId), eq(communities.organizationId, organizationId))); if (!community) throw new AppError(404, "COMMUNITY_NOT_FOUND", "Community not found."); const [existing] = command.id ? await tx.select().from(moderationRules).where(and(eq(moderationRules.id, command.id), eq(moderationRules.communityId, community.id), isNull(moderationRules.deletedAt))) : []; if (command.id && !existing) throw new AppError(404, "RULE_NOT_FOUND", "Rule not found."); if (command.enabled && !existing?.enabled) { const [{ value }] = await tx.select({ value: count() }).from(moderationRules).where(and(eq(moderationRules.communityId, community.id), eq(moderationRules.enabled, true), isNull(moderationRules.deletedAt))); if (value >= FREE_LIMITS.activeRules) throw new AppError(409, "RULE_LIMIT", "The free plan includes three active rules."); } const values = { name: command.name, ruleText: command.ruleText, action: command.ruleAction, actionDurationSeconds: command.actionDurationSeconds, deleteMessage: command.deleteMessage, priority: command.priority, enabled: command.enabled }; if (existing) await tx.update(moderationRules).set(values).where(eq(moderationRules.id, existing.id)); else await tx.insert(moderationRules).values({ communityId: community.id, createdBy: actor.id, ...values }); }); return { ok: true } as const;
}

async function deleteRule(actor: Actor, organizationId: string, ruleId: string) { const db = getDb(); await db.transaction(async (tx) => { await lockOrganization(tx, organizationId, actor); const [rule] = await tx.select({ id: moderationRules.id }).from(moderationRules).innerJoin(communities, eq(communities.id, moderationRules.communityId)).where(and(eq(moderationRules.id, ruleId), eq(communities.organizationId, organizationId), isNull(moderationRules.deletedAt))); if (!rule) throw new AppError(404, "RULE_NOT_FOUND", "Rule not found."); await tx.update(moderationRules).set({ enabled: false, deletedAt: new Date() }).where(eq(moderationRules.id, ruleId)); }); return { ok: true } as const; }

async function testRules(actor: Actor, organizationId: string, communityId: string, text: string): Promise<TestRulesResult> {
  const db = getDb(); const rules = await db.transaction(async (tx) => { await lockOrganization(tx, organizationId, actor); const [community] = await tx.select().from(communities).where(and(eq(communities.id, communityId), eq(communities.organizationId, organizationId))); if (!community) throw new AppError(404, "COMMUNITY_NOT_FOUND", "Community not found."); const active = await tx.select().from(moderationRules).where(and(eq(moderationRules.communityId, communityId), eq(moderationRules.enabled, true), isNull(moderationRules.deletedAt))); if (!active.length) throw new AppError(409, "RULE_REQUIRED", "Enable at least one rule first."); const day = new Date().toISOString().slice(0, 10); await tx.insert(ruleTestUsage).values({ organizationId, day }).onConflictDoNothing(); const [reserved] = await tx.update(ruleTestUsage).set({ count: sql.raw("count + 1") }).where(and(eq(ruleTestUsage.organizationId, organizationId), eq(ruleTestUsage.day, day), lt(ruleTestUsage.count, FREE_LIMITS.ruleTestsPerDay))).returning(); if (!reserved) throw new AppError(429, "TEST_LIMIT", "The daily rule-test limit has been reached."); return active; });
  const result = await evaluateRules(text, rules); const decision = decide(rules, result.evaluations); return { ...result, decision: { state: decision.state === "SKIPPED" ? "NO_MATCH" : decision.state, reason: decision.reason, matchedRules: decision.matchedRules, reviewRules: decision.reviewRules } };
}

async function saveFeedback(actor: Actor, organizationId: string, decisionId: string, expectedState: "NO_MATCH" | "REVIEW" | "MATCHED", comment?: string) { const db = getDb(); const [decision] = await db.select({ id: moderationDecisions.id }).from(moderationDecisions).innerJoin(moderationMessages, eq(moderationMessages.id, moderationDecisions.messageId)).innerJoin(communities, eq(communities.id, moderationMessages.communityId)).where(and(eq(moderationDecisions.id, decisionId), eq(communities.organizationId, organizationId))); if (!decision) throw new AppError(404, "DECISION_NOT_FOUND", "Decision not found."); await db.insert(moderationFeedback).values({ decisionId, userId: actor.id, expectedState, comment }).onConflictDoUpdate({ target: [moderationFeedback.decisionId, moderationFeedback.userId], set: { expectedState, comment } }); return { ok: true } as const; }
