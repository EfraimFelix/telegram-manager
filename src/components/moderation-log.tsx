"use client";

import { useState } from "react";
import { probability, type DashboardData, type DecisionState } from "./dashboard-api";

const labels: Record<DecisionState, string> = { SKIPPED: "Skipped", NO_MATCH: "No match", REVIEW: "Review", MATCHED: "Matched" };
const actionLabels = { WARN: "Warn", DELETE: "Delete", MUTE: "Mute", BAN: "Ban" } as const;
type FeedbackState = "NO_MATCH" | "REVIEW" | "MATCHED";

type Props = {
  logs: DashboardData["recentLogs"];
  disabled: boolean;
  onFeedback: (decisionId: string, expectedState: FeedbackState) => Promise<boolean>;
};

export default function ModerationLog({ logs, disabled, onFeedback }: Props) {
  const [filter, setFilter] = useState<DecisionState | "ALL">("ALL");
  const [saved, setSaved] = useState<Record<string, FeedbackState>>({});
  const visible = logs.filter(log => filter === "ALL" || log.decision?.state === filter);
  return <section className="panel">
    <div className="section-heading"><div><h2>Recent decisions</h2><p>Feedback records your judgment. It does not undo an action in Telegram.</p></div><label className="filter">Decision<select value={filter} onChange={event => setFilter(event.target.value as DecisionState | "ALL")}><option value="ALL">All decisions</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {!visible.length ? <div className="empty"><span className="empty-symbol" aria-hidden="true">◷</span><h3>{logs.length ? "No decisions match this filter." : "The conversation starts here."}</h3><p>{logs.length ? "Try another decision filter." : "Once moderation processes messages, you’ll see decisions and outcomes here."}</p></div> : <div className="log-list">{visible.map(log => {
      const decision = log.decision; const recorded = saved[log.id] ?? log.feedback.at(-1)?.expectedState; const maximumProbability = log.evaluations.reduce<number | null>((maximum, item) => Math.max(maximum ?? 0, item.probability), null);
      return <article className="log-entry" key={log.id}><div className="log-top"><span className={"badge " + (decision?.state.toLowerCase() ?? "")}>{decision ? labels[decision.state] : log.processingStatus.replaceAll("_", " ")}</span><time dateTime={log.receivedAt}>{new Date(log.receivedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></div><p className="message-text">{log.text}</p><small className="message-meta">{log.communityName} · Telegram user {log.platformUserId ?? "unknown"}</small><p>{decision?.reason ?? "Waiting for a moderation decision."}</p>
        {!!log.evaluations.length && <div className="evaluation-list" aria-label="Rule evaluations">{log.evaluations.map(evaluation => <div className="evaluation" key={evaluation.ruleId}><span>{evaluation.ruleName} · {evaluation.configuredAction.toLowerCase()} {evaluation.deleteMessage ? "· delete" : ""}</span><strong>{probability(evaluation.probability)}</strong></div>)}</div>}
        <div className="decision-details"><span>Highest match probability <strong>{probability(maximumProbability)}</strong></span><span>Actions <strong>{log.actions.length ? log.actions.map(action => actionLabels[action.action] + " · " + action.status.toLowerCase()).join(", ") : "None"}</strong></span>{log.warning && <span>Warning <strong>#{log.warning.warningNumber}</strong></span>}</div>
        {decision && decision.state !== "SKIPPED" && <div className="feedback"><span>{recorded ? "Feedback saved: " + labels[recorded] : "Was this decision right?"}</span>{[["Correct", decision.state], ["No match", "NO_MATCH"], ["Review", "REVIEW"]].map(([label, expectedState]) => <button className="secondary small" key={label} disabled={disabled} onClick={async () => { if (await onFeedback(decision.id, expectedState as FeedbackState)) setSaved(current => ({ ...current, [log.id]: expectedState as FeedbackState })); }}>{label}</button>)}</div>}
      </article>;
    })}</div>}
  </section>;
}
