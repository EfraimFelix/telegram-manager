import type { SQSHandler } from "aws-lambda";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database } from "../db";
import { botConnections, communities, moderationMessages, usageMonthly } from "../db/schema";
import { moderateMessage } from "../modules/moderation/service";
import { monthStart } from "../modules/usage/limits";

const jobSchema = z.object({
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

export async function persistIncoming(db: Database, job: z.infer<typeof jobSchema>) {
  return db.transaction(async (tx) => {
    const [community] = await tx.select({ id: communities.id, organizationId: communities.organizationId })
      .from(communities)
      .innerJoin(botConnections, and(
        eq(botConnections.id, communities.botConnectionId),
        eq(botConnections.organizationId, communities.organizationId),
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
      messageId = await persistIncoming(db, jobSchema.parse(JSON.parse(record.body)));
      if (messageId) await moderateMessage(db, messageId);
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
