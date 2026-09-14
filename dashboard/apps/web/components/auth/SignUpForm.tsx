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
    <form className="authf" onSubmit={onSubmit} noValidate>
      <div className="authf-head">
        <span className="authf-head-label">Create account</span>
        <Link className="authf-head-alt" href="/login">
          Have an account?
        </Link>
      </div>

      {error ? (
        <p className="authf-error" role="alert">
          {error}
        </p>
      ) : null}

      <label className="authf-field">
        <span className="authf-label">Full name</span>
        <input
          className="authf-input"
          type="text"
          autoComplete="name"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>

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
        <span className="authf-label">Create password</span>
        <input
          className="authf-input"
          type="password"
          autoComplete="new-password"
          placeholder="Minimum 8 characters"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>

      <label className="authf-check authf-check-terms">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} required />I agree to the{" "}
        <a className="authf-link" href="#">
          Terms of Use
        </a>{" "}
        and{" "}
        <a className="authf-link" href="#">
          Privacy Policy
        </a>
        .
      </label>

      <button className="authf-submit" type="submit" disabled={submitting}>
        {submitting ? "Provisioning…" : "Create operator account"}
        <span aria-hidden="true" className="authf-submit-arrow">
          {submitting ? "·" : <IconArrowRight style={{ width: 18, height: 18 }} />}
        </span>
      </button>
    </form>
  );
}
