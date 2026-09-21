import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

let cachedSecret: { value: { key: string; typesafeApiKey: string }; expires: number } | undefined;
export async function appSecrets() {
  if (!process.env.APP_SECRET_ARN) return { key: required("BETTER_AUTH_SECRET"), typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "" };
  if (cachedSecret && cachedSecret.expires > Date.now()) return cachedSecret.value;
  const result = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: required("APP_SECRET_ARN") }));
  const value = JSON.parse(result.SecretString ?? "{}") as { key: string; typesafeApiKey: string };
  if (typeof value.key !== "string" || value.key.length < 32) throw new Error("Application secret must contain a key of at least 32 characters");
  cachedSecret = { value, expires: Date.now() + 300_000 };
  return value;
}
