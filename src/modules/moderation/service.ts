import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { type Database } from "../../db";
import { botConnections, communities, moderationActions, moderationDecisions, moderationMessages, moderationRuleEvaluations, moderationRules, organizations, usageMonthly } from "../../db/schema";
import { decryptToken } from "../telegram/crypto";
import { telegram, TelegramError } from "../telegram/client";
import { FREE_LIMITS, monthStart } from "../usage/limits";
import { evaluateRules, type ModerationEngine } from "./jev";
import { decide, MATCH_THRESHOLD, POLICY_VERSION, type Decision } from "./policy";

export async function moderateMessage(db: Database, messageId: string, evaluate: ModerationEngine = evaluateRules) {
  const [owner] = await db.select({ organizationId: communities.organizationId }).from(moderationMessages)
    .innerJoin(communities, eq(communities.id, moderationMessages.communityId)).where(eq(moderationMessages.id, messageId));
  if (!owner) throw new Error("Message not found");

  await db.transaction(async (tx) => {
    // Per-tenant lock makes concurrent deliveries and the last quota slot deterministic.
    // The bounded 12s model call stays inside this transaction; no pool-wide lock or Redis.
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, owner.organizationId)).for("update");
    const [message] = await tx.select().from(moderationMessages).where(eq(moderationMessages.id, messageId)).for("update");
    const [existing] = await tx.select({ id: moderationDecisions.id }).from(moderationDecisions).where(eq(moderationDecisions.messageId, messageId));

    if (existing) return;

    const [community] = await tx.select().from(communities).where(eq(communities.id, message.communityId));
    const [newer] = await tx.select({ id: moderationMessages.id }).from(moderationMessages).where(and(eq(moderationMessages.communityId, community.id), eq(moderationMessages.platformMessageId, message.platformMessageId), gt(moderationMessages.revision, message.revision))).limit(1);
    const rules = await tx.select().from(moderationRules).where(and(eq(moderationRules.communityId, community.id), eq(moderationRules.enabled, true), isNull(moderationRules.deletedAt)));
    const month = monthStart();

    await tx.insert(usageMonthly).values({ organizationId: org.id, yearMonth: month }).onConflictDoNothing();

    const usageWhere = and(eq(usageMonthly.organizationId, org.id), eq(usageMonthly.yearMonth, month));
    const [usage] = await tx.select().from(usageMonthly).where(usageWhere);

    const skipped = org.status !== "active" ? "Organization is inactive"
      : !community.moderationEnabled || community.status !== "active" ? "Moderation is paused"
        : newer ? "A newer message version exists"
          : !rules.length ? "No active rules"
            : usage.messagesModerated >= FREE_LIMITS.messages ? "Monthly quota reached"
              : Date.now() - message.sentAt.getTime() >= 47 * 3_600_000 ? "Message is too old for automatic deletion" : undefined;

    const result = skipped ? null : await evaluate(message.text, rules);
    const decision: Decision = result ? decide(rules, result.evaluations) : { action: "ALLOW", reason: skipped!, matchedRules: [] };

    if (result) {
      await tx.insert(moderationRuleEvaluations).values(result.evaluations.map((evaluation) => {
        const rule = rules.find((item) => item.id === evaluation.ruleId)!;
        return {
          messageId, ruleId: rule.id, ruleText: rule.ruleText, ruleName: rule.name, configuredAction: rule.action, priority: rule.priority,
          probability: evaluation.probability, matched: evaluation.probability >= MATCH_THRESHOLD, providerModel: result.model
        };
      }));
    }

    const [saved] = await tx.insert(moderationDecisions).values({
      messageId, action: decision.action, winningRuleId: decision.winningRuleId,
      reason: decision.reason, policyVersion: POLICY_VERSION, evaluated: !!result, inputTokens: result?.inputTokens ?? 0, latencyMs: result?.latencyMs ?? 0
    }).returning();

    await tx.insert(moderationActions).values({ decisionId: saved.id, action: decision.action, status: decision.action === "DELETE" ? "pending" : "ignored" });
    await tx.update(moderationMessages).set({ processingStatus: "DECIDED", lastError: null }).where(eq(moderationMessages.id, messageId));

    if (result)
      await tx.update(usageMonthly).set({
        messagesModerated: sql`${usageMonthly.messagesModerated} + 1`, jevRequests: sql`${usageMonthly.jevRequests} + 1`,
        jevInputTokens: sql`${usageMonthly.jevInputTokens} + ${result.inputTokens}`, ruleEvaluations: sql`${usageMonthly.ruleEvaluations} + ${rules.length}`,
        actionsAllow: sql`${usageMonthly.actionsAllow} + ${decision.action === "ALLOW" ? 1 : 0}`, actionsReview: sql`${usageMonthly.actionsReview} + ${decision.action === "REVIEW" ? 1 : 0}`,
      }).where(usageWhere);

  });
  await executeAction(db, messageId);
}

async function executeAction(db: Database, messageId: string) {
  await db.transaction(async (tx) => {
    const [entry] = await tx.select({ action: moderationActions, message: moderationMessages, decision: moderationDecisions })
      .from(moderationActions).innerJoin(moderationDecisions, eq(moderationDecisions.id, moderationActions.decisionId))
      .innerJoin(moderationMessages, eq(moderationMessages.id, moderationDecisions.messageId))
      .where(eq(moderationMessages.id, messageId)).for("update");
    if (!entry || entry.action.status !== "pending") return;
    const [community] = await tx.select().from(communities).where(eq(communities.id, entry.message.communityId));
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, community.organizationId));
    const [newer] = await tx.select({ id: moderationMessages.id }).from(moderationMessages).where(and(eq(moderationMessages.communityId, community.id), eq(moderationMessages.platformMessageId, entry.message.platformMessageId), gt(moderationMessages.revision, entry.message.revision))).limit(1);
    const [bot] = await tx.select().from(botConnections).where(eq(botConnections.id, community.botConnectionId));
    const skip = newer || org.status !== "active" || !community.moderationEnabled || community.status !== "active" || bot.status !== "active";
    let status = skip ? "ignored" : "success";
    let externalResult: { code?: number; description?: string } = { description: skip ? "Skipped: moderation paused, disconnected, or message superseded" : "Message deleted" };
    if (!skip) {
      try {
        await telegram<boolean>(await decryptToken(bot.encryptedToken), "deleteMessage", { chat_id: community.externalId, message_id: Number(entry.message.platformMessageId) });
      } catch (error) {
        if (!(error instanceof TelegramError) || error.retryable) throw error;
        // Delete is an idempotent desired state, including a prior successful call whose DB commit failed.
        const alreadyGone = error.code === 400 && /message to delete not found/i.test(error.description);
        status = alreadyGone ? "success" : "failed";
        externalResult = { code: error.code, description: alreadyGone ? "Message already absent" : error.description };
      }
    }
    await tx.update(moderationActions).set({ status, externalResult, executedAt: new Date() }).where(eq(moderationActions.id, entry.action.id));
    await tx.update(moderationMessages).set({ processingStatus: status === "failed" ? "FAILED" : "ACTION_EXECUTED", lastError: status === "failed" ? "Telegram rejected deletion" : null }).where(eq(moderationMessages.id, messageId));
    if (status === "success") {
      const month = monthStart(entry.decision.createdAt);
      await tx.update(usageMonthly).set({ actionsDelete: sql`${usageMonthly.actionsDelete} + 1` })
        .where(and(eq(usageMonthly.organizationId, community.organizationId), eq(usageMonthly.yearMonth, month)));
    }
  });
}
