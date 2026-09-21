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
const emptyRule = { name: "", ruleText: "", action: "REVIEW" as const, priority: 100, enabled: true };
const labels: Record<Action, string> = { ALLOW: "Allow", REVIEW: "Review", DELETE: "Delete" };
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
  const [deleting, setDeleting] = useState("");
  const [testText, setTestText] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
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
      const response = await request<TestResponse | { ok: true }>("/api/dashboard", { action, ...values });
      if (action === "testRules") {
        if (!("decision" in response) || !response.decision) throw new Error("The test did not return a decision. Please try again.");
        setResult({ ...response.decision, evaluations: response.evaluations });
      }
      setNotice(success);
      if (action !== "testRules") {
        try { await load(); } catch (error) { setError(`Your change was saved, but the dashboard could not refresh. ${errorMessage(error)}`); }
      }
      return true;
    } catch (error) { setError(action === "connectBot" ? "Could not connect the bot. Check the token and service configuration, then enter the token again." : errorMessage(error)); return false; }
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
  async function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!community || !editor) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("name")).trim(), ruleText = String(fields.get("ruleText")).trim();
    if (!name || !ruleText) { setError("Please enter a rule name and instructions."); return; }
    if (await mutate("saveRule", { id: editor.id, communityId: community.id, name, ruleText, ruleAction: fields.get("ruleAction"), priority: Number(fields.get("priority")), enabled: fields.get("enabled") === "on" }, "Rule saved. Run a test to check how it behaves.")) { setEditor(null); setResult(null); }
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
            <div className="stats-grid">{[["Messages moderated", used, "This month"], ["Allowed", data.usage?.actionsAllow ?? 0, "Decision: allow"], ["For review", data.usage?.actionsReview ?? 0, "Decision: review"], ["Deleted", data.usage?.actionsDelete ?? 0, "Successful Telegram actions"]].map(([title, value, detail]) => <section className="panel stat" key={title}><span>{title}</span><strong>{number(Number(value))}</strong><small>{detail}</small></section>)}</div>
            <div className="overview-grid"><section className="panel"><div className="section-heading"><div><h2>Community activity</h2><p>Moderation decisions over the last 7 days</p></div><span className="badge">7 DAYS</span></div>
              {data.dailyStats.some(day => day.moderated) ? <div className="chart" role="img" aria-label={data.dailyStats.map(day => `${day.date}: ${day.moderated} decisions`).join("; ")}>{data.dailyStats.map(day => <div className="chart-column" key={day.date}><span>{number(day.moderated)}</span><div className="chart-track"><div style={{ height: `${day.moderated / Math.max(1, ...data.dailyStats.map(item => item.moderated)) * 100}%` }} /></div><small>{new Date(`${day.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })}</small></div>)}</div> : <div className="empty chart-empty"><span className="empty-symbol" aria-hidden="true">▥</span><h3>No activity to show yet</h3><p>Activity will appear here when moderation data is available.</p></div>}
            </section><section className="panel usage-card"><span className="eyebrow">ROOM TO GROW</span><h2>Your monthly allowance</h2><p><strong className="usage-number">{number(used)}</strong> / {number(limit)}</p><progress max={limit} value={Math.min(used, limit)} aria-label="Monthly moderated message allowance" /><p>{used >= limit ? "Monthly allowance reached. Check service status before expecting new moderation." : `${number(Math.max(0, limit - used))} messages remaining this month.`}</p><small>Free plan · Resets each calendar month.<br />Test messages have a separate daily allowance.</small><button className="text-button" onClick={() => setSection("Rules & testing")}>Review your rules →</button></section></div>
            <section className="panel next-step"><div><h2>{rules.length ? "A little fine-tuning goes a long way." : "Your community. Your ground rules."}</h2><p>{rules.length ? `${activeRules} active ${activeRules === 1 ? "rule" : "rules"}. Try a sample message to see how your rules respond.` : "Start with a suggested rule, then adjust it to fit your community."}</p></div><button className="secondary" onClick={() => setSection("Rules & testing")}>{rules.length ? "Test your rules →" : "Set up rules →"}</button></section>
          </>}
          {section === "Connections" && <div className="connection-grid"><section className="panel"><div className="section-heading"><div><span className="eyebrow">STEP 01</span><h2>Connect your bot</h2></div><span className={`badge ${data.bot ? "allow" : ""}`}>{data.bot ? data.bot.status : "Not connected"}</span></div>
            {data.bot && <p className="connected-bot">@{data.bot.username}</p>}<p>Create a bot with <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> on Telegram, then paste its token below.</p>
            <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const token = String(new FormData(form).get("token") ?? "").trim(); form.reset(); if (token) void mutate("connectBot", { token }, "Bot connected. Add it to your group as an administrator."); }}><fieldset disabled={disabled} className="form-stack"><label>Secret bot token<input name="token" type="password" autoComplete="new-password" placeholder="Paste your bot token" required maxLength={256} spellCheck={false} aria-describedby="token-help" /></label><small id="token-help">Cleared immediately after submission. Your saved token is never shown here.</small><button className="primary">{pending === "connectBot" ? "Connecting…" : data.bot ? "Update bot connection" : "Connect bot"}</button></fieldset></form>
          </section><section className="panel"><span className="eyebrow">STEP 02</span><h2>Add your community</h2><p>Add the bot to your Telegram group as an administrator and grant <strong>Delete messages</strong> permission. Then enter the group’s numeric chat ID.</p>
            {community ? <div className="community-card"><span className="avatar">#</span><div><h3>{community.name}</h3><small>Chat ID: {community.externalId}</small></div></div> : <form onSubmit={event => { event.preventDefault(); void mutate("addCommunity", { chatId: String(new FormData(event.currentTarget).get("chatId")).trim() }, "Community connected. Moderation is off until you enable it."); }}><fieldset disabled={disabled || !data.bot} className="form-stack"><label>Telegram chat ID<input name="chatId" placeholder="e.g. -1001234567890" pattern="-[0-9]+" required maxLength={24} /></label><small>Use the numeric group ID, including its minus sign. Free includes 1 community.</small><button className="primary">{pending === "addCommunity" ? "Checking permissions…" : "Add community"}</button></fieldset></form>}
          </section><section className="panel moderation-control"><div><span className="eyebrow">STEP 03</span><h2>Enable moderation when you’re ready</h2><p>New communities start with moderation off. Review and test your rules first. Enabling moderation lets delete rules remove matching messages.</p><small>{activeRules} enabled {activeRules === 1 ? "rule" : "rules"} · Review decisions do not delete messages.</small></div><button className={community?.moderationEnabled ? "secondary" : "primary"} disabled={disabled || !community || (!community.moderationEnabled && !activeRules)} onClick={() => community && void mutate("toggleModeration", { communityId: community.id, enabled: !community.moderationEnabled }, community.moderationEnabled ? "Moderation turned off." : "Moderation turned on.")}>{pending === "toggleModeration" ? "Updating…" : community?.moderationEnabled ? "Turn moderation off" : "Turn moderation on"}</button></section></div>}
          {section === "Rules & testing" && <>
            {!community ? <section className="panel empty"><h2>First, give your rules a home.</h2><p>Connect a Telegram community before creating and testing rules.</p><button className="primary" onClick={() => setSection("Connections")}>Connect a community →</button></section> : <>
              <section className="panel"><div className="section-heading"><div><h2>Community rules <span className="count">{activeRules}/{activeLimit} active</span></h2><p>Higher priority wins when rules suggest the same action.</p></div><button className="primary" disabled={disabled || !!editor || activeRules >= activeLimit} onClick={() => setEditor(emptyRule)}>+ Create rule</button></div>
                {activeRules >= activeLimit && <p className="notice">You’ve reached the {activeLimit} active rule limit. Disable a rule to activate another.</p>}
                {!rules.length && !editor && <div className="empty"><h3>A clear rule is a good starting point.</h3><p>Write your own instructions or start with a suggestion below.</p></div>}
                {rules.map(rule => <article className="rule-row" key={rule.id}><div><div className="rule-title"><h3>{rule.name}</h3><Badge action={rule.action} /><span className="muted">Priority {rule.priority}</span></div><p>{rule.ruleText}</p></div><div className="rule-controls"><button role="switch" aria-checked={rule.enabled} aria-label={`Enable ${rule.name}`} className={`switch ${rule.enabled ? "on" : ""}`} disabled={disabled || (!rule.enabled && activeRules >= activeLimit)} onClick={() => { void mutate("saveRule", { id: rule.id, communityId: rule.communityId, name: rule.name, ruleText: rule.ruleText, ruleAction: rule.action, priority: rule.priority, enabled: !rule.enabled }, "Rule updated."); setResult(null); }}><span /></button><button className="text-button" disabled={disabled} onClick={() => setEditor(rule)}>Edit</button><button className="text-button danger" disabled={disabled} onClick={() => setDeleting(rule.id)}>Delete</button></div>{deleting === rule.id && <div className="delete-confirm"><span>Delete “{rule.name}”? This cannot be undone.</span><button className="danger-button" disabled={disabled} onClick={async () => { if (await mutate("deleteRule", { id: rule.id }, "Rule deleted.")) { setDeleting(""); setResult(null); if (editor?.id === rule.id) setEditor(null); } }}>Confirm delete</button><button className="secondary" disabled={disabled} onClick={() => setDeleting("")}>Cancel</button></div>}</article>)}
                {editor && <form className="rule-editor" key={editor.id ?? editor.name ?? "new"} onSubmit={saveRule}><h3>{editor.id ? "Edit rule" : "New rule"}</h3><fieldset className="form-stack" disabled={disabled}><label>Rule name<input name="name" defaultValue={editor.name} required maxLength={100} autoFocus /></label><label>What should this rule catch?<textarea name="ruleText" defaultValue={editor.ruleText} placeholder="Describe what to flag and what to allow. Be specific." required maxLength={2000} rows={4} /></label><div className="form-columns"><label>When matched<select name="ruleAction" defaultValue={editor.action}><option value="REVIEW">Send for review</option><option value="DELETE">Delete message</option></select></label><label>Priority<input name="priority" type="number" min={0} max={1000} defaultValue={editor.priority} required /></label></div><label className="checkbox"><input name="enabled" type="checkbox" defaultChecked={editor.enabled} disabled={!editor.enabled && activeRules >= activeLimit} /> Enable this rule</label><div className="button-row"><button className="primary">{pending === "saveRule" ? "Saving…" : "Save rule"}</button><button type="button" className="secondary" onClick={() => setEditor(null)}>Cancel</button></div></fieldset></form>}
              </section>
              <div className="section-heading template-heading"><div><h2>A head start, if you need one.</h2><p>Suggestions only. Review and save a template to add it.</p></div></div><div className="templates">{templates.map((template, index) => <button className="panel template" key={template.name} disabled={disabled || !!editor || activeRules >= activeLimit} onClick={() => setEditor({ ...emptyRule, ...template })}><span className="template-number">0{index + 1}</span><h3>{template.name} <span>↗</span></h3><p>{template.ruleText}</p></button>)}</div>
              <section className="panel tester"><div><span className="eyebrow">TRY BEFORE YOU TURN IT ON</span><h2>Give your rules a test run.</h2><p>Paste a sample message to see a decision and match probabilities. Tests never take action in Telegram.</p><small>Up to {data.limits.testsPerDay} tests per day. Only enabled rules are tested.</small></div><div><form onSubmit={event => { event.preventDefault(); setResult(null); void mutate("testRules", { communityId: community.id, text: testText.trim() }, "Test complete. No Telegram message was changed."); }}><fieldset disabled={disabled || !activeRules} className="form-stack"><label>Sample message<textarea value={testText} onChange={event => { setTestText(event.target.value); setResult(null); }} maxLength={4000} rows={4} placeholder="Paste a message from a conversation…" required /></label><button className="primary" disabled={!testText.trim()}>{pending === "testRules" ? "Testing rules…" : "Test message →"}</button></fieldset></form>{!activeRules && <p>Enable a rule to run a test.</p>}{result && <div className="test-result" role="status"><Badge action={result.action} /><p>{result.reason}</p>{(result.evaluations ?? result.matchedRules ?? []).map(item => <div className="evaluation" key={item.ruleId}><span>{item.ruleName ?? rules.find(rule => rule.id === item.ruleId)?.name ?? "Rule"}</span><strong>{probability(item.probability)}</strong></div>)}<small>Probability of a rule match, not confirmation of an external action.</small></div>}</div></section>
            </>}
          </>}
          {section === "Moderation log" && <ModerationLog logs={data.recentLogs} disabled={disabled} onFeedback={(decisionId, expectedAction) => mutate("feedback", { decisionId, expectedAction }, "Feedback saved. Thank you.")} />}
          <footer className="dashboard-footer"><span>Made for better conversations.</span><span>Telegram Manager · Free workspace</span></footer>
        </>}
      </div>
    </main>
  </div>;
}
