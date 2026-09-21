import type { Action, Decision, Evaluation } from "../moderation/policy";

export type DashboardData = {
  user: { name: string; email: string };
  organization: { id: string; name: string };
  bot: { id: string; username: string; status: string } | null;
  communities: { id: string; name: string; externalId: string; username: string | null; status: string; moderationEnabled: boolean }[];
  rules: { id: string; communityId: string; name: string; ruleText: string; action: "DELETE" | "REVIEW"; priority: number; enabled: boolean }[];
  usage: {
    yearMonth: string; messagesReceived: number; messagesModerated: number; jevRequests: number; jevInputTokens: number;
    ruleEvaluations: number; actionsDelete: number; actionsReview: number; actionsAllow: number; testsToday: number;
  };
  limits: { communities: number; enabledRules: number; messagesPerMonth: number; testsPerDay: number };
  recentLogs: {
    id: string; communityId: string; communityName: string; platformUserId: string | null; text: string; receivedAt: string; processingStatus: string;
    decision: { id: string; action: Action; winningRuleId: string | null; reason: string; policyVersion: string; inputTokens: number; latencyMs: number; evaluated: boolean } | null;
    evaluations: { ruleId: string; ruleName: string; ruleText: string; configuredAction: Action; priority: number; probability: number; matched: boolean; providerModel: string }[];
    action: { action: Action; status: string; executedAt: string | null } | null;
    feedback: { expectedAction: Action; comment: string | null; createdAt: string }[];
  }[];
  dailyStats: { date: string; received: number; moderated: number; deleted: number; review: number; allowed: number }[];
  costEstimate: { currency: "USD"; inputTokens: number; pricePerMillionTokens: number; estimatedUsd: number };
};

export type TestRulesResult = { evaluations: Evaluation[]; decision: Decision; model: string; inputTokens: number; latencyMs: number };
export type DashboardError = { error: { code: string; message: string } };
