import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { LambdaFunctionURLHandler } from "aws-lambda";
import { z } from "zod";
import { required } from "../lib/config";
import { secretHash, verifySecret, webhookSecret } from "../modules/telegram/crypto";
import { extractConnectionAttempt, extractMessage, updateSchema } from "../modules/telegram/updates";

const queue = new SQSClient({});
const botIdSchema = z.string().uuid();

export const handler: LambdaFunctionURLHandler = async (event) => {
  const reply = (statusCode: number) => ({ statusCode, body: statusCode === 200 ? "ok" : "Request rejected" });
  if (event.requestContext.http.method !== "POST") return reply(405);

  const botId = event.rawPath.split("/").filter(Boolean)[0];
  const suppliedSecret = event.headers["x-telegram-bot-api-secret-token"];
  if (!botIdSchema.safeParse(botId).success || !suppliedSecret || suppliedSecret.length > 256) return reply(403);

  const body = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
  if (Buffer.byteLength(body) > 128_000) return reply(413);

  try {
    const expectedSecretHash = secretHash(await webhookSecret(botId));
    if (!verifySecret(suppliedSecret, expectedSecretHash)) return reply(403);

    let raw: unknown;
    try { raw = JSON.parse(body); } catch { return reply(400); }
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) return reply(400);
    const connection = extractConnectionAttempt(parsed.data);
    const message = connection ? null : extractMessage(parsed.data);
    if (!connection && !message) return reply(200);
    const connectionPayload = connection ? (({ code, ...rest }) => ({ ...rest, codeHash: secretHash(code) }))(connection) : null;

    await queue.send(new SendMessageCommand({
      QueueUrl: required("QUEUE_URL"),
      MessageBody: JSON.stringify(connectionPayload ? { kind: "connection", botId, connection: connectionPayload } : { kind: "message", botId, message }),
    }));
    return reply(200);
  } catch (error) {
    console.error(JSON.stringify({ event: "webhook_failed", botId }));
    throw error; // Function URL returns 5xx, Telegram retries, and Lambda records an error metric.
  }
};
