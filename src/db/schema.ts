import { sql } from "drizzle-orm";
import { boolean, check, date, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());
const id = () => uuid("id").defaultRandom().primaryKey();
export const actionEnum = pgEnum("moderation_action_type", ["ALLOW", "REVIEW", "DELETE"]);

// Better Auth uses string IDs. Domain resources use UUIDs.
export const user = pgTable("users", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(), image: text("image"), createdAt: createdAt(), updatedAt: updatedAt(),
});
export const session = pgTable("sessions", {
  id: text("id").primaryKey(), token: text("token").notNull().unique(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }), ipAddress: text("ip_address"), userAgent: text("user_agent"), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);
export const account = pgTable("accounts", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull(), providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"), refreshToken: text("refresh_token"), idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }), refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"), password: text("password"), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("accounts_user_idx").on(t.userId), uniqueIndex("accounts_provider_idx").on(t.providerId, t.accountId)]);
export const verification = pgTable("verifications", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("verifications_identifier_idx").on(t.identifier)]);
export const rateLimit = pgTable("rate_limits", {
  id: text("id").primaryKey(), key: text("key").notNull().unique(), count: integer("count").notNull(),
  lastRequest: doublePrecision("last_request").notNull(),
});

export const organizations = pgTable("organizations", {
  id: id(), name: text("name").notNull(), ownerUserId: text("owner_user_id").notNull().unique().references(() => user.id),
  plan: text("plan").default("free").notNull(), status: text("status").default("active").notNull(), createdAt: createdAt(), updatedAt: updatedAt(),
});
export const organizationMembers = pgTable("organization_members", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  userId: text("user_id").notNull().references(() => user.id), role: text("role").default("owner").notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.userId] }), uniqueIndex("one_workspace_per_user").on(t.userId)]);
export const botConnections = pgTable("bot_connections", {
  id: id(), organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  externalId: text("external_id").notNull().unique(), username: text("username").notNull(),
  encryptedToken: text("encrypted_token").notNull(), webhookSecretHash: text("webhook_secret_hash").notNull(),
  status: text("status").default("pending").notNull(), createdAt: createdAt(),
}, (t) => [uniqueIndex("one_bot_per_organization").on(t.organizationId)]);
export const communities = pgTable("communities", {
  id: id(), organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  botConnectionId: uuid("bot_connection_id").notNull().references(() => botConnections.id),
  platform: text("platform").default("telegram").notNull(), externalId: text("external_id").notNull(), name: text("name").notNull(), username: text("username"),
  status: text("status").default("active").notNull(), moderationEnabled: boolean("moderation_enabled").default(false).notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("community_external_idx").on(t.platform, t.externalId), index("community_org_idx").on(t.organizationId)]);
export const moderationRules = pgTable("moderation_rules", {
  id: id(), communityId: uuid("community_id").notNull().references(() => communities.id),
  name: text("name").notNull(), ruleText: text("rule_text").notNull(), action: actionEnum("action").notNull(),
  priority: integer("priority").default(100).notNull(), enabled: boolean("enabled").default(true).notNull(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: text("created_by").notNull().references(() => user.id), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("rules_community_idx").on(t.communityId)]);
export const moderationMessages = pgTable("moderation_messages", {
  id: id(), communityId: uuid("community_id").notNull().references(() => communities.id),
  platformMessageId: text("platform_message_id").notNull(), platformUserId: text("platform_user_id"),
  // Each edited version is evaluated; duplicate delivery of that version is ignored.
  revision: integer("revision").notNull(), text: text("text").notNull(), messageType: text("message_type").default("text").notNull(),
  processingStatus: text("processing_status").default("RECEIVED").notNull(), sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(), lastError: text("last_error"), attempts: integer("attempts").default(0).notNull(),
}, (t) => [uniqueIndex("message_version_idx").on(t.communityId, t.platformMessageId, t.revision), index("messages_community_time_idx").on(t.communityId, t.receivedAt)]);
export const moderationRuleEvaluations = pgTable("moderation_rule_evaluations", {
  id: id(), messageId: uuid("message_id").notNull().references(() => moderationMessages.id), ruleId: uuid("rule_id").notNull().references(() => moderationRules.id),
  ruleText: text("rule_text").notNull(), ruleName: text("rule_name").notNull(), configuredAction: actionEnum("configured_action").notNull(), priority: integer("priority").notNull(),
  probability: doublePrecision("probability").notNull(), matched: boolean("matched").notNull(),
  provider: text("provider").default("jev").notNull(), providerModel: text("provider_model").notNull(), createdAt: createdAt(),
}, (t) => [uniqueIndex("evaluation_message_rule_idx").on(t.messageId, t.ruleId), check("valid_probability", sql`${t.probability} >= 0 AND ${t.probability} <= 1`)]);
export const moderationDecisions = pgTable("moderation_decisions", {
  id: id(), messageId: uuid("message_id").notNull().unique().references(() => moderationMessages.id),
  action: actionEnum("action").notNull(), winningRuleId: uuid("winning_rule_id").references(() => moderationRules.id),
  reason: text("reason").notNull(), policyVersion: text("policy_version").notNull(), inputTokens: integer("input_tokens").default(0).notNull(),
  latencyMs: integer("latency_ms").default(0).notNull(), evaluated: boolean("evaluated").default(false).notNull(), createdAt: createdAt(),
});
export const moderationActions = pgTable("moderation_actions", {
  id: id(), decisionId: uuid("decision_id").notNull().unique().references(() => moderationDecisions.id),
  action: actionEnum("action").notNull(), status: text("status").default("pending").notNull(), externalResult: jsonb("external_result").$type<{ code?: number; description?: string }>(),
  executedAt: timestamp("executed_at", { withTimezone: true }), createdAt: createdAt(),
});
export const moderationFeedback = pgTable("moderation_feedback", {
  id: id(), decisionId: uuid("decision_id").notNull().references(() => moderationDecisions.id), userId: text("user_id").notNull().references(() => user.id),
  expectedAction: actionEnum("expected_action").notNull(), comment: text("comment"), createdAt: createdAt(),
}, (t) => [uniqueIndex("feedback_decision_user_idx").on(t.decisionId, t.userId)]);
export const usageMonthly = pgTable("usage_monthly", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id), yearMonth: date("year_month").notNull(),
  messagesReceived: integer("messages_received").default(0).notNull(), messagesModerated: integer("messages_moderated").default(0).notNull(),
  jevRequests: integer("jev_requests").default(0).notNull(), jevInputTokens: integer("jev_input_tokens").default(0).notNull(),
  ruleEvaluations: integer("rule_evaluations").default(0).notNull(), actionsDelete: integer("actions_delete").default(0).notNull(),
  actionsReview: integer("actions_review").default(0).notNull(), actionsAllow: integer("actions_allow").default(0).notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.yearMonth] })]);
export const ruleTestUsage = pgTable("rule_test_usage", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id), day: date("day").notNull(), count: integer("count").default(0).notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.day] })]);
