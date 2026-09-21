import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = mocks.send; },
  SendMessageCommand: class { constructor(public input: unknown) {} },
}));

import { handler } from "../src/functions/webhook";
import { webhookSecret } from "../src/modules/telegram/crypto";

type Result = { statusCode: number; body: string };
const invoke = handler as unknown as (event: object) => Promise<Result>;

function event(botId: string, secret: string, body: unknown) {
  return {
    rawPath: `/${botId}`,
    headers: { "x-telegram-bot-api-secret-token": secret },
    requestContext: { http: { method: "POST" } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

describe("Telegram webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-with-more-than-thirty-two-characters");
    vi.stubEnv("QUEUE_URL", "https://sqs.example.test/queue");
  });

  it("authenticates, normalizes, and enqueues a group message without a database", async () => {
    const botId = randomUUID();
    const response = await invoke(event(botId, await webhookSecret(botId), {
      update_id: 1,
      message: { message_id: 7, date: 1_700_000_000, chat: { id: -100123, type: "supergroup" }, from: { id: 42 }, text: "Hello" },
    }));

    expect(response.statusCode).toBe(200);
    expect(mocks.send).toHaveBeenCalledOnce();
    const payload = JSON.parse(mocks.send.mock.calls[0][0].input.MessageBody);
    expect(payload).toMatchObject({ botId, message: { externalId: "-100123", platformMessageId: "7", revision: 1, text: "Hello" } });
  });

  it("rejects an invalid secret before enqueueing", async () => {
    const response = await invoke(event(randomUUID(), "wrong", { update_id: 1 }));
    expect(response.statusCode).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
