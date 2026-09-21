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
    if (signup && !name) { setError("Please enter your name."); return; }
    setPending(true); setError("");
    try {
      await request(`/api/auth/${signup ? "sign-up" : "sign-in"}/email`, {
        email: String(fields.get("email")).trim(), password: String(fields.get("password")), ...(signup ? { name } : {}),
      });
      window.location.replace("/");
    } catch (error) { setError(errorMessage(error)); setPending(false); }
  }
  return <main className="auth-page">
    <section className="auth-story"><Link className="brand" href="/"><span className="brand-mark">↗</span> Telegram Manager</Link>
      <div><p className="eyebrow">A little order. A better community.</p><h1>Good conversations<br />start with clear rules.</h1><p>Thoughtful moderation for your Telegram community. Your rules, a helping hand, and every decision in view.</p></div>
      <p className="auth-footnote">Built for communities, with you in control.</p>
    </section>
    <section className="auth-panel"><div className="auth-form">
      <span className="badge">YOUR COMMUNITY, IN GOOD HANDS</span><h2>{signup ? "Make room for better conversations." : "Welcome back."}</h2>
      <p>{signup ? "Create your free workspace to get started." : "Sign in to your moderation workspace."}</p>
      <form onSubmit={submit} aria-busy={pending}>
        <fieldset disabled={pending} className="form-stack">
          {signup && <label>Your name<input name="name" autoComplete="name" required maxLength={100} /></label>}
          <label>Email address<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} /></label>
          <label>Password<input key={String(signup)} name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={signup ? 8 : 1} maxLength={128} required aria-describedby={signup ? "password-help" : undefined} /></label>
          {signup && <small id="password-help">Use at least 8 characters.</small>}
          {error && <p className="notice error" role="alert">{error}</p>}
          <button className="primary" type="submit">{pending ? "Please wait…" : signup ? "Create account →" : "Sign in →"}</button>
        </fieldset>
      </form>
      <p className="auth-switch">{signup ? "Already have an account?" : "New here?"} <button className="text-button" disabled={pending} onClick={() => { setSignup(!signup); setError(""); }}>{signup ? "Sign in" : "Create an account"}</button></p>
      <div className="auth-plan"><strong>Start small. Stay in control.</strong><p>Free includes 1 community, 3 active rules, and 5,000 moderated messages per month.</p></div>
    </div></section>
  </main>;
}
