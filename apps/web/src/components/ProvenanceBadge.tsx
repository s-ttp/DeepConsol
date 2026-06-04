"use client";

import type { ProvenanceTag } from "@deepconsol/shared/types";

const STYLES: Record<ProvenanceTag, string> = {
  KB: "bg-kb/20 text-kb border-kb/40",
  GEN: "bg-gen/20 text-gen border-gen/40",
  WEB: "bg-web/20 text-web border-web/40",
};

const LABELS: Record<ProvenanceTag, string> = {
  KB: "KB · from your knowledge base",
  GEN: "GEN · model general knowledge",
  WEB: "WEB · web-grounded",
};

export default function ProvenanceBadge({ tag }: { tag: ProvenanceTag }) {
  return (
    <span
      title={LABELS[tag]}
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-bold tracking-wider ${STYLES[tag]}`}
    >
      {tag}
    </span>
  );
}
