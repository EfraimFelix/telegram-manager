export const DECISION_VERSION = "v2-0.75-0.95";
export const REVIEW_THRESHOLD = 0.75;
export const MATCH_THRESHOLD = 0.95;

export type DecisionState = "SKIPPED" | "NO_MATCH" | "REVIEW" | "MATCHED";
export type RuleAction = "WARN" | "MUTE" | "BAN";
export type ExecutionAction = "WARN" | "DELETE" | "MUTE" | "BAN";
export type ActionOrigin = "DIRECT" | "ESCALATED";
export type Rule = {
  id: string;
  name: string;
  ruleText: string;
  action: RuleAction;
  actionDurationSeconds: number | null;
  deleteMessage: boolean;
  priority: number;
};
export type Evaluation = { ruleId: string; probability: number };
export type WarningConfig = {
  warningMuteAt: number | null;
  warningMuteDurationSeconds: number;
  warningBanAt: number | null;
  warningBanDurationSeconds: number | null;
};
export type Decision = {
  state: DecisionState;
  winningRuleId: string | null;
  reason: string;
  matchedRules: Evaluation[];
  reviewRules: Evaluation[];
  deleteRequested: boolean;
  deleteRuleId: string | null;
  resolvedAction: Exclude<ExecutionAction, "DELETE"> | null;
  actionDurationSeconds: number | null;
  actionRuleId: string | null;
  actionOrigin: ActionOrigin | null;
  warningNumber: number | null;
};

export function validateEvaluations(rules: Rule[], evaluations: Array<{ ruleId: string; probability: unknown }>): asserts evaluations is Evaluation[] {
  if (evaluations.length !== rules.length) throw new Error("JEV returned an incomplete rule evaluation.");
  const expected = new Set(rules.map((rule) => rule.id));
  const seen = new Set<string>();
  for (const evaluation of evaluations) {
    if (!expected.has(evaluation.ruleId) || seen.has(evaluation.ruleId) || typeof evaluation.probability !== "number" || !Number.isFinite(evaluation.probability) || evaluation.probability < 0 || evaluation.probability > 1) {
      throw new Error("JEV returned an invalid rule probability.");
    }
    seen.add(evaluation.ruleId);
  }
  if (seen.size !== expected.size) throw new Error("JEV returned duplicate or missing rule evaluations.");
}

function compareRuleCandidates(a: { rule: Rule; probability: number }, b: { rule: Rule; probability: number }) {
  return b.rule.priority - a.rule.priority || b.probability - a.probability || a.rule.id.localeCompare(b.rule.id);
}

function actionRank(action: Exclude<ExecutionAction, "DELETE">) {
  return action === "BAN" ? 3 : action === "MUTE" ? 2 : 1;
}

type Candidate = { action: Exclude<ExecutionAction, "DELETE">; duration: number | null; rule: Rule; probability: number; origin: ActionOrigin };

function compareCandidates(a: Candidate, b: Candidate) {
  const rank = actionRank(b.action) - actionRank(a.action);
  if (rank) return rank;
  if (a.duration === null && b.duration !== null) return -1;
  if (a.duration !== null && b.duration === null) return 1;
  if (a.duration !== null && b.duration !== null && a.duration !== b.duration) return b.duration - a.duration;
  return compareRuleCandidates(a, b);
}

function emptyDecision(state: DecisionState, reason: string, evaluations: Evaluation[], reviewRules: Evaluation[] = []): Decision {
  return { state, winningRuleId: null, reason, matchedRules: evaluations, reviewRules, deleteRequested: false, deleteRuleId: null, resolvedAction: null, actionDurationSeconds: null, actionRuleId: null, actionOrigin: null, warningNumber: null };
}

export function decide(rules: Rule[], evaluations: Evaluation[], warningConfig?: WarningConfig, activeWarningCount = 0): Decision {
  validateEvaluations(rules, evaluations);
  const byId = new Map(evaluations.map((evaluation) => [evaluation.ruleId, evaluation]));
  const matched = rules.filter((rule) => (byId.get(rule.id)?.probability ?? 0) >= MATCH_THRESHOLD)
    .map((rule) => ({ rule, probability: byId.get(rule.id)!.probability }));
  const review = rules.filter((rule) => {
    const probability = byId.get(rule.id)?.probability ?? 0;
    return probability >= REVIEW_THRESHOLD && probability < MATCH_THRESHOLD;
  }).map((rule) => ({ rule, probability: byId.get(rule.id)!.probability }));

  if (!matched.length) {
    if (!review.length) return emptyDecision("NO_MATCH", "No rule reached the review threshold.", evaluations);
    const best = [...review].sort(compareRuleCandidates)[0];
    return { ...emptyDecision("REVIEW", "A rule is in the review band but no rule reached the match threshold.", evaluations, review.map(({ rule }) => byId.get(rule.id)!)), winningRuleId: best.rule.id };
  }

  const deleteRule = matched.filter(({ rule }) => rule.deleteMessage).sort(compareRuleCandidates)[0];
  const candidates: Candidate[] = matched.filter(({ rule }) => rule.action !== "WARN").map(({ rule, probability }) => ({
    action: rule.action, duration: rule.actionDurationSeconds, rule, probability, origin: "DIRECT",
  }));
  const warningRules = matched.filter(({ rule }) => rule.action === "WARN").sort(compareRuleCandidates);
  const warningNumber = warningRules.length ? activeWarningCount + 1 : null;
  if (warningRules.length) {
    const warning = warningRules[0];
    let escalation: Candidate = { action: "WARN", duration: null, rule: warning.rule, probability: warning.probability, origin: "ESCALATED" };
    if (warningConfig?.warningBanAt !== null && warningConfig?.warningBanAt !== undefined && warningNumber! >= warningConfig.warningBanAt) {
      escalation = { action: "BAN", duration: warningConfig.warningBanDurationSeconds, rule: warning.rule, probability: warning.probability, origin: "ESCALATED" };
    } else if (warningConfig?.warningMuteAt !== null && warningConfig?.warningMuteAt !== undefined && warningNumber! >= warningConfig.warningMuteAt) {
      escalation = { action: "MUTE", duration: warningConfig.warningMuteDurationSeconds, rule: warning.rule, probability: warning.probability, origin: "ESCALATED" };
    }
    candidates.push(escalation);
  }
  const winner = candidates.sort(compareCandidates)[0] ?? null;
  return {
    state: "MATCHED",
    winningRuleId: winner?.rule.id ?? warningRules[0]?.rule.id ?? null,
    reason: winner ? `Matched rules resolved to ${winner.action}${winner.origin === "ESCALATED" ? " by warning progression" : " directly"}.` : "A rule matched without a disciplinary action.",
    matchedRules: matched.map(({ rule }) => byId.get(rule.id)!), reviewRules: [], deleteRequested: !!deleteRule, deleteRuleId: deleteRule?.rule.id ?? null,
    resolvedAction: winner?.action ?? null, actionDurationSeconds: winner?.duration ?? null, actionRuleId: winner?.rule.id ?? null, actionOrigin: winner?.origin ?? null, warningNumber,
  };
}

