"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Field, FormCard, Input, PrimaryButton, SecondaryButton, Select } from "@/components/ui/Form";

interface User {
  id: string;
  email: string;
  role: "engineer" | "admin";
  must_rotate_password: boolean;
  created_at: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"engineer" | "admin">("engineer");
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setUsers(await api.get<User[]>("/admin/users"));
  }
  useEffect(() => { void refresh(); }, []);

  async function create(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setError(null);
    try {
      await api.post("/admin/users", {
        email,
        password,
        role,
        must_rotate_password: true,
      });
      setEmail(""); setPassword("");
      await refresh();
    } catch (err) {
      const e = err as { body: { error?: string } };
      setError(e.body?.error ?? "create_failed");
    }
  }

  async function setRoleFor(id: string, newRole: User["role"]): Promise<void> {
    await api.patch(`/admin/users/${id}`, { role: newRole });
    await refresh();
  }

  async function forceRotate(id: string): Promise<void> {
    await api.patch(`/admin/users/${id}`, { must_rotate_password: true });
    await refresh();
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <section>
        <h2 className="mb-4 text-base font-semibold text-ink-100">Users</h2>
        <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
          <table className="w-full text-sm">
            <thead className="bg-ink-900 text-[11px] uppercase tracking-wider text-ink-400">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Email</th>
                <th className="px-4 py-2.5 text-left font-medium">Role</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-ink-800 text-ink-100">
                  <td className="px-4 py-2.5">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <select
                      value={u.role}
                      onChange={(e) => void setRoleFor(u.id, e.target.value as User["role"])}
                      className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-100 outline-none focus:border-brand-purple focus:ring-1 focus:ring-brand-purple/40 transition-colors"
                    >
                      <option value="engineer">engineer</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-2.5">
                    {u.must_rotate_password ? (
                      <span className="inline-flex items-center rounded border border-warn-500/40 bg-warn-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warn-500">rotation pending</span>
                    ) : (
                      <span className="inline-flex items-center rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">active</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <SecondaryButton onClick={() => void forceRotate(u.id)} className="px-3 py-1 text-xs">
                      Force rotate
                    </SecondaryButton>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-xs text-ink-500">No users yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-base font-semibold text-ink-100">Create user</h2>
        <form onSubmit={create}>
          <FormCard
            description="The user will be required to set their own password on first login."
            footer={
              <div className="flex items-center justify-between gap-3">
                {error && <span className="text-xs font-medium text-danger-500">{error}</span>}
                <PrimaryButton type="submit" className="ml-auto">Create user</PrimaryButton>
              </div>
            }
          >
            <Field label="Email" required>
              <Input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                required autoComplete="off" placeholder="user@example.com"
              />
            </Field>
            <Field label="Initial password" required hint="Minimum 10 characters. The user must change this on first sign-in.">
              <Input
                type="text" value={password} onChange={(e) => setPassword(e.target.value)}
                required minLength={10} autoComplete="new-password"
              />
            </Field>
            <Field label="Role" required>
              <Select value={role} onChange={(e) => setRole(e.target.value as User["role"])}>
                <option value="engineer">Engineer</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
          </FormCard>
        </form>
      </section>
    </div>
  );
}
