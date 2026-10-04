import type { ReactNode } from "react";

export type IconName =
  | "overview" | "communities" | "participants" | "rules" | "log" | "bot"
  | "arrow" | "plus" | "refresh" | "shield" | "alert" | "check"
  | "message" | "trend" | "settings" | "close" | "external";

const paths: Record<IconName, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  communities: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2H3Z" /><path d="M17 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2h-3" /></>,
  participants: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2H3ZM18 8v6m-3-3h6" /></>,
  rules: <><path d="M9 6h12M9 12h12M9 18h12M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17" /></>,
  log: <><path d="M6 3h10l3 3v15H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" /><path d="M8 10h8M8 14h8M8 18h5" /></>,
  bot: <><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4M9 3h6M8 13h.01M16 13h.01M9 17h6" /></>,
  arrow: <><path d="M4 12h16M14 6l6 6-6 6" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14-5L4 8M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2M20 20v-4h-4" /></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 17h.01" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  message: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-2 2v-9.5A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z" /><path d="M7 11h9M7 14h6" /></>,
  trend: <><path d="m3 17 6-6 4 4 8-8M15 7h6v6" /></>,
  settings: <><path d="M4 7h16M4 17h16M8 4v6M16 14v6" /></>,
  close: <><path d="M5 5l14 14M19 5 5 19" /></>,
  external: <><path d="M13 4h7v7M20 4l-9 9" /><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" /></>,
};

export function Icon({ name, size = 18, className = "" }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
