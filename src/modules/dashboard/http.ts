import { required } from "../../lib/config";
import { TelegramError } from "../telegram/client";

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

export function errorResponse(error: unknown) {
  if (error instanceof AppError) return json({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof TelegramError) return json({ error: { code: "TELEGRAM_ERROR", message: error.retryable ? "Telegram is temporarily unavailable. Please try again." : "Telegram rejected this request. Check the bot token and group permissions." } }, error.retryable ? 503 : 400);
  return json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed. Please try again." } }, 500);
}

export function checkOrigin(request: Request) {
  const allowed = new URL(required("BETTER_AUTH_URL")).origin;
  if (request.headers.get("origin") !== allowed) throw new AppError(403, "INVALID_ORIGIN", "This request must come from the application.");
}

export async function readJson(request: Request, maxBytes = 32_768): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AppError(415, "INVALID_CONTENT_TYPE", "Send application/json.");
  const declaredSize = request.headers.get("content-length");
  if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > maxBytes)) throw new AppError(413, "BODY_TOO_LARGE", "Request body is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "INVALID_JSON", "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError(413, "BODY_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError(400, "INVALID_JSON", "Request body must be valid JSON."); }
}
