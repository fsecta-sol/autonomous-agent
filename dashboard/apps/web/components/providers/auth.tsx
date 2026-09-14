"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export interface OperatorProfile {
  name: string;
  email: string;
  role: string;
}

/** Result of a login/signup attempt — carries the server's message on failure. */
export type AuthResult = { ok: true } | { ok: false; error: string };

interface AuthValue {
  /** false until the client has read the session */
  authed: boolean;
  /** true while the initial GET /api/auth/me is in flight */
  loading: boolean;
  profile: OperatorProfile | null;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (name: string, email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  /** local-only update; there is no profile-persistence endpoint yet */
  saveProfile: (profile: OperatorProfile) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

interface MeResponse {
  operator: OperatorProfile;
}

/** Read an `{ error }` message from a failed response, with a safe fallback. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === "string" ? data.error : fallback;
  } catch {
    return fallback;
  }
}

/** The server is the source of truth for who is signed in. */
async function loadOperator(): Promise<OperatorProfile | null> {
  const res = await fetch("/api/auth/me", { cache: "no-store" });
  if (!res.ok) return null;
  const data = (await res.json()) as MeResponse;
  return data.operator ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<OperatorProfile | null>(null);

  const refresh = useCallback(async () => {
    const operator = await loadOperator().catch(() => null);
    setProfile(operator);
    setAuthed(!!operator);
  }, []);

  useEffect(() => {
    let alive = true;
    loadOperator()
      .then((operator) => {
        if (!alive) return;
        setProfile(operator);
        setAuthed(!!operator);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setProfile(null);
        setAuthed(false);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const signIn = useCallback(
    async (email: string, password: string): Promise<AuthResult> => {
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) return { ok: false, error: await errorMessage(res, "Could not sign in.") };
        await refresh();
        return { ok: true };
      } catch {
        return { ok: false, error: "Network error — please try again." };
      }
    },
    [refresh],
  );

  const signUp = useCallback(
    async (name: string, email: string, password: string): Promise<AuthResult> => {
      try {
        const res = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, password }),
        });
        if (!res.ok) return { ok: false, error: await errorMessage(res, "Could not create the account.") };
        await refresh();
        return { ok: true };
      } catch {
        return { ok: false, error: "Network error — please try again." };
      }
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* the cookie is cleared server-side on the next request regardless */
    }
    setProfile(null);
    setAuthed(false);
    router.replace("/login");
  }, [router]);

  const saveProfile = useCallback((next: OperatorProfile) => {
    setProfile(next);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ authed, loading, profile, refresh, signIn, signUp, signOut, saveProfile }),
    [authed, loading, profile, refresh, signIn, signUp, signOut, saveProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
