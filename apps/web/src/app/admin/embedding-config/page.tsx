"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Field, FormCard, Input, PrimaryButton, SecondaryButton } from "@/components/ui/Form";

interface CurrentConfig {
  provider: string;
  embedding_model: string;
  api_base: string | null;
  has_api_key: boolean;
  dimension: number;
  expected_dimension: number;
  default_model: string;
  default_api_base: string;
  effectively_configured: boolean;
  updated_at: string;
  updated_by: string | null;
}

interface TestResult {
  ok: boolean;
  model: string;
  dimension?: number;
  expected_dimension: number;
  dimension_ok?: boolean;
  error?: string;
}

// Sentinel meaning "leave the saved key as-is" so an admin can edit just the
// model without retyping the key. Distinct from "" (clear the saved key).
const KEY_UNCHANGED = "__unchanged__";

export default function EmbeddingConfigPage() {
  const [current, setCurrent] = useState<CurrentConfig | null>(null);
  const [model, setModel] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState(KEY_UNCHANGED);
  const [keyTouched, setKeyTouched] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  async function load(): Promise<void> {
    const c = await api.get<CurrentConfig>("/admin/embedding-config");
    setCurrent(c);
    setModel(c.embedding_model);
    setApiBase(c.api_base ?? "");
    setApiKey(KEY_UNCHANGED);
    setKeyTouched(false);
  }

  useEffect(() => { void load(); }, []);

  async function save(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const body: Record<string, unknown> = {
        embedding_model: model,
        api_base: apiBase || null,
      };
      if (keyTouched) body.api_key = apiKey === KEY_UNCHANGED ? null : apiKey;
      const c = await api.put<CurrentConfig>("/admin/embedding-config", body);
      setCurrent((prev) => ({ ...(prev as CurrentConfig), ...c }));
      setApiKey(KEY_UNCHANGED);
      setKeyTouched(false);
      setSaveOk(true);
      void load();
    } catch (err) {
      const e = err as { body?: { error?: string; message?: string }; status?: number };
      setSaveError(e.body?.message ?? e.body?.error ?? `save_failed (${e.status ?? "?"})`);
    } finally {
      setSaving(false);
    }
  }

  // Test the current form values (saved or unsaved). An explicit api_key
  // overrides the saved key for this test only; otherwise the saved/env key is used.
  async function testNow(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = { embedding_model: model };
      if (apiBase) body.api_base = apiBase;
      if (keyTouched && apiKey !== KEY_UNCHANGED) body.api_key = apiKey;
      const r = await api.post<TestResult>("/admin/embedding-config/test", body);
      setTestResult(r);
    } catch (err) {
      const e = err as { body?: TestResult };
      setTestResult(
        e.body ?? { ok: false, model, expected_dimension: current?.expected_dimension ?? 3072, error: "request_failed" }
      );
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-100">Embedding configuration</h1>
        <p className="mt-1 text-sm text-ink-400">
          The model used to vectorize knowledge-base documents and chat queries for RAG retrieval.
          Provider is locked to <span className="text-ink-300">Google Gemini</span> because the vector
          column is fixed at {current?.expected_dimension ?? 3072} dimensions — a model with a different
          output size cannot be stored without a reindex. Changes apply within ~30s to the ingestion
          worker (no restart). Re-index existing documents to refresh their vectors after changing the model.
        </p>
      </div>

      {current && (
        <div className="rounded-md border border-ink-800 bg-ink-900/50 px-4 py-3 text-xs">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-ink-400">Currently active:</span>{" "}
              <span className="text-ink-100">{current.provider}</span>
              <span className="text-ink-500"> · </span>
              <span className="text-ink-100">{current.embedding_model}</span>
              <span className="text-ink-500"> · </span>
              <span className="text-ink-100">{current.dimension}d</span>
            </div>
            {current.effectively_configured ? (
              <span className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded border border-warn-500/40 bg-warn-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warn-500">
                <span className="h-1.5 w-1.5 rounded-full bg-warn-500" /> No API key
              </span>
            )}
          </div>
          <div className="mt-1 text-ink-500">
            Last updated {new Date(current.updated_at).toLocaleString()}
            {current.has_api_key ? " · key stored encrypted" : " · falling back to GEMINI_API_KEY env var"}
          </div>
        </div>
      )}

      <form onSubmit={save}>
        <FormCard
          title="Embedding settings"
          description="Tune the Gemini embedding model and key. The API key is encrypted at rest with the same KEK as SSH credentials and the chat key."
          footer={
            <div className="flex items-center gap-3">
              {saveError && <span className="text-xs font-medium text-danger-500">{saveError}</span>}
              {saveOk && <span className="text-xs font-medium text-emerald-400">Saved.</span>}
              <SecondaryButton type="button" onClick={() => void testNow()} disabled={testing} className="ml-auto">
                {testing ? "Testing…" : "Test embedding"}
              </SecondaryButton>
              <PrimaryButton type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </PrimaryButton>
            </div>
          }
        >
          <Field
            label="Embedding model"
            required
            hint={`Provider default: ${current?.default_model ?? "gemini-embedding-001"}. Must output ${current?.expected_dimension ?? 3072}-dimension vectors (e.g. gemini-embedding-001).`}
          >
            <Input value={model} onChange={(e) => setModel(e.target.value)} required />
          </Field>

          <Field
            label="API key"
            hint={
              !keyTouched
                ? "Optional. If left unchanged and no key is stored, the GEMINI_API_KEY env var is used."
                : apiKey === ""
                ? "Saving with an empty key will clear the stored value and fall back to the env var."
                : "Stored encrypted with AES-256-GCM."
            }
          >
            <div className="flex gap-2">
              <Input
                type="password"
                value={apiKey === KEY_UNCHANGED ? "" : apiKey}
                placeholder={current?.has_api_key && !keyTouched ? "•••••••••••••••• (saved)" : "(leave blank to use env var)"}
                onChange={(e) => { setKeyTouched(true); setApiKey(e.target.value); }}
                autoComplete="off"
                className="flex-1"
              />
              {keyTouched && (
                <SecondaryButton
                  type="button"
                  onClick={() => { setApiKey(KEY_UNCHANGED); setKeyTouched(false); }}
                  className="px-3"
                  title="Restore saved key"
                >
                  Reset
                </SecondaryButton>
              )}
            </div>
          </Field>

          <Field
            label="API base URL"
            hint={`Optional override. Default: ${current?.default_api_base ?? "https://generativelanguage.googleapis.com/v1beta"}`}
          >
            <Input
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              placeholder={current?.default_api_base ?? "https://generativelanguage.googleapis.com/v1beta"}
            />
          </Field>
        </FormCard>
      </form>

      {testResult && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            testResult.ok && testResult.dimension_ok !== false
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : testResult.ok
              ? "border-warn-500/40 bg-warn-500/10 text-warn-500"
              : "border-danger-500/40 bg-danger-500/10 text-danger-500"
          }`}
        >
          <div className="font-medium">
            {testResult.ok
              ? testResult.dimension_ok === false
                ? "⚠ Test reachable, but dimension mismatch"
                : "✓ Test passed"
              : "✗ Test failed"}{" "}
            — {testResult.model}
          </div>
          {testResult.ok && (
            <div className="mt-1 text-xs">
              Returned <code>{testResult.dimension}</code>-dimension vectors
              {testResult.dimension_ok === false && (
                <>
                  {" "}
                  but the store expects <code>{testResult.expected_dimension}</code>. Saving this model
                  would cause ingestion inserts to fail — pick a {testResult.expected_dimension}-dim model.
                </>
              )}
              {testResult.dimension_ok && " — matches the vector store."}
            </div>
          )}
          {!testResult.ok && testResult.error && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs text-danger-500">{testResult.error}</pre>
          )}
        </div>
      )}
    </div>
  );
}
