import { sql } from "drizzle-orm";
import { boolean, check, date, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());
const id = () => uuid("id").defaultRandom().primaryKey();
export const decisionStateEnum = pgEnum("moderation_decision_state", ["SKIPPED", "NO_MATCH", "REVIEW", "MATCHED"]);
export const ruleActionEnum = pgEnum("moderation_rule_action", ["WARN", "MUTE", "BAN"]);
export const executionActionEnum = pgEnum("moderation_execution_action", ["WARN", "DELETE", "MUTE", "BAN"]);
export const actionStatusEnum = pgEnum("moderation_action_status", ["PENDING", "SUCCESS", "FAILED", "SKIPPED"]);
export const botConnectionScopeEnum = pgEnum("bot_connection_scope", ["SYSTEM", "ORGANIZATION"]);
export const communityConnectionAttemptStateEnum = pgEnum("community_connection_attempt_state", ["PENDING", "DISCOVERED", "COMPLETED", "EXPIRED", "FAILED"]);

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
  id: id(), organizationId: uuid("organization_id").references(() => organizations.id),
  externalId: text("external_id").notNull().unique(), username: text("username").notNull(),
  encryptedToken: text("encrypted_token").notNull(), webhookSecretHash: text("webhook_secret_hash").notNull(),
  scope: botConnectionScopeEnum("scope").default("ORGANIZATION").notNull(),
  status: text("status").default("pending").notNull(), createdAt: createdAt(),
}, (t) => [uniqueIndex("one_bot_per_organization").on(t.organizationId)]);
export const communities = pgTable("communities", {
  id: id(), organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  botConnectionId: uuid("bot_connection_id").notNull().references(() => botConnections.id),
  platform: text("platform").default("telegram").notNull(), externalId: text("external_id").notNull(), name: text("name").notNull(), username: text("username"),
  telegramChatType: text("telegram_chat_type").default("supergroup").notNull(),
  status: text("status").default("active").notNull(), moderationEnabled: boolean("moderation_enabled").default(false).notNull(),
  warningWindowDays: integer("warning_window_days").default(30).notNull(), publicWarningsEnabled: boolean("public_warnings_enabled").default(false).notNull(),
  warningMuteAt: integer("warning_mute_at").default(3), warningMuteDurationSeconds: integer("warning_mute_duration_seconds").default(3600).notNull(),
  warningBanAt: integer("warning_ban_at").default(4), warningBanDurationSeconds: integer("warning_ban_duration_seconds"),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("community_external_idx").on(t.platform, t.externalId), index("community_org_idx").on(t.organizationId)]);
export const communityConnectionAttempts = pgTable("community_connection_attempts", {
  id: id(), organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  botConnectionId: uuid("bot_connection_id").notNull().references(() => botConnections.id),
  createdBy: text("created_by").notNull().references(() => user.id),
  codeHash: text("code_hash").notNull().unique(),
  state: communityConnectionAttemptStateEnum("state").default("PENDING").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  telegramUserId: text("telegram_user_id"),
  candidateExternalId: text("candidate_external_id"), candidateName: text("candidate_name"), candidateUsername: text("candidate_username"),
  candidateChatType: text("candidate_chat_type"), botIsAdmin: boolean("bot_is_admin").default(false).notNull(), userIsAdmin: boolean("user_is_admin").default(false).notNull(),
  errorCode: text("error_code"), errorMessage: text("error_message"),
  communityId: uuid("community_id").references(() => communities.id), consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("connection_attempt_org_idx").on(t.organizationId, t.createdAt), index("connection_attempt_state_idx").on(t.state, t.expiresAt)]);
export const moderationRules = pgTable("moderation_rules", {
  id: id(), communityId: uuid("community_id").notNull().references(() => communities.id),
  name: text("name").notNull(), ruleText: text("rule_text").notNull(), action: ruleActionEnum("action").notNull(), actionDurationSeconds: integer("action_duration_seconds"), deleteMessage: boolean("delete_message").default(false).notNull(),
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
  ruleText: text("rule_text").notNull(), ruleName: text("rule_name").notNull(), configuredAction: ruleActionEnum("configured_action").notNull(), actionDurationSeconds: integer("action_duration_seconds"), deleteMessage: boolean("delete_message").notNull(), priority: integer("priority").notNull(),
  probability: doublePrecision("probability").notNull(), matched: boolean("matched").notNull(),
  provider: text("provider").default("jev").notNull(), providerModel: text("provider_model").notNull(), createdAt: createdAt(),
}, (t) => [uniqueIndex("evaluation_message_rule_idx").on(t.messageId, t.ruleId), check("valid_probability", sql`${t.probability} >= 0 AND ${t.probability} <= 1`)]);
export const moderationDecisions = pgTable("moderation_decisions", {
  id: id(), messageId: uuid("message_id").notNull().unique().references(() => moderationMessages.id),
  state: decisionStateEnum("state").notNull(), winningRuleId: uuid("winning_rule_id").references(() => moderationRules.id),
  reason: text("reason").notNull(), decisionVersion: text("decision_version").notNull(), inputTokens: integer("input_tokens").default(0).notNull(),
  latencyMs: integer("latency_ms").default(0).notNull(), createdAt: createdAt(),
});
export const moderationActions = pgTable("moderation_actions", {
  id: id(), decisionId: uuid("decision_id").notNull().references(() => moderationDecisions.id), ruleId: uuid("rule_id").references(() => moderationRules.id),
  action: executionActionEnum("action").notNull(), durationSeconds: integer("duration_seconds"), status: actionStatusEnum("status").default("PENDING").notNull(),
  externalResult: jsonb("external_result").$type<{ code?: number; description?: string; reason?: string }>(), executedAt: timestamp("executed_at", { withTimezone: true }), createdAt: createdAt(),
}, (t) => [uniqueIndex("action_decision_action_idx").on(t.decisionId, t.action), index("actions_decision_idx").on(t.decisionId)]);
export const moderationWarnings = pgTable("moderation_warnings", {
  id: id(), decisionId: uuid("decision_id").notNull().unique().references(() => moderationDecisions.id), communityId: uuid("community_id").notNull().references(() => communities.id),
  ruleId: uuid("rule_id").notNull().references(() => moderationRules.id), platformUserId: text("platform_user_id").notNull(), platformMessageId: text("platform_message_id").notNull(),
  warningNumber: integer("warning_number").notNull(), createdAt: createdAt(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("warning_message_idx").on(t.communityId, t.platformMessageId), index("warnings_user_window_idx").on(t.communityId, t.platformUserId, t.expiresAt)]);
export const moderationFeedback = pgTable("moderation_feedback", {
  id: id(), decisionId: uuid("decision_id").notNull().references(() => moderationDecisions.id), userId: text("user_id").notNull().references(() => user.id),
  expectedState: decisionStateEnum("expected_state").notNull(), comment: text("comment"), createdAt: createdAt(),
}, (t) => [uniqueIndex("feedback_decision_user_idx").on(t.decisionId, t.userId)]);
export const usageMonthly = pgTable("usage_monthly", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id), yearMonth: date("year_month").notNull(),
  messagesReceived: integer("messages_received").default(0).notNull(), messagesModerated: integer("messages_moderated").default(0).notNull(),
  jevRequests: integer("jev_requests").default(0).notNull(), jevInputTokens: integer("jev_input_tokens").default(0).notNull(),
  ruleEvaluations: integer("rule_evaluations").default(0).notNull(), decisionsNoMatch: integer("decisions_no_match").default(0).notNull(),
  decisionsReview: integer("decisions_review").default(0).notNull(), decisionsMatched: integer("decisions_matched").default(0).notNull(), warningsRecorded: integer("warnings_recorded").default(0).notNull(),
  actionsWarn: integer("actions_warn").default(0).notNull(), actionsDelete: integer("actions_delete").default(0).notNull(), actionsMute: integer("actions_mute").default(0).notNull(), actionsBan: integer("actions_ban").default(0).notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.yearMonth] })]);
export const ruleTestUsage = pgTable("rule_test_usage", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id), day: date("day").notNull(), count: integer("count").default(0).notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.day] })]);
