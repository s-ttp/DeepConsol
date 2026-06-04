"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Field, FormCard, Input, PrimaryButton, SecondaryButton, Select, Textarea } from "@/components/ui/Form";

interface BuiltinRule {
  name: string;
  category: "strip" | "pseudonymize";
  description: string;
  enabled: boolean;
}

interface CustomRule {
  id: string;
  label: string;
  match_type: "literal" | "wildcard";
  value: string;
  action: "redact" | "pseudonymize";
  alias_prefix: string | null;
  case_insensitive: boolean;
  enabled: boolean;
}

type Draft = Omit<CustomRule, "id">;

const EMPTY_DRAFT: Draft = {
  label: "",
  match_type: "literal",
  value: "",
  action: "redact",
  alias_prefix: "",
  case_insensitive: true,
  enabled: true,
};

export default function SanitizerPage() {
  const [builtins, setBuiltins] = useState<BuiltinRule[]>([]);
  const [custom, setCustom] = useState<CustomRule[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  function showFlash(msg: string): void {
    setFlash(msg);
    setTimeout(() => setFlash((cur) => (cur === msg ? null : cur)), 2000);
  }

  const [sample, setSample] = useState("Customer Acme Corp · IMSI 310150123456789 · ki: 00112233445566778899AABBCCDDEEFF · admin@acme.com");
  const [testOut, setTestOut] = useState<{ sanitized: string; redactions: number; pseudonymizations: number } | null>(null);

  async function load(): Promise<void> {
    const r = await api.get<{ builtins: BuiltinRule[]; custom: CustomRule[] }>("/admin/sanitizer");
    setBuiltins(r.builtins);
    setCustom(r.custom);
  }
  useEffect(() => { void load(); }, []);

  async function toggleBuiltin(rule: BuiltinRule): Promise<void> {
    setBusy(rule.name);
    try {
      await api.put(`/admin/sanitizer/builtins/${encodeURIComponent(rule.name)}`, { enabled: !rule.enabled });
      setBuiltins((prev) => prev.map((b) => (b.name === rule.name ? { ...b, enabled: !b.enabled } : b)));
      showFlash(`${rule.name} ${rule.enabled ? "disabled" : "enabled"} · saved`);
    } finally {
      setBusy(null);
    }
  }

  function startAdd(): void {
    setEditingId("new");
    setDraft(EMPTY_DRAFT);
    setDraftError(null);
  }
  function startEdit(rule: CustomRule): void {
    setEditingId(rule.id);
    setDraft({ ...rule, alias_prefix: rule.alias_prefix ?? "" });
    setDraftError(null);
  }
  function cancelEdit(): void {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setDraftError(null);
  }

  async function saveDraft(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setDraftError(null);
    const body = {
      label: draft.label.trim(),
      match_type: draft.match_type,
      value: draft.value,
      action: draft.action,
      alias_prefix: draft.action === "pseudonymize" ? (draft.alias_prefix || null) : null,
      case_insensitive: draft.case_insensitive,
      enabled: draft.enabled,
    };
    if (!body.label || !body.value) { setDraftError("Label and value are required."); return; }
    try {
      if (editingId === "new") await api.post("/admin/sanitizer/custom", body);
      else await api.patch(`/admin/sanitizer/custom/${editingId}`, body);
      cancelEdit();
      await load();
    } catch (err) {
      const e = err as { body?: { error?: string; message?: string } };
      setDraftError(e.body?.message ?? e.body?.error ?? "save_failed");
    }
  }

  async function removeRule(id: string): Promise<void> {
    if (!confirm("Delete this custom filter?")) return;
    await api.del(`/admin/sanitizer/custom/${id}`);
    setCustom((prev) => prev.filter((c) => c.id !== id));
  }

  async function runTest(): Promise<void> {
    const r = await api.post<{ sanitized: string; redactions: number; pseudonymizations: number }>(
      "/admin/sanitizer/test",
      { sample }
    );
    setTestOut(r);
  }

  const strip = builtins.filter((b) => b.category === "strip");
  const pseudo = builtins.filter((b) => b.category === "pseudonymize");

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-ink-100">Sanitization filters</h1>
          {flash && (
            <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
              {flash}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-ink-400">
          These filters mask secrets and pseudonymize identifiers before any text reaches the AI — on the
          client before it enters the chat, and again on the server. Built-in rules can be turned off but
          not rewritten; add custom rules for org-specific values (customer names, account prefixes).
          <span className="text-ink-300"> Each toggle saves immediately — there is no separate apply step.</span>{" "}
          Open chat sessions pick up the change on their next focus (server-side within ~30s).{" "}
          <span className="text-warn-500">Disabling a rule reduces leak protection</span> and is audit-logged.
        </p>
      </div>

      {/* Built-in rules */}
      <FormCard title="Built-in rules" description="Toggle individual baseline protections. Patterns are locked to prevent accidental weakening.">
        <div className="space-y-4">
          {[{ label: "Redaction (removed)", rules: strip }, { label: "Pseudonymization (aliased)", rules: pseudo }].map((group) => (
            <div key={group.label}>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{group.label}</div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {group.rules.map((rule) => (
                  <label
                    key={rule.name}
                    className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-xs ${
                      rule.enabled ? "border-ink-800 bg-ink-900/40" : "border-warn-500/40 bg-warn-500/5"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      disabled={busy === rule.name}
                      onChange={() => void toggleBuiltin(rule)}
                      className="mt-0.5 h-3.5 w-3.5 accent-brand-purple"
                    />
                    <span>
                      <span className="font-medium text-ink-200">{rule.name}</span>
                      <span className="block text-ink-500">{rule.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </FormCard>

      {/* Custom rules */}
      <FormCard
        title="Custom filters"
        description="Org-specific values to redact or alias. Guided patterns only — literal text or simple wildcards (* = any run of non-space chars, ? = one char). No regex, so no risk of catastrophic patterns."
        footer={
          editingId == null ? (
            <PrimaryButton type="button" onClick={startAdd} className="ml-auto">+ Add filter</PrimaryButton>
          ) : undefined
        }
      >
        <div className="space-y-2">
          {custom.length === 0 && editingId == null && (
            <p className="text-xs text-ink-500">No custom filters yet.</p>
          )}
          {custom.map((rule) =>
            editingId === rule.id ? (
              <CustomForm key={rule.id} draft={draft} setDraft={setDraft} onSubmit={saveDraft} onCancel={cancelEdit} error={draftError} />
            ) : (
              <div key={rule.id} className="flex items-center gap-3 rounded-md border border-ink-800 bg-ink-900/40 px-3 py-2 text-xs">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${rule.enabled ? "bg-emerald-400" : "bg-ink-600"}`} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-ink-200">{rule.label}</span>
                  <span className="text-ink-500"> · {rule.action === "redact" ? "redact" : `alias→${rule.alias_prefix || "CUSTOM"}`} · {rule.match_type}</span>
                  <code className="ml-2 break-all text-ink-400">{rule.value}</code>
                </span>
                <button onClick={() => startEdit(rule)} className="text-ink-300 hover:text-ink-100">Edit</button>
                <button onClick={() => void removeRule(rule.id)} className="text-danger-500 hover:text-danger-400">Delete</button>
              </div>
            )
          )}
          {editingId === "new" && (
            <CustomForm draft={draft} setDraft={setDraft} onSubmit={saveDraft} onCancel={cancelEdit} error={draftError} />
          )}
        </div>
      </FormCard>

      {/* Test */}
      <FormCard
        title="Test filters"
        description="Run the current effective ruleset against a sample to preview what gets masked."
        footer={
          <div className="flex items-center gap-3">
            {testOut && (
              <span className="text-xs text-ink-400">{testOut.redactions} redactions · {testOut.pseudonymizations} pseudonymizations</span>
            )}
            <SecondaryButton type="button" onClick={() => void runTest()} className="ml-auto">Run test</SecondaryButton>
          </div>
        }
      >
        <Field label="Sample text">
          <Textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={3} className="text-xs" />
        </Field>
        {testOut && (
          <Field label="Sanitized output">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-emerald-200">{testOut.sanitized}</pre>
          </Field>
        )}
      </FormCard>
    </div>
  );
}

function CustomForm({
  draft,
  setDraft,
  onSubmit,
  onCancel,
  error,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
  error: string | null;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-brand-purple/30 bg-brand-purple/5 px-3 py-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Label" required>
          <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="e.g. Customer name" required />
        </Field>
        <Field label="Action" required>
          <Select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value as Draft["action"] })}>
            <option value="redact">Redact (remove)</option>
            <option value="pseudonymize">Pseudonymize (alias)</option>
          </Select>
        </Field>
        <Field label="Match type" required>
          <Select value={draft.match_type} onChange={(e) => setDraft({ ...draft, match_type: e.target.value as Draft["match_type"] })}>
            <option value="literal">Literal text</option>
            <option value="wildcard">Wildcard (* ?)</option>
          </Select>
        </Field>
        <Field label="Value" required hint={draft.match_type === "wildcard" ? "* = any non-space run, ? = one char" : undefined}>
          <Input value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} placeholder={draft.match_type === "wildcard" ? "ACC-*" : "Acme Corp"} required />
        </Field>
        {draft.action === "pseudonymize" && (
          <Field label="Alias prefix" hint="e.g. ACCT → ACCT_001. Defaults to the label.">
            <Input value={draft.alias_prefix ?? ""} onChange={(e) => setDraft({ ...draft, alias_prefix: e.target.value })} placeholder="ACCT" />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs text-ink-300">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.case_insensitive} onChange={(e) => setDraft({ ...draft, case_insensitive: e.target.checked })} className="h-3.5 w-3.5 accent-brand-purple" />
          Case-insensitive
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} className="h-3.5 w-3.5 accent-brand-purple" />
          Enabled
        </label>
        {error && <span className="font-medium text-danger-500">{error}</span>}
        <div className="ml-auto flex gap-2">
          <SecondaryButton type="button" onClick={onCancel}>Cancel</SecondaryButton>
          <PrimaryButton type="submit">Save filter</PrimaryButton>
        </div>
      </div>
    </form>
  );
}
