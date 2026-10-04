import type { DashboardData as DashboardPayload } from "../modules/dashboard/contracts";

export type Action = "WARN" | "DELETE" | "MUTE" | "BAN";
export type DecisionState = "SKIPPED" | "NO_MATCH" | "REVIEW" | "MATCHED";
export type Rule = { id: string; communityId: string; name: string; ruleText: string; action: "WARN" | "MUTE" | "BAN"; actionDurationSeconds: number | null; deleteMessage: boolean; priority: number; enabled: boolean };
export type Evaluation = { ruleId: string; ruleName?: string; probability: number };
export type TestResult = { state: Exclude<DecisionState, "SKIPPED">; reason: string; evaluations?: Evaluation[]; matchedRules?: Evaluation[]; reviewRules?: Evaluation[] };
export type TestResponse = { evaluations: Evaluation[]; decision: TestResult };
export type DashboardData = DashboardPayload & {
  participantActivity?: {
    communityId: string;
    joined: number;
    left: number;
    daily: { date: string; joined: number; left: number }[];
    recent: { id: string; type: "JOIN" | "LEAVE"; displayName: string | null; occurredAt: string }[];
  }[];
};

export async function request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined, signal,
  });
  if (response.status === 401 && path === "/api/dashboard") {
    window.location.replace("/sign-in");
    throw new Error("Sua sessão terminou. Entre novamente.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    const message = typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message;
    throw new Error(typeof message === "string" ? message : response.status >= 500 || response.status === 404
      ? "O serviço está indisponível no momento. Tente novamente em instantes."
      : "Não foi possível concluir a solicitação. Tente novamente.");
  }
  if (data === null && response.status !== 204) throw new Error("O serviço retornou uma resposta inesperada. Tente novamente.");
  return data as T;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Algo deu errado. Tente novamente.";
export const number = (value: number) => value.toLocaleString("pt-BR");
export const probability = (value?: number | null) => typeof value === "number" && Number.isFinite(value) ? (value * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%" : "Indisponível";
