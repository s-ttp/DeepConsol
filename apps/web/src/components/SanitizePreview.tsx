"use client";

import { type SanitizeResult } from "@deepconsol/shared/sanitizer";
import { sanitize } from "@/lib/sanitizer-rules";
import { useMemo, useState } from "react";
import { PrimaryButton, SecondaryButton, Textarea } from "./ui/Form";

interface Props {
  raw: string;
  onConfirm: (sanitized: string) => void;
  onCancel: () => void;
}

export default function SanitizePreview({ raw, onConfirm, onCancel }: Props) {
  const [editable, setEditable] = useState<string | null>(null);
  const result: SanitizeResult = useMemo(() => sanitize(raw), [raw]);
  const value = editable ?? result.sanitized;

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-3xl overflow-hidden rounded-lg border border-ink-800 bg-ink-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-ink-800 px-5 py-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-ink-100">Send to chat — sanitization preview</h2>
            <span className="text-xs text-ink-400">
              {result.redactions} redactions · {result.pseudonymizations} pseudonymizations
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-400">
            Secrets are removed; identifiers (IMSI, IP, hostname, etc.) are replaced with stable
            aliases. Edit before sending if needed.
          </p>
        </div>

        <div className="px-5 py-4">
          <Textarea
            value={value}
            onChange={(e) => setEditable(e.target.value)}
            rows={14}
            className="text-xs"
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-800 bg-ink-950/40 px-5 py-3">
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <PrimaryButton onClick={() => onConfirm(value)}>Send to chat</PrimaryButton>
        </div>
      </div>
    </div>
  );
}
