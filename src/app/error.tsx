"use client";
import Link from "next/link";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="full-state"><span className="brand-mark">↗</span><h1>We couldn’t open this page.</h1><p>Your workspace may be temporarily unavailable. Please try again.</p><button className="primary" onClick={reset}>Try again</button><Link href="/sign-in">Return to sign in</Link></main>;
}
