import { describe, expect, it } from "vitest";
import { extractConnectionAttempt, extractMessage } from "../src/modules/telegram/updates";

describe("Telegram group connection updates", () => {
  it("extracts a startgroup code and Telegram user", () => {
    expect(extractConnectionAttempt({ update_id: 1, message: { message_id: 4, date: 1_700_000_000, chat: { id: -100123, type: "supergroup" }, from: { id: 99 }, text: "/start@manager_bot code-123" } })).toEqual({ code: "code-123", telegramUserId: "99", externalId: "-100123", chatType: "supergroup", messageId: "4" });
  });

  it("does not send the connection command to moderation", () => {
    const update = { update_id: 1, message: { message_id: 4, date: 1_700_000_000, chat: { id: -100123, type: "supergroup" }, from: { id: 99 }, text: "/start code-123" } };
    expect(extractConnectionAttempt(update)).not.toBeNull();
    expect(extractMessage(update)).toBeNull();
  });

  it("ignores connection commands from private chats and bots", () => {
    expect(extractConnectionAttempt({ update_id: 1, message: { message_id: 4, date: 1_700_000_000, chat: { id: 99, type: "private" }, from: { id: 99 }, text: "/start code-123" } })).toBeNull();
    expect(extractConnectionAttempt({ update_id: 1, message: { message_id: 4, date: 1_700_000_000, chat: { id: -100123, type: "supergroup" }, from: { id: 10, is_bot: true }, text: "/start code-123" } })).toBeNull();
  });
});
