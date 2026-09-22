import type { SQSHandler } from "aws-lambda";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database } from "../db";
import { botConnections, communities, communityConnectionAttempts, moderationMessages, usageMonthly } from "../db/schema";
import { moderateMessage } from "../modules/moderation/service";
import { telegram } from "../modules/telegram/client";
import { decryptToken } from "../modules/telegram/crypto";
import { monthStart } from "../modules/usage/limits";

const messageJobSchema = z.object({
  kind: z.literal("message").optional(),
  botId: z.string().uuid(),
  message: z.object({
    platformMessageId: z.string(),
    platformUserId: z.string().nullable(),
    externalId: z.string(),
    revision: z.number().int().nonnegative(),
    text: z.string().min(1).max(16_384),
    messageType: z.enum(["text", "caption"]),
    sentAt: z.coerce.date(),
  }),
});
const connectionJobSchema = z.object({
  kind: z.literal("connection"), botId: z.string().uuid(),
  connection: z.object({ codeHash: z.string().length(64), telegramUserId: z.string(), externalId: z.string(), chatType: z.enum(["group", "supergroup"]), messageId: z.string() }),
});
const jobSchema = z.union([messageJobSchema, connectionJobSchema]);

type TelegramMember = { status: string; can_delete_messages?: boolean; can_restrict_members?: boolean };
type TelegramChat = { id: number; type: string; title?: string; username?: string };

function isAdmin(member: TelegramMember | undefined) { return member?.status === "administrator" || member?.status === "creator"; }

function permissionError(chatType: string, bot: TelegramMember | undefined, user: TelegramMember | undefined) {
  if (!isAdmin(user)) return { code: "USER_PERMISSIONS", message: "The Telegram account that started the connection must be a group administrator." };
  if (!bot || !isAdmin(bot)) return { code: "BOT_PERMISSIONS", message: "Make the Telegram Manager bot an administrator in this group." };
  if (bot.status !== "creator" && bot.can_delete_messages !== true) return { code: "BOT_DELETE_PERMISSION", message: "Grant the bot permission to delete messages." };
  if (chatType === "supergroup" && bot.status !== "creator" && bot.can_restrict_members !== true) return { code: "BOT_RESTRICT_PERMISSION", message: "Grant the bot permission to restrict members." };
  return null;
}

export async function persistConnection(db: Database, job: z.infer<typeof connectionJobSchema>) {
  const [bot] = await db.select().from(botConnections).where(and(eq(botConnections.id, job.botId), eq(botConnections.scope, "SYSTEM"), eq(botConnections.status, "active")));
  if (!bot) return;
  const systemBot = bot;
  const token = await decryptToken(bot.encryptedToken);
  const chat = await telegram<TelegramChat>(token, "getChat", { chat_id: job.connection.externalId });
  const botMember = await telegram<TelegramMember>(token, "getChatMember", { chat_id: chat.id, user_id: Number(bot.externalId) });
  const userMember = await telegram<TelegramMember>(token, "getChatMember", { chat_id: chat.id, user_id: Number(job.connection.telegramUserId) });
  const permission = permissionError(chat.type, botMember, userMember);

  await db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(communityConnectionAttempts).where(eq(communityConnectionAttempts.codeHash, job.connection.codeHash)).for("update");
    if (!attempt || attempt.botConnectionId !== systemBot.id || attempt.expiresAt <= new Date() || !["PENDING", "DISCOVERED"].includes(attempt.state)) {
      if (attempt && attempt.expiresAt <= new Date() && ["PENDING", "DISCOVERED"].includes(attempt.state)) await tx.update(communityConnectionAttempts).set({ state: "EXPIRED", errorCode: "EXPIRED", errorMessage: "This connection link expired." }).where(eq(communityConnectionAttempts.id, attempt.id));
      return;
    }
    const values = {
      telegramUserId: job.connection.telegramUserId, candidateExternalId: String(chat.id), candidateName: chat.title ?? chat.username ?? "Telegram community", candidateUsername: chat.username, candidateChatType: chat.type,
      botIsAdmin: isAdmin(botMember), userIsAdmin: isAdmin(userMember), errorCode: permission?.code ?? null, errorMessage: permission?.message ?? null,
      state: "DISCOVERED" as const,
    };
    await tx.update(communityConnectionAttempts).set(values).where(eq(communityConnectionAttempts.id, attempt.id));
  });
}

export async function persistIncoming(db: Database, job: z.infer<typeof messageJobSchema>) {
  return db.transaction(async (tx) => {
    const [community] = await tx.select({ id: communities.id, organizationId: communities.organizationId })
      .from(communities)
      .innerJoin(botConnections, and(
        eq(botConnections.id, communities.botConnectionId),
        or(eq(botConnections.scope, "SYSTEM"), eq(botConnections.organizationId, communities.organizationId)),
      ))
      .where(and(
        eq(botConnections.id, job.botId),
        eq(botConnections.status, "active"),
        eq(communities.externalId, job.message.externalId),
      ));
    if (!community) return null;

    const [inserted] = await tx.insert(moderationMessages).values({
      communityId: community.id,
      platformMessageId: job.message.platformMessageId,
      platformUserId: job.message.platformUserId,
      revision: job.message.revision,
      text: job.message.text,
      messageType: job.message.messageType,
      sentAt: job.message.sentAt,
    }).onConflictDoNothing().returning({ id: moderationMessages.id });

    if (inserted) {
      await tx.insert(usageMonthly).values({ organizationId: community.organizationId, yearMonth: monthStart(), messagesReceived: 1 })
        .onConflictDoUpdate({
          target: [usageMonthly.organizationId, usageMonthly.yearMonth],
          set: { messagesReceived: sql`${usageMonthly.messagesReceived} + 1` },
        });
      return inserted.id;
    }

    const [existing] = await tx.select({ id: moderationMessages.id }).from(moderationMessages).where(and(
      eq(moderationMessages.communityId, community.id),
      eq(moderationMessages.platformMessageId, job.message.platformMessageId),
      eq(moderationMessages.revision, job.message.revision),
    ));
    return existing?.id ?? null;
  });
}

export const handler: SQSHandler = async (event) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let messageId: string | null = null;
    try {
      const db = getDb();
      const job = jobSchema.parse(JSON.parse(record.body));
      if (job.kind === "connection") await persistConnection(db, job);
      else {
        messageId = await persistIncoming(db, job);
        if (messageId) await moderateMessage(db, messageId);
      }
    } catch {
      // Only identifiers are logged; message text, tokens and provider payloads stay out of CloudWatch.
      console.error(JSON.stringify({ event: "moderation_failed", messageId, attempt: record.attributes.ApproximateReceiveCount }));
      if (messageId) await getDb().update(moderationMessages).set({
        processingStatus: "FAILED",
        lastError: "Processing failed; retry scheduled or moved to the dead-letter queue",
        attempts: sql`${moderationMessages.attempts} + 1`,
      }).where(eq(moderationMessages.id, messageId)).catch(() => undefined);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
