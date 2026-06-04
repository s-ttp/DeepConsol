"use client";

import { useState } from "react";
import type { RiskAssessment, RiskLevel } from "@deepconsol/shared/types";
import { api } from "@/lib/api";
import { DangerButton, Input, PrimaryButton, SecondaryButton } from "./ui/Form";

interface Props {
  messageId: string;
  block: string;
  assessment: RiskAssessment;
  onClose: () => void;
}

const LEVEL_STYLES: Record<RiskLevel, string> = {
  low: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  medium: "border-warn-500/40 bg-warn-500/10 text-warn-500",
  high: "border-danger-500/40 bg-danger-500/10 text-danger-500",
  critical: "border-danger-600/60 bg-danger-600/15 text-danger-500",
};

export default function SafeCopyModal({ messageId, block, assessment, onClose }: Props) {
  const [understood, setUnderstood] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requiresTyped = assessment.level === "high" || assessment.level === "critical";

  async function copyNow(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.post("/safe-copy/confirm", {
        message_id: messageId,
        block,
        confirmation: requiresTyped ? "typed" : "click",
        typed_value: requiresTyped ? typedConfirm : undefined,
      });
      await navigator.clipboard.writeText(block);
      onClose();
    } catch {
      setError("Confirmation failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const canConfirm =
    understood &&
    (!requiresTyped || typedConfirm === "I UNDERSTAND") &&
    !busy;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-ink-800 bg-ink-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
          <h2 className="text-base font-semibold text-ink-100">Review &amp; copy</h2>
          <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${LEVEL_STYLES[assessment.level]}`}>
            {assessment.level} risk
          </span>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-ink-300">{assessment.reason}</p>

          <div className="grid grid-cols-2 gap-3 rounded-md border border-ink-800 bg-ink-950 px-3 py-2 text-xs">
            <div className="text-ink-400">
              State-changing:{" "}
              <span className={assessment.state_changing ? "text-danger-500 font-medium" : "text-emerald-400 font-medium"}>
                {String(assessment.state_changing)}
              </span>
            </div>
            <div className="text-ink-400">
              Read-only: <span className="text-ink-100 font-medium">{String(assessment.read_only)}</span>
            </div>
          </div>

          <pre className="max-h-64 overflow-y-auto rounded-md border border-ink-800 bg-ink-950 p-3 font-mono text-xs text-ink-100 whitespace-pre-wrap">
            {block}
          </pre>

          <label className="flex items-start gap-2 text-sm text-ink-200">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              className="mt-0.5 accent-brand-purple"
            />
            <span>I have reviewed the command and understand its impact.</span>
          </label>

          {requiresTyped && (
            <div>
              <label className="mb-1 block text-xs text-ink-300">
                Type <span className="font-mono font-semibold text-danger-500">I UNDERSTAND</span> to confirm:
              </label>
              <Input
                type="text"
                value={typedConfirm}
                onChange={(e) => setTypedConfirm(e.target.value)}
                autoComplete="off"
                className="font-mono"
              />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-danger-500/40 bg-danger-500/10 px-3 py-2 text-xs font-medium text-danger-500">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-800 bg-ink-950/40 px-5 py-3">
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          {requiresTyped ? (
            <DangerButton disabled={!canConfirm} onClick={() => void copyNow()}>
              {busy ? "Copying…" : "Confirm & copy"}
            </DangerButton>
          ) : (
            <PrimaryButton disabled={!canConfirm} onClick={() => void copyNow()}>
              {busy ? "Copying…" : "Copy to clipboard"}
            </PrimaryButton>
          )}
        </div>
      </div>
    </div>
  );
}
