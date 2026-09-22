import type { Decision, Evaluation, DecisionState, ExecutionAction, RuleAction } from "../moderation/decision";

export type DashboardData = {
  user: { name: string; email: string };
  organization: { id: string; name: string };
  bot: { id: string; username: string; status: string } | null;
  connectionAttempt: {
    id: string; state: string; expiresAt: string;
    candidate: { externalId: string; name: string | null; username: string | null; chatType: string | null; botIsAdmin: boolean; userIsAdmin: boolean } | null;
    errorCode: string | null; errorMessage: string | null;
  } | null;
  communities: {
    id: string; name: string; externalId: string; username: string | null; status: string; moderationEnabled: boolean; telegramChatType: string;
    warningWindowDays: number; publicWarningsEnabled: boolean; warningMuteAt: number | null; warningMuteDurationSeconds: number; warningBanAt: number | null; warningBanDurationSeconds: number | null;
  }[];
  rules: { id: string; communityId: string; name: string; ruleText: string; action: RuleAction; actionDurationSeconds: number | null; deleteMessage: boolean; priority: number; enabled: boolean }[];
  usage: {
    yearMonth: string; messagesReceived: number; messagesModerated: number; jevRequests: number; jevInputTokens: number; ruleEvaluations: number;
    decisionsNoMatch: number; decisionsReview: number; decisionsMatched: number; warningsRecorded: number; actionsWarn: number; actionsDelete: number; actionsMute: number; actionsBan: number; testsToday: number;
  };
  limits: { communities: number; enabledRules: number; messagesPerMonth: number; testsPerDay: number };
  recentLogs: {
    id: string; communityId: string; communityName: string; platformUserId: string | null; text: string; receivedAt: string; processingStatus: string;
    decision: { id: string; state: DecisionState; winningRuleId: string | null; reason: string; decisionVersion: string; inputTokens: number; latencyMs: number } | null;
    evaluations: { ruleId: string; ruleName: string; ruleText: string; configuredAction: RuleAction; actionDurationSeconds: number | null; deleteMessage: boolean; priority: number; probability: number; matched: boolean; providerModel: string }[];
    actions: { action: ExecutionAction; ruleId: string | null; durationSeconds: number | null; status: string; externalResult: { code?: number; description?: string; reason?: string } | null; executedAt: string | null }[];
    warning: { warningNumber: number; expiresAt: string } | null;
    feedback: { expectedState: Exclude<DecisionState, "SKIPPED">; comment: string | null; createdAt: string }[];
  }[];
  dailyStats: { date: string; received: number; moderated: number; noMatch: number; review: number; matched: number }[];
  costEstimate: { currency: "USD"; inputTokens: number; pricePerMillionTokens: number; estimatedUsd: number };
};

export type TestRulesResult = { evaluations: Evaluation[]; decision: Pick<Decision, "state" | "reason" | "matchedRules" | "reviewRules">; model: string; inputTokens: number; latencyMs: number };
export type DashboardError = { error: { code: string; message: string } };
