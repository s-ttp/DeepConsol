"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  Field,
  Input,
  PrimaryButton,
  SecondaryButton,
  Select,
  Textarea,
} from "./ui/Form";

type Protocol = "ssh" | "telnet";

interface SshCredential {
  id: string;
  label: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key";
}

export interface ConnectedSession {
  id: string;
  target: string;
}

interface Props {
  onConnect: (session: ConnectedSession) => void;
  onClose: () => void;
}

export default function ConnectDialog({ onConnect, onClose }: Props) {
  const [creds, setCreds] = useState<SshCredential[]>([]);
  const [chosenId, setChosenId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"saved" | "ad_hoc" | "save">("saved");

  // Ad-hoc / save form
  const [label, setLabel] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("ssh");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<"password" | "key">("password");
  const [secret, setSecret] = useState("");
  // Switching to telnet implies password auth — key auth doesn't apply.
  const effectiveAuthType: "password" | "key" = protocol === "telnet" ? "password" : authType;

  useEffect(() => {
    api.get<SshCredential[]>("/ssh-credentials").then(setCreds).catch(() => setCreds([]));
  }, []);

  // Auto-suggest protocol from common port choices. Users can still override
  // via the dropdown; we only switch when the port lands on a canonical value
  // and the protocol still matches the previous default for that pairing.
  function changePort(next: number): void {
    setPort(next);
    if (next === 23 && protocol === "ssh") setProtocol("telnet");
    else if (next === 22 && protocol === "telnet") setProtocol("ssh");
  }

  function changeProtocol(next: Protocol): void {
    setProtocol(next);
    // Move to the canonical port unless the user has already typed something
    // non-default; preserves a custom port like 2222 / 2323.
    if (next === "telnet" && port === 22) setPort(23);
    else if (next === "ssh" && port === 23) setPort(22);
    if (next === "telnet") setAuthType("password");
  }

  async function connectSaved(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      const session = await api.post<{ id: string; target: string }>("/terminal/sessions", { credential_id: chosenId });
      onConnect({ id: session.id, target: session.target });
    } catch {
      setError("Failed to start session");
    } finally {
      setBusy(false);
    }
  }

  async function connectAdHoc(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      const session = await api.post<{ id: string; target: string }>("/terminal/sessions", {
        ad_hoc: { protocol, host, port, username, auth_type: effectiveAuthType, secret },
      });
      onConnect({ id: session.id, target: session.target });
    } catch {
      setError("Failed to start session");
    } finally {
      setBusy(false);
    }
  }

  async function saveAndConnect(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      const created = await api.post<{ id: string }>("/ssh-credentials", {
        label, protocol, host, port, username, auth_type: effectiveAuthType, secret,
      });
      const session = await api.post<{ id: string; target: string }>("/terminal/sessions", { credential_id: created.id });
      onConnect({ id: session.id, target: session.target });
    } catch {
      setError("Failed to save / start session");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-ink-800 bg-ink-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
          <h2 className="text-base font-semibold text-ink-100">Open remote session</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100 transition-colors"
          >
            ×
          </button>
        </div>

        <div className="flex gap-1 border-b border-ink-800 bg-ink-950/50 px-3 py-2">
          <Tab active={tab === "saved"} onClick={() => setTab("saved")}>Saved</Tab>
          <Tab active={tab === "ad_hoc"} onClick={() => setTab("ad_hoc")}>One-off</Tab>
          <Tab active={tab === "save"} onClick={() => setTab("save")}>Save &amp; connect</Tab>
        </div>

        <div className="px-5 py-4">
          {tab === "saved" && (
            <form onSubmit={connectSaved} className="space-y-4">
              {creds.length === 0 ? (
                <p className="rounded-md border border-ink-800 bg-ink-950 px-3 py-3 text-xs text-ink-400">
                  No saved credentials. Use <span className="text-ink-200">One-off</span> or <span className="text-ink-200">Save &amp; connect</span>.
                </p>
              ) : (
                <Field label="Credential" required>
                  <Select value={chosenId} onChange={(e) => setChosenId(e.target.value)} required>
                    <option value="">— select credential —</option>
                    {creds.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} ({(c.protocol ?? "ssh").toUpperCase()} · {c.username || "?"}@{c.host}:{c.port})
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <FormFooter
                error={error}
                primary={
                  <PrimaryButton type="submit" disabled={busy || !chosenId}>
                    {busy ? "Connecting…" : "Connect"}
                  </PrimaryButton>
                }
              />
            </form>
          )}

          {(tab === "ad_hoc" || tab === "save") && (
            <form onSubmit={tab === "save" ? saveAndConnect : connectAdHoc} className="space-y-4">
              {tab === "save" && (
                <Field label="Label" required>
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} required placeholder="e.g. Core-Lab-MME-01" />
                </Field>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Field label="Protocol" required>
                  <Select value={protocol} onChange={(e) => changeProtocol(e.target.value as Protocol)}>
                    <option value="ssh">SSH (encrypted)</option>
                    <option value="telnet">Telnet (cleartext)</option>
                  </Select>
                </Field>
                <Field label="Port" required>
                  <Input
                    type="number"
                    value={String(port)}
                    onChange={(e) => changePort(parseInt(e.target.value, 10) || 22)}
                  />
                </Field>
              </div>

              <Field label="Host" required>
                <Input value={host} onChange={(e) => setHost(e.target.value)} required placeholder="hostname or IP" />
              </Field>

              <Field
                label="Username"
                required={protocol === "ssh"}
                hint={protocol === "telnet" ? "Optional — leave blank to type at the prompt." : undefined}
              >
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required={protocol === "ssh"}
                  autoComplete="off"
                />
              </Field>

              {protocol === "ssh" && (
                <Field label="Auth type" required>
                  <Select
                    value={authType}
                    onChange={(e) => setAuthType(e.target.value as "password" | "key")}
                  >
                    <option value="password">Password</option>
                    <option value="key">Private key</option>
                  </Select>
                </Field>
              )}

              <Field
                label={effectiveAuthType === "password" ? "Password" : "Private key (paste contents)"}
                required={protocol === "ssh"}
                hint={protocol === "telnet" && effectiveAuthType === "password" ? "Optional — leave blank to type at the prompt." : undefined}
              >
                {effectiveAuthType === "password" ? (
                  <Input
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    required={protocol === "ssh"}
                    autoComplete="new-password"
                  />
                ) : (
                  <Textarea
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    required
                    rows={6}
                    className="text-xs"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  />
                )}
              </Field>

              {protocol === "telnet" && (
                <p className="rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-[11px] text-warn-500">
                  Telnet sends keystrokes in cleartext — use only on isolated management VLANs / OOB networks. Prefer SSH when both are available.
                </p>
              )}

              <FormFooter
                error={error}
                primary={
                  <PrimaryButton type="submit" disabled={busy}>
                    {busy ? "Connecting…" : tab === "save" ? "Save & connect" : "Connect"}
                  </PrimaryButton>
                }
              />
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-brand-purple/15 text-brand-purple border border-brand-purple/30"
          : "border border-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-100"
      }`}
    >
      {children}
    </button>
  );
}

function FormFooter({ error, primary }: { error: string | null; primary: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      {error && <span className="text-xs font-medium text-danger-500">{error}</span>}
      <div className="ml-auto flex items-center gap-2">{primary}</div>
    </div>
  );
}
