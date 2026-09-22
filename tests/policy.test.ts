import { describe, expect, it } from "vitest";
import { buildQuestions } from "../src/modules/moderation/jev";
import { decide, type Rule } from "../src/modules/moderation/decision";

const rule = (id: string, action: Rule["action"] = "WARN", extra: Partial<Rule> = {}): Rule => ({ id, name: id, ruleText: "Rule " + id, action, actionDurationSeconds: action === "MUTE" ? 3600 : null, deleteMessage: false, priority: 100, ...extra });
const matched = (rules: Rule[], probability = 0.99) => rules.map((item) => ({ ruleId: item.id, probability }));
const progression = { warningMuteAt: 3, warningMuteDurationSeconds: 3600, warningBanAt: 4, warningBanDurationSeconds: null };

describe("deterministic decision engine", () => {
  it.each([[0, "NO_MATCH"], [0.74999, "NO_MATCH"], [0.75, "REVIEW"], [0.94999, "REVIEW"], [0.95, "MATCHED"], [1, "MATCHED"]])("probability %s produces %s", (probability, state) => {
    expect(decide([rule("r")], [{ ruleId: "r", probability }]).state).toBe(state);
  });
  it("returns no match for no rules", () => expect(decide([], []).state).toBe("NO_MATCH"));
  it("validates missing, duplicate, unknown and invalid NOUL values", () => {
    expect(() => decide([rule("r")], [])).toThrow();
    expect(() => decide([rule("r")], [{ ruleId: "unknown", probability: 1 }])).toThrow();
    expect(() => decide([rule("r")], [{ ruleId: "r", probability: 1 }, { ruleId: "r", probability: 1 }])).toThrow();
    for (const probability of [NaN, Infinity, -0.01, 1.01]) expect(() => decide([rule("r")], [{ ruleId: "r", probability }])).toThrow();
  });
  it("does not send action configuration to JEV questions", () => {
    const original = rule("r", "BAN", { actionDurationSeconds: 123, deleteMessage: true, priority: 900 });
    const changed = rule("r", "WARN", { actionDurationSeconds: null, deleteMessage: false, priority: 1 });
    expect(buildQuestions([original])).toEqual(buildQuestions([changed]));
    expect(JSON.stringify(buildQuestions([original]))).not.toContain("BAN");
  });
  it("resolves multiple matching rules by severity before priority", () => {
    const rules = [rule("warn", "WARN", { priority: 100 }), rule("ban", "BAN", { priority: 1, actionDurationSeconds: 7200 })];
    expect(decide(rules, matched(rules)).resolvedAction).toBe("BAN");
    expect(decide(rules, matched(rules)).actionRuleId).toBe("ban");
  });
  it("accumulates warnings across rules and escalates on third and fourth", () => {
    const rules = [rule("spam"), rule("abuse", "WARN", { priority: 200 })];
    expect(decide(rules, matched(rules), progression, 1)).toMatchObject({ warningNumber: 2, resolvedAction: "WARN" });
    expect(decide(rules, matched(rules), progression, 2)).toMatchObject({ warningNumber: 3, resolvedAction: "MUTE", actionDurationSeconds: 3600, actionOrigin: "ESCALATED" });
    expect(decide(rules, matched(rules), progression, 3)).toMatchObject({ warningNumber: 4, resolvedAction: "BAN", actionDurationSeconds: null });
  });
  it("keeps direct mute/ban independent from the warning counter", () => {
    const rules = [rule("warn"), rule("mute", "MUTE", { actionDurationSeconds: 600 })];
    expect(decide(rules, matched(rules), progression, 0)).toMatchObject({ warningNumber: 1, resolvedAction: "MUTE", actionDurationSeconds: 600, actionOrigin: "DIRECT" });
    expect(decide([rule("mute", "MUTE", { actionDurationSeconds: 600 })], [{ ruleId: "mute", probability: 0.99 }], progression, 99).warningNumber).toBeNull();
  });
  it("keeps delete as an independent output from any matched rule", () => {
    const rules = [rule("warn", "WARN", { deleteMessage: false }), rule("delete", "WARN", { deleteMessage: true })];
    expect(decide(rules, matched(rules), progression, 0)).toMatchObject({ state: "MATCHED", deleteRequested: true, deleteRuleId: "delete" });
  });
  it("uses stable tie breakers: permanent, duration, priority, probability, id", () => {
    const permanent = rule("permanent", "BAN", { priority: 1, actionDurationSeconds: null });
    const temporary = rule("temporary", "BAN", { priority: 900, actionDurationSeconds: 3600 });
    expect(decide([temporary, permanent], matched([temporary, permanent])).actionRuleId).toBe("permanent");
    const long = rule("long", "MUTE", { priority: 1, actionDurationSeconds: 7200 });
    const short = rule("short", "MUTE", { priority: 999, actionDurationSeconds: 3600 });
    expect(decide([short, long], matched([short, long])).actionRuleId).toBe("long");
  });
});
