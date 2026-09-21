import type { DashboardData as DashboardPayload } from "../modules/dashboard/contracts";

export type Action = "ALLOW" | "REVIEW" | "DELETE";
export type Rule = { id: string; communityId: string; name: string; ruleText: string; action: "DELETE" | "REVIEW"; priority: number; enabled: boolean };
export type Evaluation = { ruleId: string; ruleName?: string; probability: number };
export type TestResult = { action: Action; reason: string; evaluations?: Evaluation[]; matchedRules?: Evaluation[] };
export type TestResponse = { evaluations: Evaluation[]; decision: TestResult };
export type DashboardData = DashboardPayload;

export async function request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined, signal,
  });
  if (response.status === 401 && path === "/api/dashboard") {
    window.location.replace("/sign-in");
    throw new Error("Your session has ended. Please sign in again.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    const message = typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message;
    throw new Error(typeof message === "string" ? message : response.status >= 500 || response.status === 404
      ? "The service is unavailable or setup is incomplete. Please try again after the service has been configured."
      : "The request could not be completed. Please try again.");
  }
  if (data === null && response.status !== 204) throw new Error("The service returned an unexpected response. Please try again.");
  return data as T;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
export const number = (value: number) => value.toLocaleString("en-US");
export const probability = (value?: number | null) => typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "Not available";
