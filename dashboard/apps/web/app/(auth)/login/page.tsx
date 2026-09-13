import type { Metadata } from "next";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata: Metadata = {
  title: "Log in — Swarm Command",
};

export default function LoginPage() {
  return (
    <AuthLayout view="login">
      <LoginForm />
    </AuthLayout>
  );
}
