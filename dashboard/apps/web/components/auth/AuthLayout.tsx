"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTheme } from "@/components/providers/theme";
import { IconMoon, IconSun } from "@/components/ui/icons";
import { AuthGraph } from "./AuthGraph";

interface AuthLayoutProps {
  view: "login" | "signup";
  children: ReactNode;
}

type Reg = "serif" | "sans" | "key";
interface Token {
  t: string;
  c: Reg;
}

/** The heading is typed (serif) with a single displayed keyword per view —
 *  `intelligence` on login, `operating layer` on signup. That keyword carries
 *  the page's two authored animations: it re-sets itself in a new elegant face,
 *  accelerating from slow to fast, and one blue mark sweeps across it as the
 *  word turns permanently blue. */
const COPY = {
  login: {
    aria: "Coordinate intelligence, not busywork.",
    // three deterministic lines: the keyword owns its own, so the sentence can
    // never rewrap as the face (and thus the word's width) changes
    lines: [
      [{ t: "Coordinate", c: "serif" }],
      [{ t: "intelligence,", c: "key" }],
      [{ t: "not busywork.", c: "sans" }],
    ] as Token[][],
    description:
      "Enter the command layer for your autonomous research swarm. Observe agents, direct work, and keep every finding connected.",
    footnote: "Protected workspace — activity is continuously recorded.",
  },
  signup: {
    aria: "Build your operating layer.",
    lines: [
      [{ t: "Build your", c: "serif" }],
      [{ t: "operating layer.", c: "key" }],
    ] as Token[][],
    description:
      "Create an operator account, configure a swarm, and bring autonomous work into one observable command layer.",
    footnote: "Operator access is provisioned to a secure command workspace.",
  },
} as const;

const STEPS = [
  ["01", "Create your operator identity", "Set access for your workspace."],
  ["02", "Configure your swarm", "Choose the work agents should own."],
  ["03", "Begin the first run", "Review work from the command layer."],
] as const;

/** The rotating display set: elegant scripts and high-contrast display serifs.
 *  The change starts slow and accelerates into a fast, settled cadence — the
 *  first face holds for SLOW_MS, each next change is DECAY of the previous,
 *  down to a floor of FAST_MS. */
const FACES = ["vibes", "pinyon", "cormorant", "playfair", "garamond", "bodoni"] as const;
const SLOW_MS = 820; // the first, slowest change
const FAST_MS = 120; // the settled cadence it eases into
const DECAY = 0.7; // each step is this fraction of the last

/** The blue mark lands once, late: a random delay in this range after load, so
 *  it reads as the system noticing rather than a load animation. */
const MARK_MIN_MS = 3000;
const MARK_MAX_MS = 10000;

/** Subscribes to the reduced-motion preference as an external store, so it
 *  stays correct across changes without a setState-in-effect. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

/** The displayed keyword: cycles its face on an accelerating cadence, and — once,
 *  somewhere 3–10s after load — a blue mark slides in behind it and stays. Split
 *  from the accessible name (the h1's aria-label) so screen readers get the
 *  sentence, not the animation. */
function KeyWord({ text }: { text: string }) {
  const [face, setFace] = useState(0);
  // "armed" unless we've committed to a mark. Starts false so SSR prints no
  // mark; the effect always arms it, so there is no hydration mismatch.
  const [marked, setMarked] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return;
    let id = 0;
    let step = 0;
    const tick = () => {
      setFace((v) => (v + 1) % FACES.length);
      const delay = Math.max(FAST_MS, Math.round(SLOW_MS * DECAY ** step));
      step += 1;
      id = window.setTimeout(tick, delay);
    };
    id = window.setTimeout(tick, SLOW_MS);
    return () => window.clearTimeout(id);
  }, [reduce]);

  useEffect(() => {
    // one-shot: slide the mark in after a random 3–10s delay
    const delay = reduce ? 0 : MARK_MIN_MS + Math.random() * (MARK_MAX_MS - MARK_MIN_MS);
    const id = window.setTimeout(() => setMarked(true), delay);
    return () => window.clearTimeout(id);
  }, [reduce]);

  return (
    <span className="authx-key" aria-hidden="true" data-face={reduce ? "vibes" : FACES[face]}>
      <span className={`axw-mark${marked ? " is-marked" : ""}`} />
      <span className="axw-text">{text}</span>
    </span>
  );
}

export function AuthLayout({ view, children }: AuthLayoutProps) {
  const { theme, toggle } = useTheme();
  const copy = COPY[view];
  const nextTheme = theme === "light" ? "dark" : "light";

  return (
    <section className="authx" aria-label="Operator access">
      <header className="authx-bar">
        <Link className="authx-brand" href="/login">
          <span className="authx-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="authx-word">autonomous agent v0</span>
        </Link>
        <div className="authx-bar-meta">
          <span className="authx-bar-label">Autonomous research operations</span>
          <button
            className="authx-theme"
            type="button"
            onClick={toggle}
            aria-label={`Switch to ${nextTheme} theme`}
            title={`Switch to ${nextTheme} theme`}
          >
            {theme === "light" ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </header>

      <div className="authx-split">
        <main className="authx-form-col">
          <div className="authx-form-inner">
            <h1 className="authx-h1" id="auth-heading" aria-label={copy.aria}>
              {copy.lines.map((line, li) => (
                <span className="authx-h1-line" key={li}>
                  {line.map((tok, ti) =>
                    tok.c === "key" ? (
                      <KeyWord key={ti} text={tok.t} />
                    ) : (
                      <span key={ti} className={`authx-h1-${tok.c}`}>
                        {tok.t}
                      </span>
                    ),
                  )}
                </span>
              ))}
            </h1>
            <p className="authx-lede">{copy.description}</p>

            {children}

            {view === "signup" ? (
              <ol className="authx-steps" aria-label="Setup process">
                {STEPS.map(([n, title, sub]) => (
                  <li className="authx-step" key={n}>
                    <span className="authx-step-n">{n}</span>
                    <span className="authx-step-body">
                      <strong>{title}</strong>
                      <span>{sub}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}

            <p className="authx-foot">{copy.footnote}</p>
          </div>
        </main>

        <aside className="authx-visual-col">
          <AuthGraph />
        </aside>
      </div>
    </section>
  );
}
