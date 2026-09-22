import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { botConnections } from "../src/db/schema";
import { required } from "../src/lib/config";
import { telegram } from "../src/modules/telegram/client";
import { encryptToken, secretHash, webhookSecret } from "../src/modules/telegram/crypto";

type TelegramUser = { id: number; is_bot: boolean; username?: string };

async function main() {
  const token = required("TELEGRAM_SYSTEM_BOT_TOKEN");
  const me = await telegram<TelegramUser>(token, "getMe");
  if (!me.is_bot || !me.username) throw new Error("Telegram did not return a valid system bot.");

  const db = getDb();
  const encryptedToken = await encryptToken(token);
  const botId = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(botConnections).where(eq(botConnections.scope, "SYSTEM"));
    if (existing && existing.externalId !== String(me.id)) throw new Error("A different system bot is already configured.");
    const id = existing?.id ?? randomUUID();
    const values = { externalId: String(me.id), username: me.username!, encryptedToken, webhookSecretHash: secretHash(await webhookSecret(id)), status: "pending" };
    if (existing) await tx.update(botConnections).set(values).where(eq(botConnections.id, existing.id));
    else await tx.insert(botConnections).values({ id, organizationId: null, scope: "SYSTEM", ...values });
    return id;
  });

  const base = required("WEBHOOK_BASE_URL").replace(/\/?$/, "/");
  await telegram<boolean>(token, "setWebhook", {
    url: base + botId,
    secret_token: await webhookSecret(botId),
    allowed_updates: ["message", "edited_message"],
    max_connections: 20,
  });
  await db.update(botConnections).set({ status: "active" }).where(eq(botConnections.id, botId));
  console.log(`Configured system bot @${me.username}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "System bot configuration failed.");
  process.exitCode = 1;
});
