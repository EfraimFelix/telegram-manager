"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { errorMessage, number, probability, request, type Action, type DashboardData, type DecisionState, type Rule, type TestResponse, type TestResult } from "./dashboard-api";
import { Icon, type IconName } from "./icon";
import ModerationLog, { reasonLabel } from "./moderation-log";

const navigation = [
  { id: "overview", label: "Visão geral", mobileLabel: "Início", icon: "overview" },
  { id: "communities", label: "Comunidades", mobileLabel: "Grupos", icon: "communities" },
  { id: "participants", label: "Participantes", mobileLabel: "Membros", icon: "participants" },
  { id: "rules", label: "Regras", mobileLabel: "Regras", icon: "rules" },
  { id: "log", label: "Registro", mobileLabel: "Registro", icon: "log" },
  { id: "connection", label: "Telegram bot", mobileLabel: "Bot", icon: "bot" },
] as const satisfies ReadonlyArray<{ id: string; label: string; mobileLabel: string; icon: IconName }>;
type Section = (typeof navigation)[number]["id"];

const templates = [
  { name: "Spam e divulgação", ruleText: "Sinalize anúncios não solicitados, mensagens promocionais repetidas e links de indicação. Permita links relevantes enviados em conversas genuínas." },
  { name: "Golpes e phishing", ruleText: "Sinalize tentativas de roubar credenciais ou dinheiro, perfis falsos e ofertas de investimento enganosas. Permita discussões ou alertas sobre golpes." },
  { name: "Assédio", ruleText: "Sinalize assédio direcionado, ameaças e ataques de ódio. Permita discordâncias respeitosas e críticas construtivas." },
];
const emptyRule = { name: "", ruleText: "", action: "WARN" as const, actionDurationSeconds: null, deleteMessage: false, priority: 100, enabled: true };
const actionLabels: Record<Action, string> = { WARN: "Avisar", DELETE: "Excluir", MUTE: "Silenciar", BAN: "Banir" };
const decisionLabels: Record<DecisionState, string> = { SKIPPED: "Ignorada", NO_MATCH: "Sem correspondência", REVIEW: "Revisar", MATCHED: "Regra acionada" };
const shortDate = (value: string) => new Date(value + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
const shortTime = (value: string) => new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function StateBadge({ state }: { state: DecisionState }) {
  return <span className={"state-badge state-" + state.toLowerCase()}>{decisionLabels[state]}</span>;
}

function ActivityChart({ days }: { days: DashboardData["dailyStats"] }) {
  const maximum = Math.max(1, ...days.map(day => day.moderated));
  if (!days.some(day => day.moderated)) {
    return <div className="chart-empty"><Icon name="message" size={22} /><strong>Sem atividade nesta semana</strong><span>As decisões aparecerão aqui quando o bot analisar mensagens.</span></div>;
  }
  return <div className="activity-chart" role="img" aria-label={days.map(day => day.date + ": " + day.moderated + " decisões").join("; ")}>
    {days.map(day => <div className="activity-day" key={day.date}><span className="activity-value">{number(day.moderated)}</span><div className="activity-track"><span className="activity-bar" style={{ height: day.moderated / maximum * 100 + "%" }} /></div><span className="activity-label">{shortDate(day.date)}</span></div>)}
  </div>;
}

function ParticipantChart({ days }: { days: NonNullable<DashboardData["participantActivity"]>[number]["daily"] }) {
  const maximum = Math.max(1, ...days.flatMap(day => [day.joined, day.left]));
  return <div className="participant-chart" role="img" aria-label={days.map(day => day.date + ": " + day.joined + " entradas, " + day.left + " saídas").join("; ")}>
    {days.map(day => <div className="participant-day" key={day.date}><div className="participant-pair"><span className="participant-bar-track"><span className="participant-bar joined" style={{ height: day.joined / maximum * 100 + "%" }} /></span><span className="participant-bar-track"><span className="participant-bar left" style={{ height: day.left / maximum * 100 + "%" }} /></span></div><span>{shortDate(day.date)}</span></div>)}
  </div>;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [section, setSection] = useState<Section>("overview");
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
  const [logFilter, setLogFilter] = useState<DecisionState | "ALL">("ALL");
  const busy = useRef(false);
  const polling = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const next = await request<DashboardData>("/api/dashboard", undefined, signal);
    if (!next?.user || !Array.isArray(next.communities) || !Array.isArray(next.rules) || !Array.isArray(next.recentLogs) || !next.limits || !next.usage || !Array.isArray(next.dailyStats)) {
      throw new Error("Não foi possível carregar todos os dados do painel.");
    }
    setData(next);
    setError("");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const state = data?.connectionAttempt?.state;
    if (section !== "connection" || !state || !["PENDING", "DISCOVERED"].includes(state)) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (busy.current || polling.current || document.visibilityState !== "visible") return;
      polling.current = true;
      void load(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
        .finally(() => { polling.current = false; });
    }, 2_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [data?.connectionAttempt?.state, load, section]);

  async function refresh() {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError(""); setNotice("");
    try { await load(); } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); busy.current = false; }
  }

  async function mutate(action: string, values: object, success: string): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true; setPending(action); setError(""); setNotice("");
    try {
      const response = await request<TestResponse | { ok: true; attempt?: { startUrl: string } }>("/api/dashboard", { action, ...values });
      if (action === "testRules") {
        if (!("decision" in response) || !response.decision) throw new Error("O teste não retornou uma decisão. Tente novamente.");
        setResult({ ...response.decision, evaluations: response.evaluations });
      }
      if (action === "startConnection" && "attempt" in response && response.attempt?.startUrl) setConnectionUrl(response.attempt.startUrl);
      if (action === "confirmConnection") setConnectionUrl("");
      setNotice(success);
      if (action !== "testRules") {
        try { await load(); } catch (cause) { setError("A alteração foi salva, mas o painel não atualizou. " + errorMessage(cause)); }
      }
      return true;
    } catch (cause) { setError(errorMessage(cause)); return false; }
    finally { setPending(""); busy.current = false; }
  }

  async function signOut() {
    if (busy.current) return;
    busy.current = true; setPending("signOut"); setError("");
    try { await request("/api/auth/sign-out", {}); window.location.replace("/sign-in"); }
    catch (cause) { setError(errorMessage(cause)); setPending(""); busy.current = false; }
  }

  function navigate(target: Section, filter: DecisionState | "ALL" = "ALL") {
    setSection(target);
    setLogFilter(filter);
    setNotice("");
    window.scrollTo(0, 0);
  }
  function changeCommunity(id: string) { setSelected(id); setEditor(null); setResult(null); setTestText(""); setDeleting(""); }
  function openRuleEditor(rule: Partial<Rule>) { setEditor(rule); setEditingAction(rule.action ?? "WARN"); }
  async function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!community || !editor) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("name") ?? "").trim();
    const ruleText = String(fields.get("ruleText") ?? "").trim();
    if (!name || !ruleText) { setError("Preencha o nome e as instruções da regra."); return; }
    const ruleAction = String(fields.get("ruleAction"));
    const durationValue = String(fields.get("actionDurationSeconds") ?? "").trim();
    const saved = await mutate("saveRule", {
      id: editor.id, communityId: community.id, name, ruleText, ruleAction,
      actionDurationSeconds: ruleAction === "WARN" || !durationValue ? null : Number(durationValue),
      deleteMessage: fields.get("deleteMessage") === "on", priority: Number(fields.get("priority")), enabled: fields.get("enabled") === "on",
    }, "Regra salva. Faça um teste para conferir o resultado.");
    if (saved) { setEditor(null); setResult(null); }
  }

  const community = data?.communities.find(item => item.id === selected) ?? data?.communities[0];
  const rules = data?.rules.filter(rule => rule.communityId === community?.id) ?? [];
  const activeRules = rules.filter(rule => rule.enabled).length;
  const activeLimit = data?.limits.enabledRules ?? 3;
  const used = data?.usage.messagesModerated ?? 0;
  const limit = data?.limits.messagesPerMonth ?? 5000;
  const disabled = !!pending || loading;
  const communityLogs = data?.recentLogs.filter(log => log.communityId === community?.id) ?? [];
  const participantActivity = data?.participantActivity?.find(item => item.communityId === community?.id);
  const pageName = navigation.find(item => item.id === section)?.label ?? "Visão geral";

  return <div className="app-shell">
    <a href="#main-content" className="skip-link">Ir para o conteúdo</a>
    <aside className="app-sidebar">
      <button className="brand" type="button" onClick={() => navigate("overview")} aria-label="Telegram Manager, visão geral"><span className="brand-mark">↗</span><span className="brand-copy"><strong>Telegram Manager</strong><small>Moderação com clareza</small></span></button>
      <div className="workspace-switch"><span className="workspace-avatar">{(community?.name ?? data?.organization.name ?? "T")[0].toUpperCase()}</span><span><strong>{community?.name ?? data?.organization.name ?? "Seu workspace"}</strong><small>{community ? "Comunidade Telegram" : "Plano gratuito"}</small></span></div>
      <span className="nav-caption">WORKSPACE</span>
      <nav className="app-nav" aria-label="Navegação principal">
        {navigation.map(item => <button key={item.id} type="button" className={"nav-item" + (item.id === "connection" ? " nav-connection" : "") + (item.id === "communities" && section === "connection" ? " nav-subpage-active" : "")} aria-label={item.label} aria-current={section === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} size={18} /><span className="nav-label-long">{item.label}</span><span className="nav-label-short" aria-hidden="true">{item.mobileLabel}</span></button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="plan-note"><div><strong>Plano gratuito</strong><span>{activeRules}/{activeLimit} regras</span></div><progress max={limit} value={Math.min(used, limit)} aria-label="Uso mensal de mensagens moderadas" /><small>{number(used)} de {number(limit)} mensagens neste mês</small></div>
        <div className="account"><span className="account-avatar">{data?.user.name?.[0]?.toUpperCase() ?? "·"}</span><div><strong>{data?.user.name ?? "Sua conta"}</strong><button className="text-button" type="button" disabled={disabled} onClick={signOut}>{pending === "signOut" ? "Saindo…" : "Sair"}</button></div></div>
      </div>
    </aside>
    <div className="app-main">
      <header className="topbar"><div className="topbar-path">Workspace <span>/</span> <strong>{pageName}</strong></div><div className="topbar-actions"><span className={"connection-indicator" + (data?.bot?.status === "active" ? " is-connected" : "")}><span className="status-dot" />{data?.bot?.status === "active" ? "Bot conectado" : "Bot indisponível"}</span><button className="icon-button" type="button" aria-label="Atualizar dados" title="Atualizar dados" disabled={disabled} onClick={refresh}><Icon name="refresh" size={17} /></button></div></header>
      <main id="main-content" className="page-content">
        {error && <div className="notice error" role="alert"><strong>{data ? "Não foi possível concluir a ação" : "Não foi possível abrir seu workspace"}</strong><p>{error}</p>{!data && <button className="secondary" type="button" disabled={disabled} onClick={refresh}>Tentar novamente</button>}</div>}
        {notice && <div className="notice success" role="status">{notice}</div>}
        {!data && !error && <div className="panel loading-state" role="status" aria-busy="true"><span className="loading-line" /><h1>Preparando seu workspace</h1><p>Carregando comunidades, regras e atividade recente…</p></div>}
        {data && <>
          {data.communities.length > 1 && <label className="community-picker">Comunidade<select value={community?.id ?? ""} onChange={event => changeCommunity(event.target.value)} disabled={disabled}>{data.communities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}

          {section === "overview" && <>
            <div className="page-heading"><div><span className="eyebrow">RESUMO DA COMUNIDADE</span><h1>Olá, {data.user.name.split(" ")[0]}</h1><p>Veja o que aconteceu no grupo e onde sua atenção faz diferença.</p></div><span className={"status-pill " + (community?.moderationEnabled ? "status-active" : "status-inactive")}><span className="status-dot" />{community?.moderationEnabled ? "Proteção ativa" : "Proteção pausada"}</span></div>
            {community ? <section className={"attention-card " + (data.usage.decisionsReview ? "attention-review" : "attention-clear")}><span className="attention-icon"><Icon name={data.usage.decisionsReview ? "alert" : "shield"} size={21} /></span><div><strong>{data.usage.decisionsReview ? number(data.usage.decisionsReview) + (data.usage.decisionsReview === 1 ? " decisão marcada para revisão" : " decisões marcadas para revisão") : "Nenhuma revisão sinalizada neste mês"}</strong><p>{data.usage.decisionsReview ? "Confira o contexto antes de ajustar uma regra ou dar retorno sobre a decisão." : "Sua equipe pode conferir todas as decisões no registro de moderação."}</p></div><button className="secondary" type="button" onClick={() => navigate("log", data.usage.decisionsReview ? "REVIEW" : "ALL")}>{data.usage.decisionsReview ? "Ver revisões" : "Ver registro"} <Icon name="arrow" size={15} /></button></section>
              : <section className="attention-card"><span className="attention-icon"><Icon name="bot" size={21} /></span><div><strong>Conecte sua primeira comunidade</strong><p>Adicione o bot ao grupo e veja a proteção começar a funcionar.</p></div><button className="primary" type="button" onClick={() => navigate("connection")}>Conectar grupo <Icon name="arrow" size={15} /></button></section>}
            <div className="stats-grid">
              <div className="stat-card"><span>Mensagens moderadas</span><strong>{number(used)}</strong><small>Neste mês</small></div>
              <div className="stat-card"><span>Mensagens excluídas</span><strong>{number(data.usage.actionsDelete)}</strong><small>Ações registradas neste mês</small></div>
              <div className="stat-card"><span>Regras ativas</span><strong>{activeRules}</strong><small>De {activeLimit} disponíveis</small></div>
            </div>
            <div className="overview-grid"><section className="panel activity-panel"><div className="section-heading"><div><h2>Atividade da comunidade</h2><p>Decisões de moderação nos últimos 7 dias</p></div><span className="small-tag">7 dias</span></div><ActivityChart days={data.dailyStats} /></section>
              <section className="panel recent-panel"><div className="section-heading"><div><h2>Decisões recentes</h2><p>Últimas mensagens analisadas</p></div><button className="text-button" type="button" onClick={() => navigate("log")}>Ver todas</button></div>
                {communityLogs.length ? communityLogs.slice(0, 3).map(log => <div className="recent-item" key={log.id}><div><span className={"recent-state state-" + (log.decision?.state.toLowerCase() ?? "skipped")}>{log.decision ? decisionLabels[log.decision.state] : "Processando"}</span><time dateTime={log.receivedAt}>{shortTime(log.receivedAt)}</time></div><p>{log.text}</p></div>) : <div className="compact-empty"><Icon name="message" size={22} /><strong>Nenhuma decisão ainda</strong><p>As mensagens analisadas pelo bot aparecerão aqui.</p></div>}
              </section></div>
            <div className="overview-bottom"><section className="panel member-widget"><div className="member-widget-icon"><Icon name="participants" size={21} /></div><div><h2>Movimentação de participantes</h2>{participantActivity ? <p>{number(participantActivity.joined)} entraram · {number(participantActivity.left)} saíram nos últimos 7 dias</p> : <p>Entradas e saídas ainda não estão disponíveis.</p>}</div>{participantActivity && <strong className="member-net">{participantActivity.joined - participantActivity.left >= 0 ? "+" : ""}{number(participantActivity.joined - participantActivity.left)}</strong>}<button className="text-button" type="button" onClick={() => navigate("participants")}>Ver detalhes <Icon name="arrow" size={15} /></button></section>
              <section className="panel usage-summary"><div className="section-heading"><div><h2>Uso mensal</h2><p>{number(used)} de {number(limit)} mensagens moderadas</p></div></div><progress max={limit} value={Math.min(used, limit)} aria-label="Uso mensal de mensagens moderadas" /><small>{used >= limit ? "Limite mensal atingido." : number(Math.max(0, limit - used)) + " mensagens restantes neste mês."}</small></section></div>
          </>}

          {section === "communities" && <>
            <div className="page-heading"><div><span className="eyebrow">SEU ESPAÇO</span><h1>Comunidades</h1><p>Conexão, proteção e avisos do seu grupo.</p></div>{!community && <button className="primary" type="button" onClick={() => navigate("connection")}><Icon name="plus" size={16} /> Conectar comunidade</button>}</div>
            {community ? <>
              <section className="panel community-hero"><span className="community-avatar">{community.name[0]?.toUpperCase()}</span><div className="community-identity"><h2>{community.name}</h2><p>{community.username ? "@" + community.username : "Grupo no Telegram"}</p><span className={"status-pill " + (community.moderationEnabled ? "status-active" : "status-inactive")}><span className="status-dot" />{community.moderationEnabled ? "Proteção ativa" : "Proteção pausada"}</span></div><button className="secondary" type="button" onClick={() => navigate("connection")}>Gerenciar bot <Icon name="arrow" size={15} /></button></section>
              <div className="community-metrics"><div className="stat-card"><span>Mensagens moderadas</span><strong>{number(used)}</strong><small>Neste mês</small></div><div className="stat-card"><span>Regras ativas</span><strong>{activeRules}</strong><small>Para este grupo</small></div><div className="stat-card"><span>Para conferir</span><strong>{number(data.usage.decisionsReview)}</strong><small>Decisões de revisão no mês</small></div></div>
              <section className="panel protection-setting"><div><h2>Proteção do grupo</h2><p>{community.moderationEnabled ? "O bot está analisando as novas mensagens com as regras ativas." : "A moderação está pausada. As regras continuam salvas para quando você reativar."}</p></div><button role="switch" aria-checked={community.moderationEnabled} aria-label="Ativar proteção do grupo" className={"switch" + (community.moderationEnabled ? " on" : "")} disabled={disabled || (!community.moderationEnabled && !activeRules)} onClick={() => void mutate("toggleModeration", { communityId: community.id, enabled: !community.moderationEnabled }, community.moderationEnabled ? "Proteção pausada." : "Proteção ativada.")}><span /></button></section>
              <section className="panel settings-panel"><div className="section-heading"><div><span className="eyebrow">PROGRESSÃO DE AVISOS</span><h2>Configurações da comunidade</h2><p>Os avisos se acumulam por participante durante o período configurado.</p></div><Icon name="settings" size={19} /></div>
                <form key={community.id} onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); const value = (name: string) => String(fields.get(name) ?? "").trim(); const muteAt = value("warningMuteAt"); const banAt = value("warningBanAt"); const banDuration = value("warningBanDurationSeconds"); void mutate("saveCommunitySettings", { communityId: community.id, warningWindowDays: Number(value("warningWindowDays")), publicWarningsEnabled: fields.get("publicWarningsEnabled") === "on", warningMuteAt: muteAt ? Number(muteAt) : null, warningMuteDurationSeconds: Number(value("warningMuteDurationSeconds")), warningBanAt: banAt ? Number(banAt) : null, warningBanDurationSeconds: banDuration ? Number(banDuration) : null }, "Configurações de avisos salvas."); }}><fieldset className="form-stack" disabled={disabled}><div className="form-columns"><label>Prazo dos avisos (dias)<input name="warningWindowDays" type="number" min="1" max="3650" defaultValue={community.warningWindowDays} required /></label><label>Silenciar após quantos avisos?<input name="warningMuteAt" type="number" min="1" placeholder="Desativado" defaultValue={community.warningMuteAt ?? ""} /></label></div><div className="form-columns"><label>Duração do silêncio (segundos)<input name="warningMuteDurationSeconds" type="number" min="60" defaultValue={community.warningMuteDurationSeconds} required /></label><label>Banir após quantos avisos?<input name="warningBanAt" type="number" min="1" placeholder="Desativado" defaultValue={community.warningBanAt ?? ""} /></label></div><label>Duração do banimento (segundos)<input name="warningBanDurationSeconds" type="number" min="60" placeholder="Em branco = permanente" defaultValue={community.warningBanDurationSeconds ?? ""} /></label><label className="checkbox"><input name="publicWarningsEnabled" type="checkbox" defaultChecked={community.publicWarningsEnabled} />Enviar avisos publicamente no grupo</label><button className="primary" type="submit">{pending === "saveCommunitySettings" ? "Salvando…" : "Salvar configurações"}</button></fieldset></form>
              </section>
            </> : <div className="panel empty-state"><Icon name="communities" size={28} /><h2>Sua comunidade começa aqui</h2><p>Conecte um grupo para configurar regras e acompanhar a moderação.</p><button className="primary" type="button" onClick={() => navigate("connection")}>Conectar grupo <Icon name="arrow" size={15} /></button></div>}
          </>}

          {section === "participants" && <>
            <div className="page-heading"><div><span className="eyebrow">CRESCIMENTO DA COMUNIDADE</span><h1>Participantes</h1><p>Acompanhe entradas, saídas e o saldo de pessoas no grupo.</p></div><span className="small-tag">Últimos 7 dias</span></div>
            {participantActivity ? <>
              <div className="stats-grid"><div className="stat-card"><span>Entraram</span><strong>{number(participantActivity.joined)}</strong><small>Novos participantes</small></div><div className="stat-card"><span>Saíram</span><strong>{number(participantActivity.left)}</strong><small>Deixaram o grupo</small></div><div className="stat-card"><span>Saldo no período</span><strong>{participantActivity.joined - participantActivity.left >= 0 ? "+" : ""}{number(participantActivity.joined - participantActivity.left)}</strong><small>Entradas menos saídas</small></div></div>
              <div className="overview-grid"><section className="panel"><div className="section-heading"><div><h2>Movimentação diária</h2><p>Entradas e saídas nos últimos 7 dias</p></div></div><div className="chart-legend"><span><i className="legend-dot joined" />Entradas</span><span><i className="legend-dot left" />Saídas</span></div><ParticipantChart days={participantActivity.daily} /></section>
                <section className="panel"><div className="section-heading"><div><h2>Atividade recente</h2><p>Movimentação registrada no grupo</p></div></div>{participantActivity.recent.length ? <div className="member-events">{participantActivity.recent.map(event => <div className="member-event" key={event.id}><span className={"member-event-type " + (event.type === "JOIN" ? "joined" : "left")}>{event.type === "JOIN" ? "Entrou" : "Saiu"}</span><div><strong>{event.displayName || "Participante"}</strong><span>{event.type === "JOIN" ? "Entrou no grupo" : "Saiu do grupo"}</span></div><time dateTime={event.occurredAt}>{shortTime(event.occurredAt)}</time></div>)}</div> : <div className="compact-empty"><strong>Nenhum movimento recente</strong><p>Novas entradas e saídas aparecerão aqui.</p></div>}</section></div>
            </> : <section className="panel participants-empty"><span className="empty-icon"><Icon name="participants" size={28} /></span><h2>Movimentação ainda não disponível</h2><p>Este grupo ainda não acompanha entradas e saídas de participantes. Quando o registro estiver ativo, você verá o saldo e a atividade recente aqui.</p><div className="empty-stat-preview"><span>Entradas <strong>—</strong></span><span>Saídas <strong>—</strong></span><span>Saldo <strong>—</strong></span></div></section>}
          </>}

          {section === "rules" && <>
            <div className="page-heading"><div><span className="eyebrow">PROTEÇÃO DA COMUNIDADE</span><h1>Regras de moderação</h1><p>Defina o que merece atenção e teste antes de ativar.</p></div>{community && <button className="primary" type="button" disabled={disabled || !!editor || activeRules >= activeLimit} onClick={() => openRuleEditor(emptyRule)}><Icon name="plus" size={16} /> Nova regra</button>}</div>
            {!community ? <div className="panel empty-state"><Icon name="rules" size={28} /><h2>Primeiro, conecte uma comunidade</h2><p>As regras precisam de um grupo para funcionar.</p><button className="primary" type="button" onClick={() => navigate("connection")}>Conectar comunidade <Icon name="arrow" size={15} /></button></div> : <>
              <section className="panel rules-panel"><div className="section-heading"><div><h2>Regras de {community.name} <span className="count">{activeRules}/{activeLimit} ativas</span></h2><p>As regras orientam a decisão; a ação executada segue a configuração abaixo.</p></div></div>
                {activeRules >= activeLimit && <p className="inline-hint">Você atingiu o limite de {activeLimit} regras ativas. Pause uma regra para ativar outra.</p>}
                {!rules.length && !editor && <div className="compact-empty"><Icon name="rules" size={22} /><strong>Comece com uma regra clara</strong><p>Escreva suas instruções ou escolha uma sugestão abaixo.</p></div>}
                <div className="rule-list">{rules.map(rule => <article className="rule-row" key={rule.id}><div className="rule-symbol"><Icon name="shield" size={17} /></div><div className="rule-body"><div className="rule-title"><h3>{rule.name}</h3><span className="small-tag">{actionLabels[rule.action]}</span><span className="muted">Prioridade {rule.priority}</span></div><p>{rule.ruleText}</p><div className="rule-meta">{rule.actionDurationSeconds ? rule.actionDurationSeconds + "s" : rule.action === "BAN" ? "Banimento permanente" : ""}{rule.deleteMessage ? " · Exclui a mensagem" : ""}</div></div><div className="rule-actions"><button role="switch" aria-checked={rule.enabled} aria-label={"Ativar " + rule.name} className={"switch" + (rule.enabled ? " on" : "")} disabled={disabled || (!rule.enabled && activeRules >= activeLimit)} onClick={() => { void mutate("saveRule", { id: rule.id, communityId: rule.communityId, name: rule.name, ruleText: rule.ruleText, ruleAction: rule.action, actionDurationSeconds: rule.actionDurationSeconds, deleteMessage: rule.deleteMessage, priority: rule.priority, enabled: !rule.enabled }, "Regra atualizada."); setResult(null); }}><span /></button><button className="text-button" type="button" disabled={disabled} onClick={() => openRuleEditor(rule)}>Editar</button><button className="text-button danger" type="button" disabled={disabled} onClick={() => setDeleting(rule.id)}>Excluir</button></div>{deleting === rule.id && <div className="delete-confirm"><span>Excluir “{rule.name}”? Esta ação não pode ser desfeita.</span><button className="danger-button" type="button" disabled={disabled} onClick={async () => { if (await mutate("deleteRule", { id: rule.id }, "Regra excluída.")) { setDeleting(""); setResult(null); if (editor?.id === rule.id) setEditor(null); } }}>Confirmar exclusão</button><button className="secondary" type="button" disabled={disabled} onClick={() => setDeleting("")}>Cancelar</button></div>}</article>)}</div>
                {editor && <form className="rule-editor" key={editor.id ?? editor.name ?? "new"} onSubmit={saveRule}><div className="section-heading"><div><h3>{editor.id ? "Editar regra" : "Nova regra"}</h3><p>Descreva o que sinalizar e o que deve ser permitido.</p></div><button className="icon-button" type="button" aria-label="Fechar editor" onClick={() => setEditor(null)}><Icon name="close" size={17} /></button></div><fieldset className="form-stack" disabled={disabled}><label>Nome da regra<input name="name" defaultValue={editor.name} required maxLength={100} autoFocus /></label><label>O que esta regra deve identificar?<textarea name="ruleText" defaultValue={editor.ruleText} placeholder="Descreva a situação e inclua exceções relevantes." required maxLength={2000} rows={4} /></label><div className="form-columns"><label>Quando houver correspondência<select name="ruleAction" value={editingAction} onChange={event => setEditingAction(event.target.value as Rule["action"])}><option value="WARN">Avisar</option><option value="MUTE">Silenciar</option><option value="BAN">Banir</option></select></label><label>Prioridade<input name="priority" type="number" min={0} max={1000} defaultValue={editor.priority} required /></label></div>{editingAction !== "WARN" && <label>Duração em segundos <small>{editingAction === "MUTE" ? "Obrigatória para silenciar" : "Em branco para banimento permanente"}</small><input name="actionDurationSeconds" type="number" min={60} defaultValue={editor.actionDurationSeconds ?? ""} /></label>}<label className="checkbox"><input name="deleteMessage" type="checkbox" defaultChecked={editor.deleteMessage} />Excluir a mensagem correspondente</label><label className="checkbox"><input name="enabled" type="checkbox" defaultChecked={editor.enabled} disabled={!editor.enabled && activeRules >= activeLimit} />Ativar esta regra</label><div className="button-row"><button className="primary" type="submit">{pending === "saveRule" ? "Salvando…" : "Salvar regra"}</button><button className="secondary" type="button" onClick={() => setEditor(null)}>Cancelar</button></div></fieldset></form>}
              </section>
              {rules.length === 0 && <section className="templates-section"><div className="section-heading"><div><h2>Comece com uma sugestão</h2><p>Revise o texto antes de salvar no grupo.</p></div></div><div className="templates">{templates.map((template, index) => <button className="panel template" type="button" key={template.name} disabled={disabled || !!editor || activeRules >= activeLimit} onClick={() => openRuleEditor({ ...emptyRule, ...template })}><span className="template-number">0{index + 1}</span><h3>{template.name} <Icon name="arrow" size={16} /></h3><p>{template.ruleText}</p></button>)}</div></section>}
              <section className="panel tester"><div><span className="eyebrow">TESTE ANTES DE ATIVAR</span><h2>Veja como as regras respondem</h2><p>Cole uma mensagem de exemplo. O teste não altera nenhuma mensagem do Telegram.</p><small>Até {data.limits.testsPerDay} testes por dia. Apenas regras ativas entram no teste.</small></div><div><form onSubmit={event => { event.preventDefault(); setResult(null); void mutate("testRules", { communityId: community.id, text: testText.trim() }, "Teste concluído. Nenhuma mensagem foi alterada."); }}><fieldset disabled={disabled || !activeRules} className="form-stack"><label>Mensagem de exemplo<textarea value={testText} onChange={event => { setTestText(event.target.value); setResult(null); }} maxLength={4000} rows={4} placeholder="Cole uma mensagem de uma conversa…" required /></label><button className="primary" type="submit" disabled={!testText.trim()}>{pending === "testRules" ? "Testando…" : "Testar mensagem"} <Icon name="arrow" size={15} /></button></fieldset></form>{!activeRules && <p className="inline-hint">Ative uma regra para fazer o teste.</p>}{result && <div className="test-result" role="status"><StateBadge state={result.state} /><p>{reasonLabel(result.reason)}</p>{(result.evaluations ?? result.matchedRules ?? []).map(item => <div className="evaluation" key={item.ruleId}><span>{item.ruleName ?? rules.find(rule => rule.id === item.ruleId)?.name ?? "Regra"}</span><strong>{probability(item.probability)}</strong></div>)}<small>O teste não simula o histórico de avisos do participante.</small></div>}</div></section>
            </>}
          </>}

          {section === "log" && <><div className="page-heading"><div><span className="eyebrow">TRANSPARÊNCIA E CONTEXTO</span><h1>Registro de moderação</h1><p>Entenda cada decisão e dê retorno quando uma regra errar.</p></div></div><ModerationLog key={logFilter + (community?.id ?? "")} logs={communityLogs} disabled={disabled} initialFilter={logFilter} onFeedback={(decisionId, expectedState) => mutate("feedback", { decisionId, expectedState }, "Retorno salvo.")} /></>}

          {section === "connection" && <>
            <button className="text-button page-back" type="button" onClick={() => navigate("communities")}>← Comunidades</button>
            <div className="page-heading"><div><span className="eyebrow">INTEGRAÇÃO</span><h1>Telegram bot</h1><p>Confira a conexão e as permissões necessárias para moderar.</p></div><span className={"status-pill " + (data.bot?.status === "active" ? "status-active" : "status-inactive")}><span className="status-dot" />{data.bot?.status === "active" ? "Bot disponível" : "Bot indisponível"}</span></div>
            <div className="connection-grid"><section className="panel connection-main"><div className="section-heading"><div><h2>{community ? "Conexão com " + community.name : "Conecte seu grupo"}</h2><p>O bot oficial modera o grupo com as regras que você configurar.</p></div><Icon name="bot" size={20} /></div>
                {community ? <div className="connected-community"><span className="community-avatar">{community.name[0]?.toUpperCase()}</span><div><strong>{community.name}</strong><small>Grupo conectado ao Telegram Manager</small></div><span className={"status-pill " + (community.moderationEnabled ? "status-active" : "status-inactive")}><span className="status-dot" />{community.moderationEnabled ? "Proteção ativa" : "Proteção pausada"}</span></div>
                  : data.connectionAttempt?.state === "DISCOVERED" && data.connectionAttempt.candidate ? <div className="connected-community"><span className="community-avatar">{data.connectionAttempt.candidate.name?.[0]?.toUpperCase() ?? "#"}</span><div><strong>{data.connectionAttempt.candidate.name ?? "Grupo Telegram"}</strong><small>{data.connectionAttempt.candidate.botIsAdmin && data.connectionAttempt.candidate.userIsAdmin ? "Pronto para proteger este grupo." : data.connectionAttempt.errorMessage ?? "Conclua as permissões de administrador no Telegram."}</small></div><button className="primary" type="button" disabled={disabled} onClick={() => void mutate("confirmConnection", { attemptId: data.connectionAttempt!.id }, "Grupo conectado e protegido.")}>{pending === "confirmConnection" ? "Verificando…" : "Proteger grupo"}</button></div>
                  : data.connectionAttempt?.state === "PENDING" && connectionUrl ? <div className="connection-action"><a className="primary" href={connectionUrl}>Abrir Telegram para escolher o grupo <Icon name="external" size={16} /></a><small>Este link expira em 15 minutos.</small></div>
                  : <div className="connection-action">{data.connectionAttempt?.errorMessage && <p className="inline-hint">{data.connectionAttempt.errorMessage}</p>}<button className="primary" type="button" disabled={disabled || data.bot?.status !== "active"} onClick={() => void mutate("startConnection", {}, "Escolha seu grupo no Telegram e volte para confirmar.")}>{pending === "startConnection" ? "Preparando link…" : "Adicionar meu grupo"} <Icon name="arrow" size={15} /></button></div>}
                {community && <div className="permission-list"><div><Icon name="check" size={17} />Bot adicionado ao grupo</div><div><Icon name="check" size={17} />Regras configuradas neste workspace</div><div><Icon name="check" size={17} />Decisões disponíveis no registro</div></div>}
              </section><section className="panel connection-steps"><h2>Como conectar</h2><p>Você não precisa informar token nem ID do chat.</p><ol><li><span>1</span><div><strong>Escolha seu grupo no Telegram</strong><p>Abra o convite do bot oficial.</p></div></li><li><span>2</span><div><strong>Dê as permissões necessárias</strong><p>Permita excluir mensagens e restringir membros.</p></div></li><li><span>3</span><div><strong>Confirme a conexão</strong><p>Volte para este painel e teste uma regra.</p></div></li></ol></section></div>
          </>}
          <footer className="dashboard-footer"><span>Telegram Manager · Moderação com clareza</span><span>{data.organization.name}</span></footer>
        </>}
      </main>
    </div>
  </div>;
}
