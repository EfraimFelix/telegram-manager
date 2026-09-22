"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { errorMessage, number, probability, request, type Action, type DashboardData, type Rule, type TestResult, type TestResponse } from "./dashboard-api";
import ModerationLog from "./moderation-log";

const sections = ["Overview", "Rules & testing", "Moderation log", "Connections"] as const;
const templates = [
  { name: "Spam & promotion", ruleText: "Flag unsolicited advertisements, repeated promotional messages, and referral spam. Allow relevant links shared as part of a genuine conversation." },
  { name: "Scams & phishing", ruleText: "Flag attempts to steal credentials or money, impersonation scams, and deceptive investment offers. Allow people discussing or reporting scams." },
  { name: "Harassment", ruleText: "Flag targeted harassment, threats, and hateful attacks on people or groups. Allow respectful disagreement and constructive criticism." },
];
const emptyRule = { name: "", ruleText: "", action: "WARN" as const, actionDurationSeconds: null, deleteMessage: false, priority: 100, enabled: true };
const labels: Record<Action, string> = { WARN: "Warn", DELETE: "Delete", MUTE: "Mute", BAN: "Ban" };
function Badge({ action }: { action: Action }) { return <span className={`badge ${action.toLowerCase()}`}>{labels[action]}</span>; }

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [section, setSection] = useState<(typeof sections)[number]>("Overview");
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Partial<Rule> | null>(null);
  const [editingAction, setEditingAction] = useState<Rule["action"]>("WARN");
  const [deleting, setDeleting] = useState("");
  const [testText, setTestText] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [connectionUrl, setConnectionUrl] = useState("");
  const busy = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const next = await request<DashboardData>("/api/dashboard", undefined, signal);
    if (!next?.user || !Array.isArray(next.communities) || !Array.isArray(next.rules) || !Array.isArray(next.recentLogs) || !next.limits || !next.usage || !Array.isArray(next.dailyStats)) {
      throw new Error("The dashboard response is incomplete. The service may still be being configured.");
    }
    setData(next);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    const state = data?.connectionAttempt?.state;
    if (!state || !["PENDING", "DISCOVERED"].includes(state)) return;
    const timer = window.setInterval(() => { if (!busy.current) void load().catch(error => setError(errorMessage(error))); }, 2_000);
    return () => window.clearInterval(timer);
  }, [data?.connectionAttempt?.state, load]);
  async function refresh() {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError(""); setNotice("");
    try { await load(); } catch (error) { setError(errorMessage(error)); }
    finally { setLoading(false); busy.current = false; }
  }
  async function mutate(action: string, values: object, success: string): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true; setPending(action); setError(""); setNotice("");
    try {
      const response = await request<TestResponse | { ok: true; attempt?: { startUrl: string } }>("/api/dashboard", { action, ...values });
      if (action === "testRules") {
        if (!("decision" in response) || !response.decision) throw new Error("The test did not return a decision. Please try again.");
        setResult({ ...response.decision, evaluations: response.evaluations });
      }
      if (action === "startConnection" && "attempt" in response && response.attempt?.startUrl) setConnectionUrl(response.attempt.startUrl);
      if (action === "confirmConnection") setConnectionUrl("");
      setNotice(success);
      if (action !== "testRules") {
        try { await load(); } catch (error) { setError(`Your change was saved, but the dashboard could not refresh. ${errorMessage(error)}`); }
      }
      return true;
    } catch (error) { setError(errorMessage(error)); return false; }
    finally { setPending(""); busy.current = false; }
  }
  async function signOut() {
    if (busy.current) return;
    busy.current = true; setPending("signOut"); setError("");
    try { await request("/api/auth/sign-out", {}); window.location.replace("/sign-in"); }
    catch (error) { setError(errorMessage(error)); setPending(""); busy.current = false; }
  }
  const community = data?.communities.find(item => item.id === selected) ?? data?.communities[0];
  const rules = data?.rules.filter(rule => rule.communityId === community?.id) ?? [];
  const activeRules = rules.filter(rule => rule.enabled).length;
  const activeLimit = data?.limits.enabledRules ?? 3;
  const used = data?.usage?.messagesModerated ?? 0;
  const limit = data?.limits.messagesPerMonth ?? 5000;
  const disabled = !!pending || loading;
  function changeCommunity(id: string) { setSelected(id); setEditor(null); setResult(null); setTestText(""); setDeleting(""); }
  function openRuleEditor(rule: Partial<Rule>) { setEditor(rule); setEditingAction(rule.action ?? "WARN"); }
  async function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!community || !editor) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("name")).trim(), ruleText = String(fields.get("ruleText")).trim();
    if (!name || !ruleText) { setError("Please enter a rule name and instructions."); return; }
    const ruleAction = String(fields.get("ruleAction"));
    const durationValue = String(fields.get("actionDurationSeconds") ?? "").trim();
    if (await mutate("saveRule", { id: editor.id, communityId: community.id, name, ruleText, ruleAction, actionDurationSeconds: ruleAction === "WARN" || !durationValue ? null : Number(durationValue), deleteMessage: fields.get("deleteMessage") === "on", priority: Number(fields.get("priority")), enabled: fields.get("enabled") === "on" }, "Rule saved. Run a test to check how it behaves.")) { setEditor(null); setResult(null); }
  }
  return <div className="workspace">
    <a href="#main-content" className="skip-link">Skip to content</a>
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">↗</span><span>Telegram<br /><strong>Manager</strong></span></Link>
      <div className="workspace-label"><span className="avatar">{data?.organization?.name?.[0]?.toUpperCase() ?? "T"}</span><div><strong>{data?.organization?.name ?? "Your workspace"}</strong><small>Free workspace</small></div></div>
      <span className="nav-caption">WORKSPACE</span>
      <nav aria-label="Main navigation">{sections.map((item, index) => <button key={item} aria-current={section === item ? "page" : undefined} onClick={() => { setSection(item); setNotice(""); }}><span aria-hidden="true">{["◫", "☷", "◷", "↗"][index]}</span>{item}</button>)}</nav>
      <div className="sidebar-bottom"><div className="plan-note"><span className="badge">FREE PLAN</span><p>A calmer community,<br />one message at a time.</p><small>1 community · 3 active rules</small></div>
        <div className="account"><span className="avatar">{data?.user.name?.[0]?.toUpperCase() ?? "·"}</span><div><strong>{data?.user.name ?? "Your account"}</strong><button className="text-button" disabled={disabled} onClick={signOut}>{pending === "signOut" ? "Signing out…" : "Sign out"}</button></div></div>
      </div>
    </aside>
    <main id="main-content" className="main-content">
      <header className="topbar"><span>Workspace <span className="separator">/</span> <strong>{section}</strong></span><span className="badge">TELEGRAM MODERATION</span></header>
      <div className="page-content"><header className="page-heading"><div><p className="eyebrow">A CLEARER PICTURE</p><h1>{section === "Overview" ? "Your community, at a glance." : section}</h1><p>{section === "Overview" ? "Keep the conversation flowing. We’ll help with the noise." : section === "Rules & testing" ? "Say what belongs. Test what happens." : section === "Moderation log" ? "Every decision, with the context to understand it." : "Bring your Telegram community into your workspace."}</p></div><button className="secondary" disabled={disabled} onClick={refresh}>{loading ? "Loading…" : "↻ Refresh"}</button></header>
        {error && <div className="notice error" role="alert"><strong>{!data ? "Workspace unavailable" : "We couldn’t complete that request"}</strong><p>{error}</p>{!data && <button className="secondary" disabled={disabled} onClick={refresh}>Try again</button>}</div>}
        {notice && <div className="notice success" role="status">{notice}</div>}
        {!data && !error && <div className="panel empty" role="status" aria-busy="true"><div className="loading-line" /><h2>Getting your workspace ready</h2><p>Loading connections, rules, and recent activity…</p></div>}
        {data && <>
          {data.communities.length > 1 && <label className="community-picker">Community<select value={community?.id ?? ""} onChange={event => changeCommunity(event.target.value)} disabled={disabled}>{data.communities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          {section === "Overview" && <>
            <section className="welcome-banner"><div><span className="eyebrow">{community ? "COMMUNITY STATUS" : "LET’S GET YOU SET UP"}</span><h2>{community ? community.name : "A few small steps to a calmer space."}</h2><p>{community ? community.moderationEnabled ? "Moderation is on. Your enabled rules guide new decisions." : "Moderation is off. Set your rules and test them before switching on." : "Connect a bot, add your group, and make the rules your own."}</p></div><button className="primary" onClick={() => setSection("Connections")}>{community ? "Manage connection →" : "Connect your community →"}</button></section>
            <div className="stats-grid">{[["Messages moderated", used, "This month"], ["No match", data.usage?.decisionsNoMatch ?? 0, "Decision state"], ["Review", data.usage?.decisionsReview ?? 0, "Decision state"], ["Matched", data.usage?.decisionsMatched ?? 0, "Decision state"]].map(([title, value, detail]) => <section className="panel stat" key={title}><span>{title}</span><strong>{number(Number(value))}</strong><small>{detail}</small></section>)}</div>
            <div className="overview-grid"><section className="panel"><div className="section-heading"><div><h2>Community activity</h2><p>Moderation decisions over the last 7 days</p></div><span className="badge">7 DAYS</span></div>
              {data.dailyStats.some(day => day.moderated) ? <div className="chart" role="img" aria-label={data.dailyStats.map(day => `${day.date}: ${day.moderated} decisions`).join("; ")}>{data.dailyStats.map(day => <div className="chart-column" key={day.date}><span>{number(day.moderated)}</span><div className="chart-track"><div style={{ height: `${day.moderated / Math.max(1, ...data.dailyStats.map(item => item.moderated)) * 100}%` }} /></div><small>{new Date(`${day.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })}</small></div>)}</div> : <div className="empty chart-empty"><span className="empty-symbol" aria-hidden="true">▥</span><h3>No activity to show yet</h3><p>Activity will appear here when moderation data is available.</p></div>}
            </section><section className="panel usage-card"><span className="eyebrow">ROOM TO GROW</span><h2>Your monthly allowance</h2><p><strong className="usage-number">{number(used)}</strong> / {number(limit)}</p><progress max={limit} value={Math.min(used, limit)} aria-label="Monthly moderated message allowance" /><p>{used >= limit ? "Monthly allowance reached. Check service status before expecting new moderation." : `${number(Math.max(0, limit - used))} messages remaining this month.`}</p><small>Free plan · Resets each calendar month.<br />Test messages have a separate daily allowance.</small><button className="text-button" onClick={() => setSection("Rules & testing")}>Review your rules →</button></section></div>
            <section className="panel next-step"><div><h2>{rules.length ? "A little fine-tuning goes a long way." : "Your community. Your ground rules."}</h2><p>{rules.length ? `${activeRules} active ${activeRules === 1 ? "rule" : "rules"}. Try a sample message to see how your rules respond.` : "Start with a suggested rule, then adjust it to fit your community."}</p></div><button className="secondary" onClick={() => setSection("Rules & testing")}>{rules.length ? "Test your rules →" : "Set up rules →"}</button></section>
          </>}
          {section === "Connections" && <div className="connection-grid"><section className="panel"><div className="section-heading"><div><span className="eyebrow">CONNECT YOUR GROUP</span><h2>Protect my group</h2></div><span className={`badge ${data.bot?.status === "active" ? "matched" : ""}`}>{data.bot?.status === "active" ? "Ready" : "Unavailable"}</span></div>
            <p>Add the official Telegram Manager bot to your group and make it an administrator. The system detects the group automatically; no bot token or chat ID is required.</p>
            <div className="connection-steps"><p><strong>1.</strong> Choose your group in Telegram.</p><p><strong>2.</strong> Keep the requested delete and restrict permissions.</p><p><strong>3.</strong> Return here and confirm the group.</p></div>
            {community ? <div className="community-card"><span className="avatar">#</span><div><h3>{community.name}</h3><small>Your group is protected.</small></div></div> : data.connectionAttempt?.state === "DISCOVERED" && data.connectionAttempt.candidate ? <div className="community-card"><span className="avatar">#</span><div><h3>{data.connectionAttempt.candidate.name ?? "Telegram group"}</h3><small>{data.connectionAttempt.candidate.botIsAdmin && data.connectionAttempt.candidate.userIsAdmin ? "Ready to protect this group." : data.connectionAttempt.errorMessage ?? "Finish the administrator permissions in Telegram."}</small></div><button className="primary" disabled={disabled} onClick={() => void mutate("confirmConnection", { attemptId: data.connectionAttempt!.id }, "Your group is protected.")}>{pending === "confirmConnection" ? "Checking…" : "Protect this group"}</button></div> : data.connectionAttempt?.state === "PENDING" && connectionUrl ? <div className="form-stack"><a className="primary" href={connectionUrl}>Open Telegram to choose a group →</a><small>This link expires in 15 minutes.</small></div> : <div className="form-stack">{data.connectionAttempt?.errorMessage && <p className="notice error">{data.connectionAttempt.errorMessage}</p>}<button className="primary" disabled={disabled || data.bot?.status !== "active"} onClick={() => void mutate("startConnection", {}, "Choose your group in Telegram, then return here.")}>{pending === "startConnection" ? "Preparing link…" : "Add my group →"}</button></div>}
          </section><section className="panel moderation-control"><div><span className="eyebrow">AFTER CONNECTION</span><h2>Protection starts with a safe default</h2><p>We create a spam and promotion rule that warns the member and deletes the matched message. Warning progression remains available in your community settings.</p><small>{activeRules} enabled {activeRules === 1 ? "rule" : "rules"} · You can review every decision in the log.</small></div><button className="secondary" disabled={!community} onClick={() => setSection("Rules & testing")}>Review rules →</button></section>
          {community && <section className="panel"><div className="section-heading"><div><span className="eyebrow">WARNING PROGRESSION</span><h2>Community warning settings</h2><p>Warnings accumulate per user inside this community and expire only after the configured window.</p></div></div><form onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); const value = (name: string) => String(fields.get(name) ?? "").trim(); const muteAt = value("warningMuteAt"); const banAt = value("warningBanAt"); const banDuration = value("warningBanDurationSeconds"); void mutate("saveCommunitySettings", { communityId: community.id, warningWindowDays: Number(value("warningWindowDays")), publicWarningsEnabled: fields.get("publicWarningsEnabled") === "on", warningMuteAt: muteAt ? Number(muteAt) : null, warningMuteDurationSeconds: Number(value("warningMuteDurationSeconds")), warningBanAt: banAt ? Number(banAt) : null, warningBanDurationSeconds: banDuration ? Number(banDuration) : null }, "Warning settings saved."); }}><fieldset className="form-stack" disabled={disabled}><div className="form-columns"><label>Window (days)<input name="warningWindowDays" type="number" min="1" max="3650" defaultValue={community.warningWindowDays} required /></label><label>Mute at warning<input name="warningMuteAt" type="number" min="1" placeholder="Disabled" defaultValue={community.warningMuteAt ?? ""} /></label></div><div className="form-columns"><label>Mute duration (seconds)<input name="warningMuteDurationSeconds" type="number" min="60" defaultValue={community.warningMuteDurationSeconds} required /></label><label>Ban at warning<input name="warningBanAt" type="number" min="1" placeholder="Disabled" defaultValue={community.warningBanAt ?? ""} /></label></div><label>Ban duration (seconds)<input name="warningBanDurationSeconds" type="number" min="60" placeholder="Empty = permanent" defaultValue={community.warningBanDurationSeconds ?? ""} /></label><label className="checkbox"><input name="publicWarningsEnabled" type="checkbox" defaultChecked={community.publicWarningsEnabled} /> Send the fixed warning message publicly</label><button className="primary">{pending === "saveCommunitySettings" ? "Saving…" : "Save warning settings"}</button></fieldset></form></section>}</div>}
          {section === "Rules & testing" && <>
            {!community ? <section className="panel empty"><h2>First, give your rules a home.</h2><p>Connect a Telegram community before creating and testing rules.</p><button className="primary" onClick={() => setSection("Connections")}>Connect a community →</button></section> : <>
              <section className="panel"><div className="section-heading"><div><h2>Community rules <span className="count">{activeRules}/{activeLimit} active</span></h2><p>JEV only reports match probabilities. The system applies this configured action.</p></div><button className="primary" disabled={disabled || !!editor || activeRules >= activeLimit} onClick={() => openRuleEditor(emptyRule)}>+ Create rule</button></div>
                {activeRules >= activeLimit && <p className="notice">You’ve reached the {activeLimit} active rule limit. Disable a rule to activate another.</p>}
                {!rules.length && !editor && <div className="empty"><h3>A clear rule is a good starting point.</h3><p>Write your own instructions or start with a suggestion below.</p></div>}
                {rules.map(rule => <article className="rule-row" key={rule.id}><div><div className="rule-title"><h3>{rule.name}</h3><Badge action={rule.action} /><span className="muted">Priority {rule.priority}</span></div><p>{rule.ruleText}</p><small>{rule.actionDurationSeconds ? `${rule.actionDurationSeconds}s` : rule.action === "BAN" ? "Permanent if escalated directly" : ""}{rule.deleteMessage ? " · matched message is deleted" : ""}</small></div><div className="rule-controls"><button role="switch" aria-checked={rule.enabled} aria-label={`Enable ${rule.name}`} className={`switch ${rule.enabled ? "on" : ""}`} disabled={disabled || (!rule.enabled && activeRules >= activeLimit)} onClick={() => { void mutate("saveRule", { id: rule.id, communityId: rule.communityId, name: rule.name, ruleText: rule.ruleText, ruleAction: rule.action, actionDurationSeconds: rule.actionDurationSeconds, deleteMessage: rule.deleteMessage, priority: rule.priority, enabled: !rule.enabled }, "Rule updated."); setResult(null); }}><span /></button><button className="text-button" disabled={disabled} onClick={() => openRuleEditor(rule)}>Edit</button><button className="text-button danger" disabled={disabled} onClick={() => setDeleting(rule.id)}>Delete</button></div>{deleting === rule.id && <div className="delete-confirm"><span>Delete “{rule.name}”? This cannot be undone.</span><button className="danger-button" disabled={disabled} onClick={async () => { if (await mutate("deleteRule", { id: rule.id }, "Rule deleted.")) { setDeleting(""); setResult(null); if (editor?.id === rule.id) setEditor(null); } }}>Confirm delete</button><button className="secondary" disabled={disabled} onClick={() => setDeleting("")}>Cancel</button></div>}</article>)}
                {editor && <form className="rule-editor" key={editor.id ?? editor.name ?? "new"} onSubmit={saveRule}><h3>{editor.id ? "Edit rule" : "New rule"}</h3><fieldset className="form-stack" disabled={disabled}><label>Rule name<input name="name" defaultValue={editor.name} required maxLength={100} autoFocus /></label><label>What should this rule catch?<textarea name="ruleText" defaultValue={editor.ruleText} placeholder="Describe what to flag and what to allow. Be specific." required maxLength={2000} rows={4} /></label><div className="form-columns"><label>When matched<select name="ruleAction" value={editingAction} onChange={event => setEditingAction(event.target.value as Rule["action"])}><option value="WARN">Warn</option><option value="MUTE">Mute</option><option value="BAN">Ban</option></select></label><label>Priority<input name="priority" type="number" min={0} max={1000} defaultValue={editor.priority} required /></label></div>{editingAction !== "WARN" && <label>Duration in seconds <small>(required for MUTE; optional for BAN)</small><input name="actionDurationSeconds" type="number" min={60} defaultValue={editor.actionDurationSeconds ?? ""} /></label>}<label className="checkbox"><input name="deleteMessage" type="checkbox" defaultChecked={editor.deleteMessage} /> Delete matched message</label><label className="checkbox"><input name="enabled" type="checkbox" defaultChecked={editor.enabled} disabled={!editor.enabled && activeRules >= activeLimit} /> Enable this rule</label><div className="button-row"><button className="primary">{pending === "saveRule" ? "Saving…" : "Save rule"}</button><button type="button" className="secondary" onClick={() => setEditor(null)}>Cancel</button></div></fieldset></form>}
              </section>
              <div className="section-heading template-heading"><div><h2>A head start, if you need one.</h2><p>Suggestions only. Review and save a template to add it.</p></div></div><div className="templates">{templates.map((template, index) => <button className="panel template" key={template.name} disabled={disabled || !!editor || activeRules >= activeLimit} onClick={() => openRuleEditor({ ...emptyRule, ...template })}><span className="template-number">0{index + 1}</span><h3>{template.name} <span>↗</span></h3><p>{template.ruleText}</p></button>)}</div>
              <section className="panel tester"><div><span className="eyebrow">TRY BEFORE YOU TURN IT ON</span><h2>Give your rules a test run.</h2><p>Paste a sample message to see a state and match probabilities. Tests never take action and do not simulate a user’s warning history.</p><small>Up to {data.limits.testsPerDay} tests per day. Only enabled rules are tested.</small></div><div><form onSubmit={event => { event.preventDefault(); setResult(null); void mutate("testRules", { communityId: community.id, text: testText.trim() }, "Test complete. No Telegram message was changed."); }}><fieldset disabled={disabled || !activeRules} className="form-stack"><label>Sample message<textarea value={testText} onChange={event => { setTestText(event.target.value); setResult(null); }} maxLength={4000} rows={4} placeholder="Paste a message from a conversation…" required /></label><button className="primary" disabled={!testText.trim()}>{pending === "testRules" ? "Testing rules…" : "Test message →"}</button></fieldset></form>{!activeRules && <p>Enable a rule to run a test.</p>}{result && <div className="test-result" role="status"><span className={`badge ${result.state.toLowerCase()}`}>{result.state.replaceAll("_", " ")}</span><p>{result.reason}</p>{(result.evaluations ?? result.matchedRules ?? []).map(item => <div className="evaluation" key={item.ruleId}><span>{item.ruleName ?? rules.find(rule => rule.id === item.ruleId)?.name ?? "Rule"}</span><strong>{probability(item.probability)}</strong></div>)}<small>Progression is not simulated here; it requires a real user history.</small></div>}</div></section>
            </>}
          </>}
          {section === "Moderation log" && <ModerationLog logs={data.recentLogs} disabled={disabled} onFeedback={(decisionId, expectedState) => mutate("feedback", { decisionId, expectedState }, "Feedback saved. Thank you.")} />}
          <footer className="dashboard-footer"><span>Made for better conversations.</span><span>Telegram Manager · Free workspace</span></footer>
        </>}
      </div>
    </main>
  </div>;
}
