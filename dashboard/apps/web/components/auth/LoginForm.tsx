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
    <form className="authf" onSubmit={onSubmit} noValidate>
      <div className="authf-head">
        <span className="authf-head-label">Sign in</span>
        <Link className="authf-head-alt" href="/sign-up">
          Need an account?
        </Link>
      </div>

      {error ? (
        <p className="authf-error" role="alert">
          {error}
        </p>
      ) : null}

      <label className="authf-field">
        <span className="authf-label">Work email</span>
        <input
          className="authf-input"
          type="email"
          autoComplete="email"
          placeholder="operator@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>

      <label className="authf-field">
        <span className="authf-label">Password</span>
        <input
          className="authf-input"
          type="password"
          autoComplete="current-password"
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>

      <div className="authf-row">
        <label className="authf-check">
          <input type="checkbox" defaultChecked /> Keep me signed in
        </label>
        <a className="authf-link" href="#">
          Forgot password?
        </a>
      </div>

      <button className="authf-submit" type="submit" disabled={submitting}>
        {submitting ? "Opening workspace…" : "Open workspace"}
        <span aria-hidden="true" className="authf-submit-arrow">
          {submitting ? "·" : <IconArrowRight style={{ width: 18, height: 18 }} />}
        </span>
      </button>
    </form>
  );
}
