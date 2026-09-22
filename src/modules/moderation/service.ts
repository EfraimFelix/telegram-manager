import { and, asc, count, eq, gt, isNull, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { type Database } from "../../db";
import {
  botConnections, communities, moderationActions, moderationDecisions, moderationMessages, moderationRuleEvaluations,
  moderationRules, moderationWarnings, organizations, usageMonthly,
} from "../../db/schema";
import { decryptToken } from "../telegram/crypto";
import { telegram, TelegramError } from "../telegram/client";
import { FREE_LIMITS, monthStart } from "../usage/limits";
import { evaluateRules, type ModerationEngine } from "./jev";
import { DECISION_VERSION, decide, MATCH_THRESHOLD, type Decision, type Rule } from "./decision";

type DbSchema = typeof import("../../db/schema");
type DbTransaction = PgTransaction<PgQueryResultHKT, DbSchema, ExtractTablesWithRelations<DbSchema>>;

const WARNING_TEXT = (number: number) => `⚠️ Warning ${number}: please follow the community rules.`;
const sanctionActions = ["WARN", "MUTE", "BAN"] as const;
type SanctionAction = typeof sanctionActions[number];
type TelegramMember = { status?: string };

function toRule(row: typeof moderationRules.$inferSelect): Rule {
  return { id: row.id, name: row.name, ruleText: row.ruleText, action: row.action, actionDurationSeconds: row.actionDurationSeconds, deleteMessage: row.deleteMessage, priority: row.priority };
}

function isSanction(action: string): action is SanctionAction {
  return (sanctionActions as readonly string[]).includes(action);
}

async function protectedTelegramMember(token: string, chatId: string, userId: string) {
  const member = await telegram<TelegramMember>(token, "getChatMember", { chat_id: chatId, user_id: Number(userId) });
  return member.status === "creator" || member.status === "administrator";
}

export async function moderateMessage(db: Database, messageId: string, evaluate: ModerationEngine = evaluateRules) {
  const [owner] = await db.select({ organizationId: communities.organizationId }).from(moderationMessages)
    .innerJoin(communities, eq(communities.id, moderationMessages.communityId)).where(eq(moderationMessages.id, messageId));
  if (!owner) throw new Error("Message not found");

  await db.transaction(async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, owner.organizationId)).for("update");
    const [message] = await tx.select().from(moderationMessages).where(eq(moderationMessages.id, messageId)).for("update");
    const [existing] = await tx.select({ id: moderationDecisions.id }).from(moderationDecisions).where(eq(moderationDecisions.messageId, messageId));
    if (!org || !message || existing) return;

    const [community] = await tx.select().from(communities).where(eq(communities.id, message.communityId));
    const [newer] = await tx.select({ id: moderationMessages.id }).from(moderationMessages)
      .where(and(eq(moderationMessages.communityId, community.id), eq(moderationMessages.platformMessageId, message.platformMessageId), gt(moderationMessages.revision, message.revision))).limit(1);
    const rows = await tx.select().from(moderationRules).where(and(eq(moderationRules.communityId, community.id), eq(moderationRules.enabled, true), isNull(moderationRules.deletedAt)));
    const rules = rows.map(toRule);
    const month = monthStart();
    await tx.insert(usageMonthly).values({ organizationId: org.id, yearMonth: month }).onConflictDoNothing();
    const usageWhere = and(eq(usageMonthly.organizationId, org.id), eq(usageMonthly.yearMonth, month));
    const [usage] = await tx.select().from(usageMonthly).where(usageWhere);
    const skipped = org.status !== "active" ? "Organization is inactive"
      : !community.moderationEnabled || community.status !== "active" ? "Moderation is paused"
        : newer ? "A newer message version exists"
          : !rules.length ? "No active rules"
            : usage.messagesModerated >= FREE_LIMITS.messages ? "Monthly quota reached" : undefined;

    const result = skipped ? null : await evaluate(message.text, rules);
    let decision: Decision;
    let protectedTarget = false;
    if (!result) {
      decision = { state: "SKIPPED", winningRuleId: null, reason: skipped!, matchedRules: [], reviewRules: [], deleteRequested: false, deleteRuleId: null, resolvedAction: null, actionDurationSeconds: null, actionRuleId: null, actionOrigin: null, warningNumber: null };
    } else {
      let activeWarnings = 0;
      const hasWarn = result.evaluations.some((evaluation) => rules.some((rule) => rule.id === evaluation.ruleId && rule.action === "WARN" && evaluation.probability >= MATCH_THRESHOLD));
      if (hasWarn && message.platformUserId) {
        const [warningCount] = await tx.select({ value: count() }).from(moderationWarnings).where(and(
          eq(moderationWarnings.communityId, community.id), eq(moderationWarnings.platformUserId, message.platformUserId), gt(moderationWarnings.expiresAt, new Date()),
        ));
        activeWarnings = Number(warningCount?.value ?? 0);
      }
      decision = decide(rules, result.evaluations, community, activeWarnings);
      if (decision.resolvedAction && message.platformUserId) {
        const [bot] = await tx.select().from(botConnections).where(eq(botConnections.id, community.botConnectionId));
        if (bot?.status === "active") protectedTarget = await protectedTelegramMember(await decryptToken(bot.encryptedToken), community.externalId, message.platformUserId);
      }
    }

    const warningRuleId = decision.warningNumber && !protectedTarget && message.platformUserId
      ? decision.matchedRules.find((evaluation) => rules.find((rule) => rule.id === evaluation.ruleId)?.action === "WARN")?.ruleId ?? null : null;
    let warningRecorded = false;
    const [saved] = await tx.insert(moderationDecisions).values({
      messageId, state: decision.state, winningRuleId: decision.winningRuleId, reason: decision.reason, decisionVersion: DECISION_VERSION,
      inputTokens: result?.inputTokens ?? 0, latencyMs: result?.latencyMs ?? 0,
    }).returning();
    if (warningRuleId && decision.warningNumber && message.platformUserId) {
      const [warning] = await tx.insert(moderationWarnings).values({
        decisionId: saved.id, communityId: community.id, ruleId: warningRuleId!, platformUserId: message.platformUserId!, platformMessageId: message.platformMessageId,
        warningNumber: decision.warningNumber!, expiresAt: new Date(Date.now() + community.warningWindowDays * 86_400_000),
      }).onConflictDoNothing().returning({ id: moderationWarnings.id });
      warningRecorded = !!warning;
    }

    if (result) {
      await tx.insert(moderationRuleEvaluations).values(result.evaluations.map((evaluation) => {
        const rule = rules.find((item) => item.id === evaluation.ruleId)!;
        return { messageId, ruleId: rule.id, ruleText: rule.ruleText, ruleName: rule.name, configuredAction: rule.action, actionDurationSeconds: rule.actionDurationSeconds, deleteMessage: rule.deleteMessage, priority: rule.priority, probability: evaluation.probability, matched: evaluation.probability >= MATCH_THRESHOLD, providerModel: result.model };
      }));
    }

    const actions: Array<typeof moderationActions.$inferInsert> = [];
    const duplicateWarning = decision.resolvedAction === "WARN" && decision.actionOrigin === "ESCALATED" && !warningRecorded;
    if (decision.resolvedAction) actions.push({ decisionId: saved.id, ruleId: decision.actionRuleId, action: decision.resolvedAction, durationSeconds: decision.actionDurationSeconds, status: protectedTarget || !message.platformUserId || duplicateWarning ? "SKIPPED" : "PENDING", externalResult: protectedTarget ? { reason: "Protected administrator or creator" } : !message.platformUserId ? { reason: "Message has no identifiable user" } : duplicateWarning ? { reason: "Warning already recorded for this message" } : null });
    if (decision.deleteRequested) actions.push({ decisionId: saved.id, ruleId: decision.deleteRuleId, action: "DELETE", status: "PENDING" });
    if (actions.length) await tx.insert(moderationActions).values(actions);
    await tx.update(moderationMessages).set({ processingStatus: "DECIDED", lastError: null }).where(eq(moderationMessages.id, messageId));

    if (result) {
      const stateUpdate = decision.state === "NO_MATCH" ? { decisionsNoMatch: sql`${usageMonthly.decisionsNoMatch} + 1` } : decision.state === "REVIEW" ? { decisionsReview: sql`${usageMonthly.decisionsReview} + 1` } : { decisionsMatched: sql`${usageMonthly.decisionsMatched} + 1` };
      await tx.update(usageMonthly).set({
        messagesModerated: sql`${usageMonthly.messagesModerated} + 1`, jevRequests: sql`${usageMonthly.jevRequests} + 1`, jevInputTokens: sql`${usageMonthly.jevInputTokens} + ${result.inputTokens}`, ruleEvaluations: sql`${usageMonthly.ruleEvaluations} + ${rules.length}`,
        warningsRecorded: sql`${usageMonthly.warningsRecorded} + ${warningRecorded ? 1 : 0}`, ...stateUpdate,
      }).where(usageWhere);
    }
  });
  await executeActions(db, messageId);
}

async function executeActions(db: Database, messageId: string) {
  const pending = await db.select({ id: moderationActions.id, action: moderationActions.action }).from(moderationActions)
    .innerJoin(moderationDecisions, eq(moderationDecisions.id, moderationActions.decisionId)).where(eq(moderationDecisions.messageId, messageId)).orderBy(asc(moderationActions.createdAt));
  let retryable: unknown;
  for (const action of pending.filter((item) => item.action !== "DELETE").concat(pending.filter((item) => item.action === "DELETE"))) {
    try { await executeOneAction(db, action.id); } catch (error) { if (error instanceof TelegramError && error.retryable) retryable ??= error; else throw error; }
  }
  if (retryable) throw retryable;
}

async function executeOneAction(db: Database, actionId: string) {
  await db.transaction(async (tx) => {
    const [entry] = await tx.select({ action: moderationActions, decision: moderationDecisions, message: moderationMessages, community: communities, org: organizations, bot: botConnections })
      .from(moderationActions).innerJoin(moderationDecisions, eq(moderationDecisions.id, moderationActions.decisionId)).innerJoin(moderationMessages, eq(moderationMessages.id, moderationDecisions.messageId))
      .innerJoin(communities, eq(communities.id, moderationMessages.communityId)).innerJoin(organizations, eq(organizations.id, communities.organizationId)).innerJoin(botConnections, eq(botConnections.id, communities.botConnectionId))
      .where(eq(moderationActions.id, actionId)).for("update");
    if (!entry || entry.action.status !== "PENDING") return;
    const [warning] = await tx.select().from(moderationWarnings).where(eq(moderationWarnings.decisionId, entry.decision.id));
    const tooOldToDelete = entry.action.action === "DELETE" && Date.now() - entry.message.sentAt.getTime() >= 48 * 3_600_000;
    const basicGroupMute = entry.action.action === "MUTE" && entry.community.telegramChatType === "group";
    const paused = entry.org.status !== "active" || !entry.community.moderationEnabled || entry.community.status !== "active" || entry.bot.status !== "active";
    const noUser = isSanction(entry.action.action) && !entry.message.platformUserId;
    const skipReason = tooOldToDelete ? "Telegram deletion window exceeded" : basicGroupMute ? "Mute is not supported for basic groups" : paused ? "Moderation is paused or bot is disconnected" : noUser ? "Message has no identifiable user" : entry.action.action === "WARN" && !entry.community.publicWarningsEnabled ? "Public warnings are disabled" : undefined;
    if (skipReason) {
      await tx.update(moderationActions).set({ status: "SKIPPED", externalResult: { reason: skipReason }, executedAt: new Date() }).where(eq(moderationActions.id, actionId));
      await refreshMessageStatus(tx, entry.message.id, entry.decision.id);
      return;
    }
    const token = await decryptToken(entry.bot.encryptedToken);
    try {
      if (entry.action.action === "WARN") {
        await telegram<boolean>(token, "sendMessage", { chat_id: entry.community.externalId, text: WARNING_TEXT(warning?.warningNumber ?? 1), reply_parameters: { message_id: Number(entry.message.platformMessageId), allow_sending_without_reply: true } });
      } else if (entry.action.action === "DELETE") {
        await telegram<boolean>(token, "deleteMessage", { chat_id: entry.community.externalId, message_id: Number(entry.message.platformMessageId) });
      } else if (entry.action.action === "MUTE") {
        await telegram<boolean>(token, "restrictChatMember", { chat_id: entry.community.externalId, user_id: Number(entry.message.platformUserId), permissions: { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false }, use_independent_chat_permissions: true, ...(entry.action.durationSeconds ? { until_date: Math.floor(Date.now() / 1000) + entry.action.durationSeconds } : {}) });
      } else {
        await telegram<boolean>(token, "banChatMember", { chat_id: entry.community.externalId, user_id: Number(entry.message.platformUserId), ...(entry.action.durationSeconds ? { until_date: Math.floor(Date.now() / 1000) + entry.action.durationSeconds } : {}) });
      }
    } catch (error) {
      if (error instanceof TelegramError && error.retryable) throw error;
      const alreadyGone = entry.action.action === "DELETE" && error instanceof TelegramError && error.code === 400 && /message to delete not found/i.test(error.description);
      await tx.update(moderationActions).set({ status: alreadyGone ? "SUCCESS" : "FAILED", externalResult: { code: error instanceof TelegramError ? error.code : undefined, description: alreadyGone ? "Message already absent" : error instanceof Error ? error.message : "Telegram request failed" }, executedAt: new Date() }).where(eq(moderationActions.id, actionId));
      await refreshMessageStatus(tx, entry.message.id, entry.decision.id);
      if (!alreadyGone) return;
    }
    await tx.update(moderationActions).set({ status: "SUCCESS", externalResult: { description: entry.action.action === "DELETE" ? "Message deleted" : `${entry.action.action} executed` }, executedAt: new Date() }).where(and(eq(moderationActions.id, actionId), eq(moderationActions.status, "PENDING")));
    const month = monthStart(entry.decision.createdAt);
    if (entry.action.action === "WARN") await tx.update(usageMonthly).set({ actionsWarn: sql`${usageMonthly.actionsWarn} + 1` }).where(and(eq(usageMonthly.organizationId, entry.community.organizationId), eq(usageMonthly.yearMonth, month)));
    if (entry.action.action === "DELETE") await tx.update(usageMonthly).set({ actionsDelete: sql`${usageMonthly.actionsDelete} + 1` }).where(and(eq(usageMonthly.organizationId, entry.community.organizationId), eq(usageMonthly.yearMonth, month)));
    if (entry.action.action === "MUTE") await tx.update(usageMonthly).set({ actionsMute: sql`${usageMonthly.actionsMute} + 1` }).where(and(eq(usageMonthly.organizationId, entry.community.organizationId), eq(usageMonthly.yearMonth, month)));
    if (entry.action.action === "BAN") await tx.update(usageMonthly).set({ actionsBan: sql`${usageMonthly.actionsBan} + 1` }).where(and(eq(usageMonthly.organizationId, entry.community.organizationId), eq(usageMonthly.yearMonth, month)));
    await refreshMessageStatus(tx, entry.message.id, entry.decision.id);
  });
}

async function refreshMessageStatus(tx: DbTransaction, messageId: string, decisionId: string) {
  const actions = await tx.select({ status: moderationActions.status }).from(moderationActions).where(eq(moderationActions.decisionId, decisionId));
  const status = actions.some((item: { status: string }) => item.status === "PENDING") ? "DECIDED" : actions.some((item: { status: string }) => item.status === "FAILED") ? "FAILED" : "ACTION_EXECUTED";
  await tx.update(moderationMessages).set({ processingStatus: status, lastError: status === "FAILED" ? "One or more Telegram actions failed" : null }).where(eq(moderationMessages.id, messageId));
}
