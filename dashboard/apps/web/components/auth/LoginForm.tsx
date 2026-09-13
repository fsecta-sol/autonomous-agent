"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/components/providers/auth";
import { IconArrowRight } from "@/components/ui/icons";

export function LoginForm() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your work email and password to open the workspace.");
      return;
    }
    setSubmitting(true);
    const result = await signIn(email, password);
    if (!result.ok) {
      setError(result.error);
      setSubmitting(false);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form className="auth-panel" onSubmit={onSubmit} noValidate>
      <div className="auth-card">
        <div className="auth-card-head">
          <h2>Welcome back</h2>
          <p>Log in to open your command workspace.</p>
        </div>
        <div className="auth-fields">
          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="auth-field">
            <label htmlFor="login-email">Work email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              placeholder="operator@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="auth-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="auth-row">
            <label className="auth-check">
              <input type="checkbox" defaultChecked /> Keep me signed in
            </label>
            <a className="auth-link" href="#">
              Forgot password?
            </a>
          </div>
          <button className="auth-submit" type="submit" disabled={submitting}>
            {submitting ? "Opening workspace…" : "Login"}
            <span aria-hidden="true">{submitting ? "·" : <IconArrowRight style={{ width: 18, height: 18 }} />}</span>
          </button>
        </div>
        <div className="auth-card-foot">
          New to the workspace?{" "}
          <Link href="/sign-up" style={{ color: "var(--ink)", fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 3 }}>
            Create an operator account
          </Link>
        </div>
      </div>
    </form>
  );
}
