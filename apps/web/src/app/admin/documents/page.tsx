"use client";

import { FormEvent, useEffect, useState } from "react";
import { api, uploadFile } from "@/lib/api";
import { DangerButton, Field, FormCard, Input, PrimaryButton, SecondaryButton, Select } from "@/components/ui/Form";

interface Document {
  id: string;
  filename: string;
  mime: string;
  visibility: "private" | "group" | "global";
  vendor: string | null;
  domain: string | null;
  product: string | null;
  version: string | null;
  document_type: string | null;
  status: string;
  error_message: string | null;
  byte_size: number;
  created_at: string;
}

interface Group {
  id: string;
  name: string;
}

const VISIBILITIES = ["private", "group", "global"] as const;

export default function DocumentsPage() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ document_id: string; filename: string; source_pointer: string; score: number; text: string }> | null>(null);

  // Upload form state
  const [file, setFile] = useState<File | null>(null);
  const [vendor, setVendor] = useState("");
  const [domain, setDomain] = useState("");
  const [product, setProduct] = useState("");
  const [version, setVersion] = useState("");
  const [docType, setDocType] = useState("");
  const [visibility, setVisibility] = useState<typeof VISIBILITIES[number]>("private");
  const [groupIds, setGroupIds] = useState<string[]>([]);

  async function refresh(): Promise<void> {
    const [d, g] = await Promise.all([
      api.get<Document[]>("/knowledge/documents"),
      api.get<Group[]>("/admin/groups"),
    ]);
    setDocs(d);
    setGroups(g);
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const t = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(t);
  }, []);

  async function upload(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    if (!file) return;
    setBusy(true); setError(null);
    try {
      await uploadFile<{ id: string }>("/knowledge/documents/upload", file, {
        visibility,
        group_ids: visibility === "group" ? groupIds : [],
        vendor, domain, product, version, document_type: docType,
      });
      setFile(null);
      await refresh();
    } catch (err) {
      const e = err as { body: { error?: string } };
      setError(e.body?.error ?? "upload_failed");
    } finally {
      setBusy(false);
    }
  }

  async function reindex(id: string): Promise<void> {
    await api.post(`/knowledge/documents/${id}/reindex`);
    await refresh();
  }
  async function remove(id: string): Promise<void> {
    if (!confirm("Delete this document and its chunks?")) return;
    await api.del(`/knowledge/documents/${id}`);
    await refresh();
  }
  async function changeVisibility(id: string, v: typeof VISIBILITIES[number], gids: string[]): Promise<void> {
    await api.patch(`/knowledge/documents/${id}`, { visibility: v, group_ids: v === "group" ? gids : [] });
    await refresh();
  }

  async function testSearch(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    if (!searchQ.trim()) return;
    const r = await api.post<{ results: typeof searchResults }>("/knowledge/test-search", { q: searchQ });
    setSearchResults(r.results);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-ink-100">Knowledge documents</h1>

      <form onSubmit={upload}>
        <FormCard
          title="Upload document"
          description="Supported formats: PDF, DOCX, PPTX, XLSX, CSV, TXT, HTML, Markdown."
          footer={
            <div className="flex items-center justify-between gap-3">
              {error && <span className="text-xs font-medium text-danger-500">{error}</span>}
              <PrimaryButton type="submit" disabled={busy || !file} className="ml-auto">
                {busy ? "Uploading…" : "Upload & queue ingestion"}
              </PrimaryButton>
            </div>
          }
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="File" required className="md:col-span-2">
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.html,.htm,.log,.md"
                className="w-full cursor-pointer rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-200 file:mr-3 file:rounded-sm file:border-0 file:bg-ink-800 file:px-3 file:py-1 file:text-xs file:font-medium file:text-ink-200 hover:file:bg-ink-700"
                required
              />
            </Field>
            <Field label="Vendor" hint="Cisco / Nokia / Ericsson / Huawei / Mavenir">
              <Input value={vendor} onChange={(e) => setVendor(e.target.value)} />
            </Field>
            <Field label="Domain" hint="RAN / Core / Transport / NOC">
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} />
            </Field>
            <Field label="Product" hint="MME / vEPC / PCRF / 5GC">
              <Input value={product} onChange={(e) => setProduct(e.target.value)} />
            </Field>
            <Field label="Version" hint="e.g. R20.5">
              <Input value={version} onChange={(e) => setVersion(e.target.value)} />
            </Field>
            <Field label="Document type" hint="Manual / MOP / Release notes" className="md:col-span-2">
              <Input value={docType} onChange={(e) => setDocType(e.target.value)} />
            </Field>
            <Field label="Visibility" required>
              <Select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as typeof VISIBILITIES[number])}
              >
                {VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </Field>
            {visibility === "group" && (
              <Field label="Allowed groups" hint="Hold Ctrl/Cmd to select multiple" className="md:col-span-2">
                <select
                  multiple
                  value={groupIds}
                  onChange={(e) => setGroupIds(Array.from(e.target.selectedOptions).map((o) => o.value))}
                  className="block min-h-[120px] w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 outline-none focus:border-brand-purple focus:ring-1 focus:ring-brand-purple/40 transition-colors"
                >
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </Field>
            )}
          </div>
        </FormCard>
      </form>

      <form onSubmit={testSearch}>
        <FormCard
          title="Test retrieval"
          description="Run a query against the knowledge base to preview what RAG would return."
        >
          <div className="flex gap-2">
            <Input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="Try a query against the KB"
              className="flex-1"
            />
            <PrimaryButton type="submit">Search</PrimaryButton>
          </div>
          {searchResults && (
            <ul className="mt-3 space-y-2 text-xs">
              {searchResults.length === 0 ? <li className="text-ink-400">No results.</li> : searchResults.map((r, i) => (
                <li key={i} className="rounded-md border border-ink-800 bg-ink-900 p-2">
                  <div className="text-ink-300">
                    {r.filename} <span className="text-ink-500">· {r.source_pointer}</span> <span className="text-ink-500">· score {r.score.toFixed(3)}</span>
                  </div>
                  <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-black/30 p-1.5 text-ink-200">{r.text}</pre>
                </li>
              ))}
            </ul>
          )}
        </FormCard>
      </form>

      <section>
        <h2 className="mb-3 text-base font-semibold text-ink-100">Documents</h2>
        <div className="overflow-x-auto rounded-lg border border-ink-800 bg-ink-950">
          <table className="w-full text-sm">
            <thead className="bg-ink-900 text-[11px] uppercase tracking-wider text-ink-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Filename</th>
                <th className="px-3 py-2 text-left font-medium">Vendor / Domain / Product</th>
                <th className="px-3 py-2 text-left font-medium">Visibility</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-t border-ink-800 text-ink-100">
                  <td className="px-3 py-2.5">
                    <div>{d.filename}</div>
                    <div className="text-[10px] text-ink-500">{Math.round(d.byte_size / 1024)} KB</div>
                  </td>
                  <td className="px-3 py-2.5 text-ink-300">
                    {[d.vendor, d.domain, d.product, d.version].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      value={d.visibility}
                      onChange={(e) => void changeVisibility(d.id, e.target.value as typeof VISIBILITIES[number], [])}
                      className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-100 outline-none focus:border-brand-purple focus:ring-1 focus:ring-brand-purple/40 transition-colors"
                    >
                      {VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusPill status={d.status} message={d.error_message} />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <SecondaryButton onClick={() => void reindex(d.id)} className="mr-2 px-3 py-1 text-xs">Reindex</SecondaryButton>
                    <DangerButton onClick={() => void remove(d.id)} className="px-3 py-1 text-xs">Delete</DangerButton>
                  </td>
                </tr>
              ))}
              {docs.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-ink-500">No documents yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatusPill({ status, message }: { status: string; message: string | null }) {
  const color =
    status === "ready" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" :
    status === "error" ? "border-danger-500/40 bg-danger-500/10 text-danger-500" :
    "border-warn-500/40 bg-warn-500/10 text-warn-500";
  return (
    <span title={message ?? ""} className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${color}`}>
      {status}
    </span>
  );
}
