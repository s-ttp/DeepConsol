"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { DangerButton, Field, FormCard, Input, PrimaryButton, Select } from "@/components/ui/Form";

interface Group { id: string; name: string; description: string | null; member_count: number; }
interface Member { id: string; email: string; role: string; role_in_group: string; }
interface User { id: string; email: string; }

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [addUserId, setAddUserId] = useState("");

  async function refresh(): Promise<void> {
    const [g, u] = await Promise.all([
      api.get<Group[]>("/admin/groups"),
      api.get<User[]>("/admin/users"),
    ]);
    setGroups(g);
    setUsers(u);
    if (!active && g[0]) setActive(g[0].id);
  }
  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!active) { setMembers([]); return; }
    void api.get<Member[]>(`/admin/groups/${active}/members`).then(setMembers);
  }, [active]);

  async function createGroup(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    if (!name.trim()) return;
    await api.post("/admin/groups", { name, description: description || undefined });
    setName(""); setDescription("");
    await refresh();
  }

  async function addMember(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    if (!active || !addUserId) return;
    await api.post(`/admin/groups/${active}/members`, { user_id: addUserId });
    setAddUserId("");
    setMembers(await api.get(`/admin/groups/${active}/members`));
    await refresh();
  }

  async function removeMember(userId: string): Promise<void> {
    if (!active) return;
    await api.del(`/admin/groups/${active}/members/${userId}`);
    setMembers(await api.get(`/admin/groups/${active}/members`));
    await refresh();
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <section>
        <h2 className="mb-4 text-base font-semibold text-ink-100">Groups</h2>
        <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
          {groups.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-500">No groups yet.</p>
          ) : (
            <ul>
              {groups.map((g) => (
                <li key={g.id}>
                  <button
                    onClick={() => setActive(g.id)}
                    className={`flex w-full items-center justify-between border-b border-ink-800 px-4 py-2.5 text-left text-sm transition-colors last:border-b-0 ${
                      active === g.id
                        ? "bg-brand-purple/10 text-brand-purple"
                        : "text-ink-200 hover:bg-ink-900"
                    }`}
                  >
                    <span>{g.name}</span>
                    <span className="text-xs text-ink-500">{g.member_count} members</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form onSubmit={createGroup} className="mt-6">
          <FormCard title="Create group" footer={<div className="text-right"><PrimaryButton type="submit">Create</PrimaryButton></div>}>
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="Description" hint="Optional. Visible to admins only.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </FormCard>
        </form>
      </section>

      <section>
        <h2 className="mb-4 text-base font-semibold text-ink-100">Members</h2>
        {!active ? (
          <p className="text-sm text-ink-500">Select a group.</p>
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
              {members.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-ink-500">No members.</p>
              ) : (
                <ul>
                  {members.map((m) => (
                    <li key={m.id} className="flex items-center justify-between border-b border-ink-800 px-4 py-2.5 text-sm last:border-b-0">
                      <span className="text-ink-100">{m.email}</span>
                      <DangerButton onClick={() => void removeMember(m.id)} className="px-3 py-1 text-xs">Remove</DangerButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <form onSubmit={addMember} className="mt-6">
              <FormCard
                title="Add member"
                footer={<div className="text-right"><PrimaryButton type="submit" disabled={!addUserId}>Add</PrimaryButton></div>}
              >
                <Field label="User">
                  <Select value={addUserId} onChange={(e) => setAddUserId(e.target.value)}>
                    <option value="">— select user —</option>
                    {users
                      .filter((u) => !members.some((m) => m.id === u.id))
                      .map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
                  </Select>
                </Field>
              </FormCard>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
