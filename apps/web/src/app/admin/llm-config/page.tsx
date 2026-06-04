"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Field, FormCard, Input, PrimaryButton, SecondaryButton, Select } from "@/components/ui/Form";

type Provider = "gemini" | "openai" | "anthropic";

interface ProviderInfo {
  id: Provider;
  label: string;
  default_model: string;
  default_api_base: string;
  env_fallback: boolean;
}

interface CurrentConfig {
  provider: Provider;
  chat_model: string;
  api_base: string | null;
  has_api_key: boolean;
  effectively_configured: boolean;
  updated_at: string;
  updated_by: string | null;
}

interface TestResult {
  ok: boolean;
  provider: Provider;
  model: string;
  reply?: string;
  error?: string;
}

// Sentinel that means "leave the saved key as-is" so an admin can edit just
// the model without retyping the key. Distinct from the empty string, which
// the API treats as "clear the saved key".
const KEY_UNCHANGED = "__unchanged__";

export default function LlmConfigPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [current, setCurrent] = useState<CurrentConfig | null>(null);
  const [provider, setProvider] = useState<Provider>("gemini");
  const [chatModel, setChatModel] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState(KEY_UNCHANGED);
  const [keyTouched, setKeyTouched] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  async function loadAll(): Promise<void> {
    const [p, c] = await Promise.all([
      api.get<{ providers: ProviderInfo[] }>("/admin/llm-config/providers"),
      api.get<CurrentConfig>("/admin/llm-config"),
    ]);
    setProviders(p.providers);
    setCurrent(c);
    setProvider(c.provider);
    setChatModel(c.chat_model);
    setApiBase(c.api_base ?? "");
    setApiKey(KEY_UNCHANGED);
    setKeyTouched(false);
  }

  useEffect(() => { void loadAll(); }, []);

  // When the admin switches provider, default the model + base URL to that
  // provider's canonical values — but only if the admin hasn't already typed
  // something custom for the *current* selection. (Switching always clears
  // the key field too — keys are scoped to the provider.)
  function changeProvider(next: Provider): void {
    const info = providers.find((p) => p.id === next);
    setProvider(next);
    if (info) {
      setChatModel(info.default_model);
      setApiBase(info.default_api_base);
    }
    setApiKey(""); // require re-entering for the new provider
    setKeyTouched(true);
    setSaveOk(false);
    setTestResult(null);
  }

  async function save(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const body: Record<string, unknown> = {
        provider,
        chat_model: chatModel,
        api_base: apiBase || null,
      };
      if (keyTouched) body.api_key = apiKey === KEY_UNCHANGED ? null : apiKey;
      const c = await api.put<CurrentConfig>("/admin/llm-config", body);
      setCurrent(c);
      setApiKey(KEY_UNCHANGED);
      setKeyTouched(false);
      setSaveOk(true);
    } catch (err) {
      const e = err as { body?: { error?: string; message?: string }; status?: number };
      setSaveError(e.body?.message ?? e.body?.error ?? `save_failed (${e.status ?? "?"})`);
    } finally {
      setSaving(false);
    }
  }

  // Test sends whatever's currently in the form — saved or unsaved. A null
  // api_key means "use the saved key". An explicit api_key (even empty)
  // overrides for the test only.
  async function testNow(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = {
        provider,
        chat_model: chatModel,
      };
      if (apiBase) body.api_base = apiBase;
      if (keyTouched && apiKey !== KEY_UNCHANGED) body.api_key = apiKey;
      const r = await api.post<TestResult>("/admin/llm-config/test", body);
      setTestResult(r);
    } catch (err) {
      const e = err as { body?: TestResult };
      setTestResult(e.body ?? { ok: false, provider, model: chatModel, error: "request_failed" });
    } finally {
      setTesting(false);
    }
  }

  const activeProvider = providers.find((p) => p.id === provider);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-100">LLM configuration</h1>
        <p className="mt-1 text-sm text-ink-400">
          Choose which large-language-model provider powers chat answers. Changes apply immediately
          (no service restart). Embeddings for the knowledge base remain on Gemini regardless of this
          setting (see <span className="text-ink-300">migration 002</span>).
        </p>
      </div>

      {current && (
        <div className="rounded-md border border-ink-800 bg-ink-900/50 px-4 py-3 text-xs">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-ink-400">Currently active:</span>{" "}
              <span className="text-ink-100">{current.provider}</span>
              <span className="text-ink-500"> · </span>
              <span className="text-ink-100">{current.chat_model}</span>
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
            {current.has_api_key ? " · key stored encrypted" : current.provider === "gemini" ? " · falling back to GEMINI_API_KEY env var" : " · no key set"}
          </div>
        </div>
      )}

      <form onSubmit={save}>
        <FormCard
          title="Provider settings"
          description="Pick a provider and tune the chat model. The API key is encrypted at rest with the same KEK as SSH credentials."
          footer={
            <div className="flex items-center gap-3">
              {saveError && <span className="text-xs font-medium text-danger-500">{saveError}</span>}
              {saveOk && <span className="text-xs font-medium text-emerald-400">Saved.</span>}
              <SecondaryButton type="button" onClick={() => void testNow()} disabled={testing} className="ml-auto">
                {testing ? "Testing…" : "Test connection"}
              </SecondaryButton>
              <PrimaryButton type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </PrimaryButton>
            </div>
          }
        >
          <Field label="Provider" required>
            <Select value={provider} onChange={(e) => changeProvider(e.target.value as Provider)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </Select>
          </Field>

          <Field
            label="Chat model"
            required
            hint={
              activeProvider
                ? `Provider default: ${activeProvider.default_model}. You can specify any model your account has access to (e.g. ${exampleModels(provider).join(", ")}).`
                : undefined
            }
          >
            <Input value={chatModel} onChange={(e) => setChatModel(e.target.value)} required />
          </Field>

          <Field
            label="API key"
            required={provider !== "gemini"}
            hint={
              provider === "gemini" && !keyTouched
                ? "Optional. If left as “unchanged” and no key was previously stored, the GEMINI_API_KEY env var is used."
                : keyTouched && apiKey === ""
                ? "Saving with an empty key will clear the stored value."
                : "Stored encrypted with AES-256-GCM."
            }
          >
            <div className="flex gap-2">
              <Input
                type="password"
                value={apiKey === KEY_UNCHANGED ? "" : apiKey}
                placeholder={current?.has_api_key && !keyTouched ? "•••••••••••••••• (saved)" : provider === "gemini" ? "(leave blank to use env var)" : "Paste API key"}
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
            hint={`Optional override. Default: ${activeProvider?.default_api_base ?? ""}`}
          >
            <Input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder={activeProvider?.default_api_base ?? ""} />
          </Field>
        </FormCard>
      </form>

      {testResult && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            testResult.ok
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-danger-500/40 bg-danger-500/10 text-danger-500"
          }`}
        >
          <div className="font-medium">
            {testResult.ok ? "✓ Test passed" : "✗ Test failed"} — {testResult.provider} · {testResult.model}
          </div>
          {testResult.ok && testResult.reply && (
            <div className="mt-1 text-xs text-emerald-300">Model replied: <code className="text-emerald-100">{testResult.reply}</code></div>
          )}
          {!testResult.ok && testResult.error && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs text-danger-500">{testResult.error}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function exampleModels(p: Provider): string[] {
  if (p === "openai") return ["gpt-5.4", "gpt-5.4-mini", "gpt-4o-mini"];
  if (p === "anthropic") return ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"];
  return ["gemini-3-pro-preview", "gemini-2.5-flash"];
}
