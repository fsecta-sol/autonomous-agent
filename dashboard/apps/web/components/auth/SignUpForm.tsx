"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/components/providers/auth";
import { IconArrowRight } from "@/components/ui/icons";

export function SignUpForm() {
  const router = useRouter();
  const { signUp } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!name.trim()) return setError("Enter your full name for the operator identity.");
    if (!email.trim()) return setError("A work email is required to provision the workspace.");
    if (password.length < 8) return setError("Choose a password of at least 8 characters.");
    if (!agreed) return setError("Accept the Terms of Use and Privacy Policy to continue.");
    setSubmitting(true);
    const result = await signUp(name, email, password);
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
          <h2>Create your account</h2>
          <p>Start with your operator credentials.</p>
        </div>
        <div className="auth-fields">
          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="auth-field">
            <label htmlFor="signup-name">Full name</label>
            <input
              id="signup-name"
              type="text"
              autoComplete="name"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="auth-field">
            <label htmlFor="signup-email">Work email</label>
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              placeholder="operator@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="auth-field">
            <label htmlFor="signup-password">Create password</label>
            <input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              placeholder="Minimum 8 characters"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <label className="auth-check auth-check-terms">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} required />I agree to
            the{" "}
            <a className="auth-link" href="#">
              Terms of Use
            </a>{" "}
            and{" "}
            <a className="auth-link" href="#">
              Privacy Policy
            </a>
            .
          </label>
          <button className="auth-submit" type="submit" disabled={submitting}>
            {submitting ? "Provisioning…" : "Create operator account"}
            <span aria-hidden="true">{submitting ? "·" : <IconArrowRight style={{ width: 18, height: 18 }} />}</span>
          </button>
        </div>
        <div className="auth-card-foot">
          Already have an account?{" "}
          <Link href="/login" style={{ color: "var(--ink)", fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 3 }}>
            Log in to your workspace
          </Link>
        </div>
      </div>
    </form>
  );
}
