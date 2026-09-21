import { z } from "zod";

const message = z.object({
  message_id: z.number().int().positive(), date: z.number().int().nonnegative(), edit_date: z.number().int().nonnegative().optional(),
  chat: z.object({ id: z.number().int().safe(), type: z.string() }),
  from: z.object({ id: z.number().int().safe(), is_bot: z.boolean().optional() }).optional(),
  text: z.string().max(16_384).optional(), caption: z.string().max(16_384).optional(),
});
export const updateSchema = z.object({ update_id: z.number().int().nonnegative(), message: message.optional(), edited_message: message.optional() });
export function extractMessage(update: z.infer<typeof updateSchema>) {
  const msg = update.edited_message ?? update.message;
  if (!msg || !["group", "supergroup"].includes(msg.chat.type) || msg.from?.is_bot) return null;
  const text = msg.text ?? msg.caption;
  if (!text?.trim()) return null;
  return { platformMessageId: String(msg.message_id), platformUserId: msg.from ? String(msg.from.id) : null,
    externalId: String(msg.chat.id), revision: update.update_id, text,
    messageType: msg.text ? "text" : "caption", sentAt: new Date(msg.date * 1_000) };
}
