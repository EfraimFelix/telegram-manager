import { z } from "zod";

const uuid = z.string().uuid();
export const dashboardCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connectBot"), token: z.string().trim().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,150}$/) }).strict(),
  z.object({ action: z.literal("addCommunity"), chatId: z.string().trim().regex(/^(?:-[1-9]\d{0,19}|@[A-Za-z][A-Za-z0-9_]{4,31})$/) }).strict(),
  z.object({ action: z.literal("toggleModeration"), communityId: uuid, enabled: z.boolean() }).strict(),
  z.object({
    action: z.literal("saveRule"), id: uuid.optional(), communityId: uuid,
    name: z.string().trim().min(1).max(100), ruleText: z.string().trim().min(1).max(2000),
    ruleAction: z.enum(["DELETE", "REVIEW"]), priority: z.number().int().min(0).max(1000), enabled: z.boolean(),
  }).strict(),
  z.object({ action: z.literal("deleteRule"), id: uuid }).strict(),
  z.object({ action: z.literal("testRules"), communityId: uuid, text: z.string().trim().min(1).max(4096) }).strict(),
  z.object({ action: z.literal("feedback"), decisionId: uuid, expectedAction: z.enum(["ALLOW", "REVIEW", "DELETE"]), comment: z.string().trim().max(1000).optional() }).strict(),
]);
export type DashboardCommand = z.infer<typeof dashboardCommand>;
