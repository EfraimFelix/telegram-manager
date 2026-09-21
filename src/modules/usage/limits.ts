export const FREE_LIMITS = { communities: 1, activeRules: 3, messages: 5_000, ruleTestsPerDay: 30 } as const;
export function monthStart(now = new Date()) { return now.toISOString().slice(0, 7) + "-01"; }
