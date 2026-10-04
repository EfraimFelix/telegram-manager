"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { errorMessage, request } from "@/components/dashboard-api";

export default function SignIn() {
  const [signup, setSignup] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("name") ?? "").trim();
    if (signup && !name) { setError("Informe seu nome."); return; }
    setPending(true); setError("");
    try {
      await request(`/api/auth/${signup ? "sign-up" : "sign-in"}/email`, {
        email: String(fields.get("email")).trim(), password: String(fields.get("password")), ...(signup ? { name } : {}),
      });
      window.location.replace("/");
    } catch (error) { setError(errorMessage(error)); setPending(false); }
  }
  return <main className="auth-page">
    <section className="auth-story"><Link className="brand" href="/"><span className="brand-mark">↗</span><span className="brand-copy"><strong>Telegram Manager</strong><small>Moderação com clareza</small></span></Link>
      <div><p className="eyebrow">SUA COMUNIDADE, SOB CONTROLE</p><h1>Boas conversas começam com regras claras.</h1><p>Acompanhe a moderação do seu grupo com decisões transparentes e ações definidas por você.</p></div>
      <p className="auth-footnote">Feito para quem cuida de comunidades.</p>
    </section>
    <section className="auth-panel"><div className="auth-form">
      <span className="eyebrow">TELEGRAM MANAGER</span><h2>{signup ? "Crie seu espaço." : "Bem-vindo de volta."}</h2>
      <p>{signup ? "Comece com um workspace gratuito." : "Acesse o painel de moderação da sua comunidade."}</p>
      <form onSubmit={submit} aria-busy={pending}>
        <fieldset disabled={pending} className="form-stack">
          {signup && <label>Seu nome<input name="name" autoComplete="name" required maxLength={100} /></label>}
          <label>E-mail<input name="email" type="email" autoComplete="email" placeholder="voce@exemplo.com" required maxLength={254} /></label>
          <label>Senha<input key={String(signup)} name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={signup ? 8 : 1} maxLength={128} required aria-describedby={signup ? "password-help" : undefined} /></label>
          {signup && <small id="password-help">Use pelo menos 8 caracteres.</small>}
          {error && <p className="notice error" role="alert">{error}</p>}
          <button className="primary" type="submit">{pending ? "Aguarde…" : signup ? "Criar conta →" : "Entrar →"}</button>
        </fieldset>
      </form>
      <p className="auth-switch">{signup ? "Já tem uma conta?" : "Ainda não tem conta?"} <button className="text-button" disabled={pending} onClick={() => { setSignup(!signup); setError(""); }}>{signup ? "Entrar" : "Criar conta"}</button></p>
      <div className="auth-plan"><strong>Comece com o essencial.</strong><p>O plano gratuito inclui 1 comunidade, 3 regras ativas e 5.000 mensagens moderadas por mês.</p></div>
    </div></section>
  </main>;
}
