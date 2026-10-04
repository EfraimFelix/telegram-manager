"use client";
import Link from "next/link";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="full-state"><span className="brand-mark">↗</span><h1>Não foi possível abrir esta página.</h1><p>Seu workspace pode estar temporariamente indisponível. Tente novamente.</p><button className="primary" onClick={reset}>Tentar novamente</button><Link href="/sign-in">Voltar para entrar</Link></main>;
}
