export const POLICY_VERSION = "v1-0.75-0.95";
export const REVIEW_THRESHOLD = 0.75;
export const MATCH_THRESHOLD = 0.95;
export type Action = "ALLOW" | "REVIEW" | "DELETE";
export type Rule = { id: string; name: string; ruleText: string; action: Action; priority: number };
export type Evaluation = { ruleId: string; probability: number };
export type Decision = { action: Action; winningRuleId?: string; reason: string; matchedRules: Evaluation[] };
const rank: Record<Action, number> = { ALLOW: 0, REVIEW: 1, DELETE: 2 };

export function decide(rules: Rule[], evaluations: Evaluation[]): Decision {
  const probabilities = new Map(evaluations.map((item) => [item.ruleId, item.probability]));
  if (probabilities.size !== rules.length || evaluations.length !== rules.length || rules.some((rule) => {
    const p = probabilities.get(rule.id);
    return p === undefined || !Number.isFinite(p) || p < 0 || p > 1;
  })) throw new Error("Incomplete or invalid rule evaluations");
  const matches = rules.flatMap((rule) => {
    const probability = probabilities.get(rule.id)!;
    if (probability < REVIEW_THRESHOLD || rule.action === "ALLOW") return [];
    return [{ ruleId: rule.id, probability, priority: rule.priority, action: probability >= MATCH_THRESHOLD ? rule.action : "REVIEW" as const }];
  }).sort((a, b) => rank[b.action] - rank[a.action] || b.priority - a.priority || b.probability - a.probability || a.ruleId.localeCompare(b.ruleId));
  const winner = matches[0];
  return {
    action: winner?.action ?? "ALLOW", winningRuleId: winner?.ruleId,
    reason: !winner ? "No rule matched" : winner.probability < MATCH_THRESHOLD ? "Uncertain match requires review" : "Rule matched",
    matchedRules: matches.map(({ ruleId, probability }) => ({ ruleId, probability })),
  };
}
