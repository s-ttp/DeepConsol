"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Field, Input, PrimaryButton } from "@/components/ui/Form";

export default function RotatePasswordPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (next !== confirm) {
      setError("New passwords do not match");
      return;
    }
    if (next.length < 10) {
      setError("New password must be at least 10 characters");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/rotate-password", { current_password: current, new_password: next });
      await refresh();
      router.replace("/workspace");
    } catch (err) {
      const e = err as ApiError;
      const code = (e.body as { error?: string } | null)?.error;
      setError(code === "invalid_current_password" ? "Current password is incorrect" : `Failed (${e.status})`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-ink-950 px-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg border border-ink-800 bg-ink-900 p-7 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-ink-100">Rotate password</h1>
          <p className="mt-1 text-xs text-ink-400">You must change your password before continuing.</p>
        </div>
        <div className="space-y-4">
          <Field label="Current password" required>
            <Input
              type="password" required autoComplete="current-password"
              value={current} onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="New password" hint="Minimum 10 characters." required>
            <Input
              type="password" required autoComplete="new-password" minLength={10}
              value={next} onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password" required>
            <Input
              type="password" required autoComplete="new-password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        </div>
        {error && <div className="mt-4 rounded-md border border-danger-500/40 bg-danger-500/10 px-3 py-2 text-center text-xs font-medium text-danger-500">{error}</div>}
        <PrimaryButton type="submit" disabled={busy} className="mt-6 w-full justify-center py-2.5">
          {busy ? "Updating…" : "Update password"}
        </PrimaryButton>
      </form>
    </main>
  );
}
