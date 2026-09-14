import type { SVGProps } from "react";

/** Icon paths lifted from the OpenDesign reference. 16px grid, currentColor stroke. */

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 16 16",
  "aria-hidden": true,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
} as const;

export function IconGraph(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="3.4" cy="12.6" r="1.6" />
      <circle cx="8.1" cy="3.5" r="1.6" />
      <circle cx="12.7" cy="12.6" r="1.6" />
      <path d="M3.4 11 8.1 5M8.1 5l4.6 6" />
    </svg>
  );
}

export function IconMap(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="2" width="12" height="12" />
      <path d="M2 6h12M2 10h12M6 2v12M10 2v12" />
    </svg>
  );
}

export function IconInbox(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2 9.5 4 3h8l2 6.5V13H2Z" strokeLinejoin="round" />
      <path d="M2 9.5h3.2l1 1.8h3.6l1-1.8H14" />
    </svg>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2 11.5 5.4 5l3 4.4L11 7l3 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconResearch(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 14 14" strokeLinecap="round" />
      <path d="M7 5.1v3.8M5.1 7h3.8" strokeLinecap="round" />
    </svg>
  );
}

export function IconSwarm(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="5.2" cy="5.2" r="2.1" />
      <circle cx="10.8" cy="5.2" r="2.1" />
      <circle cx="8" cy="10.8" r="2.1" />
      <path d="M5.2 7.3 8 8.7M10.8 7.3 8 8.7" />
    </svg>
  );
}

export function IconOrchestration(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2 4h5M2 8h8M2 12h5" strokeLinecap="round" />
      <circle cx="12.5" cy="4" r="1.6" />
      <circle cx="13.5" cy="12" r="1.6" />
    </svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <svg {...base} strokeWidth={1.5} {...props}>
      <path d="M10.5 3 5.5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...base} strokeWidth={1.5} {...props}>
      <path d="M6 3.5 11 8l-5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconUser(props: IconProps) {
  return (
    <svg {...base} strokeWidth={1.4} {...props}>
      <circle cx="8" cy="5.2" r="2.6" />
      <path d="M3.2 13c0-2.7 2.1-4.4 4.8-4.4s4.8 1.7 4.8 4.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconProfileSmall(props: IconProps) {
  return (
    <svg {...base} strokeWidth={1.4} {...props}>
      <circle cx="8" cy="5.6" r="2.4" />
      <path d="M3 13.2c0-2.7 2.2-4.4 5-4.4s5 1.7 5 4.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconSun(props: IconProps) {
  return (
    <svg {...base} strokeWidth={1.4} {...props}>
      <circle cx="8" cy="8" r="3.2" />
      <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4L3.3 3.3" strokeLinecap="round" />
    </svg>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="currentColor" {...props}>
      <path d="M14 8.53A6 6 0 1 1 7.47 2A4.67 4.67 0 0 0 14 8.53Z" />
    </svg>
  );
}

export function IconFlag(props: IconProps) {
  return (
    <svg {...base} strokeWidth={1.4} {...props}>
      <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      <path d="M3 8h9M8.5 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconArrowUp(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg viewBox="0 0 10 6" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <path d="M1 1l4 4 4-4" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base} strokeWidth={1.4} {...props}>
      <circle cx="6.5" cy="6.5" r="3.4" />
      <path d="M9 9l4 4" strokeLinecap="round" />
    </svg>
  );
}

export function IconMaximize(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4} {...props}>
      <path d="M9 2h5v5M14 2l-5 5M7 14H2V9M2 14l5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconMinimize(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4} {...props}>
      <path d="M13 6H8V1M13 1l-5 5M3 10h5v5M8 10l-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconZoomIn(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4} {...props}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function IconZoomOut(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4} {...props}>
      <path d="M3 8h10" />
    </svg>
  );
}

export function IconFit(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4} {...props}>
      <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
    </svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 3.5A1.5 1.5 0 0 1 4 2h3l2 2h3A1.5 1.5 0 0 1 13.5 5.5v7A1.5 1.5 0 0 1 12 14H4a1.5 1.5 0 0 1-1.5-1.5Z" />
    </svg>
  );
}

export function IconChat(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 4.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
    </svg>
  );
}

export function IconAttachment(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4} {...props}>
      <path d="M10 4.5 5.4 9.1a2 2 0 0 0 2.8 2.8l5-5a3.4 3.4 0 0 0-4.8-4.8l-5.2 5.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconSpark(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.2} {...props}>
      <path d="M8 2l1.5 3.8L13.5 7l-3.8 1.5L8 12.5 6.5 8.5 2.5 7l4-1.2z" strokeLinejoin="round" />
    </svg>
  );
}

export function IconScreen(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <rect x="2" y="3" width="12" height="8" />
      <path d="M6.5 13h3M8 11v2" />
    </svg>
  );
}

export function IconMic(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <rect x="6" y="2" width="4" height="8" rx="2" />
      <path d="M4 8a4 4 0 0 0 8 0M8 12v2" strokeLinecap="round" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={3} {...props}>
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function IconDot(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="currentColor" {...props}>
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.8} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconEdit(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <path d="M11.3 2.7l2 2L6 12l-2.6.6L4 10z" />
      <path d="M9.8 4.2l2 2" />
    </svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <path d="M3 4.5h10" />
      <path d="M6.5 4.5V3h3v1.5" />
      <path d="M4.3 4.5l.6 8.2h6.2l.6-8.2" />
      <path d="M6.7 7v3.6M9.3 7v3.6" />
    </svg>
  );
}

export function IconBolt(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="currentColor" {...props}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
    </svg>
  );
}

export function IconPlug(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 8h10M8 3v10" strokeLinecap="round" />
    </svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconAppearance(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 3.5v9" />
    </svg>
  );
}

/* --- execution-timeline activity glyphs (16px grid, 1.3 stroke) --- */

export function IconThink(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 2.5c-2.7 0-4.5 1.8-4.5 4.2 0 1.4.7 2.5 1.7 3.2v2.1h5.6v-2.1c1-.7 1.7-1.8 1.7-3.2 0-2.4-1.8-4.2-4.5-4.2z" />
      <path d="M6.3 13.6h3.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.5 2.4 5.5S9.6 12.9 8 13.5C6.4 12.9 5.6 11 5.6 8S6.4 4.1 8 2.5z" />
    </svg>
  );
}

export function IconDoc(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
      <path d="M6 8.5h4M6 11h3" strokeLinecap="round" />
    </svg>
  );
}

export function IconTable(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="3" width="11" height="10" />
      <path d="M2.5 6.3h11M2.5 9.6h11M6 3v10" />
    </svg>
  );
}

export function IconPlan(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 4h8M4 8h8M4 12h5" strokeLinecap="round" />
      <circle cx="2.4" cy="4" r=".7" />
      <circle cx="2.4" cy="8" r=".7" />
      <circle cx="2.4" cy="12" r=".7" />
    </svg>
  );
}

export function IconCode(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 4.5 2.8 8 6 11.5M10 4.5 13.2 8 10 11.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 2.2 13 4v3.6c0 3-2.1 5-5 6.2-2.9-1.2-5-3.2-5-6.2V4z" />
      <path d="M6 7.9 7.4 9.3 10.2 6.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconBranch(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="3.6" cy="4" r="1.4" />
      <circle cx="3.6" cy="12" r="1.4" />
      <circle cx="12.4" cy="8" r="1.4" />
      <path d="M5 4.4c3 .4 4 1.2 5.5 3M5 11.6c3-.4 4-1.2 5.5-3" />
    </svg>
  );
}

export function IconOutput(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="2.5" width="10" height="11" />
      <path d="M5.5 8.5h5M5.5 11h3" strokeLinecap="round" />
      <path d="M5.5 5.5h2" strokeLinecap="round" />
    </svg>
  );
}
