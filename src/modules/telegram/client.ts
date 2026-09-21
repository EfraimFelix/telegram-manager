export class TelegramError extends Error {
  constructor(public code: number, public description: string, public retryAfter?: number) {
    super(`Telegram request failed (${code})`);
  }
  get retryable() { return this.code === 429 || this.code >= 500; }
}

export async function telegram<T>(token: string, method: string, payload: Record<string, unknown> = {}): Promise<T> {
  // Never log the URL: Telegram embeds the bot credential in it.
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8_000),
    });
  } catch { throw new TelegramError(503, "Telegram could not be reached"); }
  const data = await response.json().catch(() => ({})) as { ok?: boolean; result: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
  if (!response.ok || !data.ok) throw new TelegramError(data.error_code ?? response.status, (data.description ?? "Telegram request failed").replaceAll(token, "[redacted]"), data.parameters?.retry_after);
  return data.result;
}
