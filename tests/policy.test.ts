import { describe, expect, it } from "vitest";
import { decide, type Rule } from "../src/modules/moderation/policy";
import { buildQuestions } from "../src/modules/moderation/jev";

const rule: Rule = { id: "politics", name: "No politics", ruleText: "Political discussions are not allowed.", action: "DELETE", priority: 300 };
describe("deterministic policy", () => {
  it.each([[0, "ALLOW"], [0.74999, "ALLOW"], [0.75, "REVIEW"], [0.94999, "REVIEW"], [0.95, "DELETE"], [1, "DELETE"]])("probability %s produces %s", (probability, action) => {
    expect(decide([rule], [{ ruleId: rule.id, probability: Number(probability) }]).action).toBe(action);
  });
  it("allows with no rules", () => expect(decide([], []).action).toBe("ALLOW"));
  it("does not promote REVIEW to DELETE", () => expect(decide([{ ...rule, action: "REVIEW" }], [{ ruleId: rule.id, probability: 1 }]).action).toBe("REVIEW"));
  it("action hierarchy precedes custom priority", () => {
    const rules: Rule[] = [rule, { ...rule, id: "ads", action: "REVIEW", priority: 999 }];
    expect(decide(rules, rules.map((r) => ({ ruleId: r.id, probability: 0.99 }))).winningRuleId).toBe("politics");
  });
  it("priority resolves equal-action matches regardless of input order", () => {
    const rules = [rule, { ...rule, id: "abuse", priority: 400 }];
    const evaluations = rules.map((r) => ({ ruleId: r.id, probability: 0.99 }));
    expect(decide(rules, evaluations).winningRuleId).toBe("abuse");
    expect(decide([...rules].reverse(), evaluations)).toEqual(decide(rules, evaluations));
  });
  it.each([NaN, Infinity, -0.01, 1.01])("rejects unsafe probability %s", (probability) => expect(() => decide([rule], [{ ruleId: rule.id, probability }])).toThrow());
  it("rejects missing, duplicate and unknown results", () => {
    expect(() => decide([rule], [])).toThrow();
    expect(() => decide([rule], [{ ruleId: "unknown", probability: 1 }])).toThrow();
    expect(() => decide([rule], [{ ruleId: rule.id, probability: 1 }, { ruleId: rule.id, probability: 1 }])).toThrow();
  });
  it("keeps actions, priorities and tenant data out of model questions", () => {
    expect(buildQuestions([rule])).toEqual(buildQuestions([{ ...rule, action: "REVIEW", priority: 1 }]));
    expect(buildQuestions([rule])[rule.id].type).toBe("noul");
  });
});
