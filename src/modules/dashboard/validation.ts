import { z } from "zod";

const uuid = z.string().uuid();
const nullablePositiveInt = z.number().int().positive().nullable();
const ruleAction = z.enum(["WARN", "MUTE", "BAN"]);
const settings = z.object({
  warningWindowDays: z.number().int().min(1).max(3650), publicWarningsEnabled: z.boolean(), warningMuteAt: nullablePositiveInt,
  warningMuteDurationSeconds: z.number().int().min(60).max(2_147_483_647), warningBanAt: nullablePositiveInt, warningBanDurationSeconds: nullablePositiveInt,
}).superRefine((value, context) => {
  if (value.warningMuteAt !== null && value.warningBanAt !== null && value.warningBanAt <= value.warningMuteAt) context.addIssue({ code: "custom", path: ["warningBanAt"], message: "Ban threshold must be greater than mute threshold." });
});

export const dashboardCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("startConnection") }).strict(),
  z.object({ action: z.literal("confirmConnection"), attemptId: uuid }).strict(),
  z.object({ action: z.literal("toggleModeration"), communityId: uuid, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("saveCommunitySettings"), communityId: uuid, ...settings.shape }).superRefine((value, context) => {
    if (value.warningMuteAt !== null && value.warningBanAt !== null && value.warningBanAt <= value.warningMuteAt) context.addIssue({ code: "custom", path: ["warningBanAt"], message: "Ban threshold must be greater than mute threshold." });
  }).strict(),
  z.object({
    action: z.literal("saveRule"), id: uuid.optional(), communityId: uuid, name: z.string().trim().min(1).max(100), ruleText: z.string().trim().min(1).max(2000),
    ruleAction, actionDurationSeconds: z.number().int().positive().nullable(), deleteMessage: z.boolean(), priority: z.number().int().min(0).max(1000), enabled: z.boolean(),
  }).superRefine((value, context) => {
    if (value.ruleAction === "MUTE" && value.actionDurationSeconds === null) context.addIssue({ code: "custom", path: ["actionDurationSeconds"], message: "Mute requires a duration." });
    if (value.ruleAction === "WARN" && value.actionDurationSeconds !== null) context.addIssue({ code: "custom", path: ["actionDurationSeconds"], message: "Warn does not accept a duration." });
  }).strict(),
  z.object({ action: z.literal("deleteRule"), id: uuid }).strict(),
  z.object({ action: z.literal("testRules"), communityId: uuid, text: z.string().trim().min(1).max(4096) }).strict(),
  z.object({ action: z.literal("feedback"), decisionId: uuid, expectedState: z.enum(["NO_MATCH", "REVIEW", "MATCHED"]), comment: z.string().trim().max(1000).optional() }).strict(),
]);
export type DashboardCommand = z.infer<typeof dashboardCommand>;
