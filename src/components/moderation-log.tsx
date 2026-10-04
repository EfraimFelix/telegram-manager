"use client";

import { useState } from "react";
import { probability, type DashboardData, type DecisionState } from "./dashboard-api";
import { Icon } from "./icon";

const labels: Record<DecisionState, string> = { SKIPPED: "Ignorada", NO_MATCH: "Sem correspondência", REVIEW: "Revisar", MATCHED: "Regra acionada" };
const actionLabels = { WARN: "Aviso", DELETE: "Exclusão", MUTE: "Silêncio", BAN: "Banimento" } as const;
const actionStatusLabels: Record<string, string> = { PENDING: "pendente", SUCCESS: "concluída", FAILED: "falhou", SKIPPED: "ignorada" };
export function reasonLabel(reason: string | undefined) {
  if (!reason) return "Aguardando decisão de moderação.";
  if (reason === "No rule reached the review threshold.") return "Nenhuma regra atingiu o limite para revisão.";
  if (reason === "A rule is in the review band but no rule reached the match threshold.") return "Uma regra precisa de revisão, mas nenhuma atingiu o limite para aplicar uma ação.";
  if (reason === "A rule matched without a disciplinary action.") return "Uma regra foi acionada sem ação disciplinar.";
  const match = reason.match(/^Matched rules resolved to (WARN|MUTE|BAN) (directly|by warning progression)\.$/);
  if (match) return "Regras acionadas: " + actionLabels[match[1] as keyof typeof actionLabels].toLowerCase() + (match[2] === "directly" ? " diretamente." : " pela progressão de avisos.");
  return reason;
}
type FeedbackState = "NO_MATCH" | "REVIEW" | "MATCHED";

type Props = {
  logs: DashboardData["recentLogs"];
  disabled: boolean;
  initialFilter: DecisionState | "ALL";
  onFeedback: (decisionId: string, expectedState: FeedbackState) => Promise<boolean>;
};

export default function ModerationLog({ logs, disabled, initialFilter, onFeedback }: Props) {
  const [filter, setFilter] = useState<DecisionState | "ALL">(initialFilter);
  const [saved, setSaved] = useState<Record<string, FeedbackState>>({});
  const visible = logs.filter(log => filter === "ALL" || log.decision?.state === filter);

  return <section className="panel log-panel">
    <div className="section-heading log-heading"><div><h2>Atividade recente</h2><p>O retorno registra sua avaliação. Ele não desfaz uma ação no Telegram.</p></div><label className="filter">Mostrar<select value={filter} onChange={event => setFilter(event.target.value as DecisionState | "ALL")}><option value="ALL">Todas as decisões</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {!visible.length ? <div className="empty-state log-empty"><Icon name="log" size={26} /><h2>{logs.length ? "Nenhuma decisão neste filtro" : "As decisões aparecerão aqui"}</h2><p>{logs.length ? "Escolha outra classificação para ver o histórico." : "Quando o bot analisar mensagens, você verá o contexto e o resultado de cada uma."}</p></div> :
      <div className="log-list">{visible.map(log => {
        const decision = log.decision;
        const recorded = saved[log.id] ?? log.feedback.at(-1)?.expectedState;
        const maximumProbability = log.evaluations.reduce<number | null>((maximum, item) => Math.max(maximum ?? 0, item.probability), null);
        return <article className="log-entry" key={log.id}>
          <div className="log-top"><span className={"state-badge state-" + (decision?.state.toLowerCase() ?? "skipped")}>{decision ? labels[decision.state] : log.processingStatus.replaceAll("_", " ")}</span><time dateTime={log.receivedAt}>{new Date(log.receivedAt).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</time></div>
          <p className="message-text">{log.text}</p>
          <div className="log-meta"><span>{log.communityName}</span><span>Participante {log.platformUserId ? "· " + log.platformUserId.slice(-4) : "não identificado"}</span></div>
          <p className="log-reason">{reasonLabel(decision?.reason)}</p>
          <details className="log-details"><summary>Ver contexto e retorno <Icon name="arrow" size={15} /></summary>
            {log.text.length > 180 && <div className="log-full-message"><strong>Mensagem completa</strong><p>{log.text}</p></div>}
            {!!log.evaluations.length && <div className="evaluation-list" aria-label="Avaliações das regras">{log.evaluations.map(evaluation => <div className="evaluation" key={evaluation.ruleId}><span>{evaluation.ruleName} · {actionLabels[evaluation.configuredAction]}{evaluation.deleteMessage ? " · excluir mensagem" : ""}</span><strong>{probability(evaluation.probability)}</strong></div>)}</div>}
            <div className="decision-details"><span>Maior probabilidade <strong>{probability(maximumProbability)}</strong></span><span>Ações <strong>{log.actions.length ? log.actions.map(action => actionLabels[action.action] + " · " + (actionStatusLabels[action.status] ?? action.status.toLowerCase())).join(", ") : "Nenhuma"}</strong></span>{log.warning && <span>Aviso <strong>#{log.warning.warningNumber}</strong></span>}</div>
            {decision && decision.state !== "SKIPPED" && <div className="feedback"><strong>{recorded ? "Retorno salvo: " + labels[recorded] : "Qual deveria ser a classificação?"}</strong><div>{(["NO_MATCH", "REVIEW", "MATCHED"] as const).map(expectedState => <button className={"secondary small" + (recorded === expectedState ? " is-selected" : "")} type="button" key={expectedState} disabled={disabled} onClick={async () => { if (await onFeedback(decision.id, expectedState)) setSaved(current => ({ ...current, [log.id]: expectedState })); }}>{labels[expectedState]}</button>)}</div><small>Seu retorno não altera a ação já executada no Telegram.</small></div>}
          </details>
        </article>;
      })}</div>}
  </section>;
}
