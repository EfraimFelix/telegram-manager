import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appSecrets } from "../../lib/config";

export const secretHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function verifySecret(value: string, hash: string) {
  return /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(secretHash(value), "hex"), Buffer.from(hash, "hex"));
}
async function encryptionKey() {
  const { key } = await appSecrets();
  if (key.length < 32) throw new Error("Application secret must have at least 32 characters");
  return createHash("sha256").update(`telegram-token:${key}`).digest();
}
export async function webhookSecret(botId: string) {
  const { key } = await appSecrets();
  return createHmac("sha256", key).update(`telegram-webhook:${botId}`).digest("base64url");
}
export async function encryptToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
}
export async function decryptToken(value: string) {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted credential");
  const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", await encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
