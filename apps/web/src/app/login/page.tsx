"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Field, Input, PrimaryButton } from "@/components/ui/Form";

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ user: { must_rotate_password: boolean } }>("/auth/login", {
        email,
        password,
      });
      await refresh();
      router.replace(result.user.must_rotate_password ? "/rotate-password" : "/workspace");
    } catch (err) {
      const e = err as ApiError;
      const code = (e.body as { error?: string } | null)?.error;
      setError(code === "invalid_credentials" ? "Invalid email or password" : `Login failed (${e.status})`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-ink-950 px-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg border border-ink-800 bg-ink-900 p-7 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink-100">
            <span className="text-brand-green">Deep</span>Consol
          </h1>
          <p className="mt-1 text-xs text-ink-400">Sign in to your secure workspace</p>
        </div>
        <div className="space-y-4">
          <Field label="Email" required>
            <Input
              type="email" required autoComplete="username"
              value={email} onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" required>
            <Input
              type="password" required autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        {error && <div className="mt-4 rounded-md border border-danger-500/40 bg-danger-500/10 px-3 py-2 text-center text-xs font-medium text-danger-500">{error}</div>}
        <PrimaryButton type="submit" disabled={busy} className="mt-6 w-full justify-center py-2.5">
          {busy ? "Signing in…" : "Sign in"}
        </PrimaryButton>
      </form>
    </main>
  );
}
