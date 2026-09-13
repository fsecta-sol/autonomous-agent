import type { Metadata } from "next";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { SignUpForm } from "@/components/auth/SignUpForm";

export const metadata: Metadata = {
  title: "Create account — Swarm Command",
};

export default function SignUpPage() {
  return (
    <AuthLayout view="signup">
      <SignUpForm />
    </AuthLayout>
  );
}
