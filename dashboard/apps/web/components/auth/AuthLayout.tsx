"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useTheme } from "@/components/providers/theme";
import { IconMoon, IconSun } from "@/components/ui/icons";
import { IntelligenceTrajectory } from "./IntelligenceTrajectory";

interface AuthLayoutProps {
  view: "login" | "signup";
  children: ReactNode;
}

const COPY = {
  login: {
    eyebrow: "Control plane / secure access",
    heading: "Coordinate intelligence, not busywork.",
    description:
      "Enter the command layer for your autonomous research swarm. Observe agents, direct work, and keep every finding connected.",
    footnote: "Protected workspace / activity is continuously recorded.",
  },
  signup: {
    eyebrow: "Operator provisioning / step 01",
    heading: "Build your operating layer.",
    description:
      "Create an operator account, configure a swarm, and bring autonomous work into one observable command layer.",
    footnote: "Operator access is provisioned to a secure command workspace.",
  },
} as const;

export function AuthLayout({ view, children }: AuthLayoutProps) {
  const { theme, toggle } = useTheme();
  const copy = COPY[view];
  const nextTheme = theme === "light" ? "dark" : "light";

  return (
    <section className="auth-shell" aria-label="Operator access">
      <IntelligenceTrajectory />
      <header className="auth-topbar">
        <Link className="auth-brand" href="/login">
          <span className="auth-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="wordmark">autonomous agent v0</span>
        </Link>
        <div className="auth-meta">
          <span>Autonomous research operations</span>
          <button
            className="icon-btn"
            type="button"
            onClick={toggle}
            aria-label={`Switch to ${nextTheme} theme`}
            title={`Switch to ${nextTheme} theme`}
          >
            <span className="theme-icon-light" style={{ display: theme === "light" ? "contents" : "none" }}>
              <IconSun />
            </span>
            <span className="theme-icon-dark" style={{ display: theme === "dark" ? "contents" : "none" }}>
              <IconMoon />
            </span>
          </button>
        </div>
      </header>
      <main className="auth-main" aria-label="Operator access">
        <section className="auth-intro" aria-labelledby="auth-heading">
          <p className="auth-eyebrow">
            <span className="auth-signal" />
            <span>{copy.eyebrow}</span>
          </p>
          <h1 id="auth-heading">{copy.heading}</h1>
          <p>{copy.description}</p>
          {view === "login" ? (
            <div id="auth-status" className="auth-status" role="group" aria-label="Swarm status">
              <div>
                <span>Agents</span>
                <strong>06 online</strong>
              </div>
              <div>
                <span>Pipeline</span>
                <strong>08 active</strong>
              </div>
              <div>
                <span>Quality</span>
                <strong>94%</strong>
              </div>
            </div>
          ) : (
            <div id="auth-steps" className="auth-steps" role="group" aria-label="Setup process">
              <div className="auth-step">
                <span className="auth-step-n">01</span>
                <div>
                  <strong>Create your operator identity</strong>
                  <span>Set access for your workspace.</span>
                </div>
              </div>
              <div className="auth-step">
                <span className="auth-step-n">02</span>
                <div>
                  <strong>Configure your swarm</strong>
                  <span>Choose the work agents should own.</span>
                </div>
              </div>
              <div className="auth-step">
                <span className="auth-step-n">03</span>
                <div>
                  <strong>Begin the first run</strong>
                  <span>Review work from the command layer.</span>
                </div>
              </div>
            </div>
          )}
        </section>
        <section>
          {children}
          <p className="auth-footnote">{copy.footnote}</p>
        </section>
      </main>
    </section>
  );
}
