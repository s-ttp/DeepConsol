"use client";

import { forwardRef } from "react";

/**
 * Shared form primitives for admin / login / settings pages.
 *
 * Goal: a calm, professional look — square corners (rounded-md, not rounded-full),
 * solid surface (no semi-transparent ink), subdued focus ring (single colour,
 * no glow), consistent label + help-text typography. Engineers configuring
 * users / docs / LLM keys want a clean form, not a chat bubble.
 *
 * Brand colour appears only on primary action buttons and focus rings.
 */

const baseInput =
  "block w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 outline-none transition-colors focus:border-brand-purple focus:ring-1 focus:ring-brand-purple/40 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...props }, ref) {
    return <input ref={ref} className={`${baseInput} ${className}`} {...props} />;
  }
);

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = "", ...props }, ref) {
    return <textarea ref={ref} className={`${baseInput} font-mono ${className}`} {...props} />;
  }
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", children, ...props }, ref) {
    return (
      <select ref={ref} className={`${baseInput} ${className}`} {...props}>
        {children}
      </select>
    );
  }
);

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className = "",
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      {label && (
        <span className="mb-1 flex items-baseline justify-between text-xs font-medium text-ink-300">
          <span>
            {label}
            {required && <span className="ml-0.5 text-brand-purple">*</span>}
          </span>
        </span>
      )}
      {children}
      {hint && !error && <span className="mt-1 block text-[11px] leading-relaxed text-ink-500">{hint}</span>}
      {error && <span className="mt-1 block text-[11px] font-medium text-danger-500">{error}</span>}
    </label>
  );
}

export function FormCard({
  title,
  description,
  children,
  footer,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950">
      {(title || description) && (
        <div className="border-b border-ink-800 px-5 py-3">
          {title && <h3 className="text-sm font-semibold text-ink-100">{title}</h3>}
          {description && <p className="mt-0.5 text-xs text-ink-400">{description}</p>}
        </div>
      )}
      <div className="space-y-4 px-5 py-4">{children}</div>
      {footer && <div className="border-t border-ink-800 bg-ink-900/40 px-5 py-3">{footer}</div>}
    </div>
  );
}

const buttonBase =
  "inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-ink-950";

export function PrimaryButton({
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`${buttonBase} bg-brand-purple text-white hover:bg-brand-purple/90 focus:ring-brand-purple/60 ${className}`}
    />
  );
}

export function SecondaryButton({
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`${buttonBase} border border-ink-700 bg-ink-900 text-ink-100 hover:bg-ink-800 focus:ring-ink-600 ${className}`}
    />
  );
}

export function DangerButton({
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`${buttonBase} border border-danger-500/40 bg-danger-500/10 text-danger-500 hover:bg-danger-500/20 focus:ring-danger-500/60 ${className}`}
    />
  );
}
