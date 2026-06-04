"use client";

import React from "react";
import { useSettings } from "./SettingsContext";
import { Field, Input, Select } from "./ui/Form";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { settings, updateSettings } = useSettings();

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-ink-800 bg-ink-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
          <h2 className="text-base font-semibold text-ink-100">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100 transition-colors"
          >
            ×
          </button>
        </div>

        <div className="space-y-6 px-5 py-4">
          <section>
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
              Application appearance
            </h3>
            <div className="space-y-3">
              <Field label="Theme">
                <Select
                  value={settings.appTheme}
                  onChange={(e) => updateSettings({ appTheme: e.target.value as "dark" | "light" })}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </Select>
              </Field>

              <Field label="Font size (px)">
                <Input
                  type="number"
                  min={10}
                  max={24}
                  value={settings.appFontSize}
                  onChange={(e) => updateSettings({ appFontSize: Number(e.target.value) })}
                />
              </Field>
            </div>
          </section>

          <section>
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
              Terminal appearance
            </h3>
            <div className="space-y-3">
              <Field label="Theme">
                <Select
                  value={settings.terminalTheme}
                  onChange={(e) => updateSettings({ terminalTheme: e.target.value as "default" | "mac-green" })}
                >
                  <option value="default">Default dark</option>
                  <option value="mac-green">Mac shell (green on black)</option>
                </Select>
              </Field>

              <Field label="Font size (px)">
                <Input
                  type="number"
                  min={8}
                  max={36}
                  value={settings.terminalFontSize}
                  onChange={(e) => updateSettings({ terminalFontSize: Number(e.target.value) })}
                />
              </Field>

              <Field label="Font family" hint="Comma-separated list. Falls back left-to-right.">
                <Input
                  value={settings.terminalFontFamily}
                  onChange={(e) => updateSettings({ terminalFontFamily: e.target.value })}
                  placeholder="Monaco, Consolas, monospace"
                />
              </Field>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
