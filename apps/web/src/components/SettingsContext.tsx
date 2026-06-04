"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type AppTheme = "dark" | "light";
export type TerminalTheme = "default" | "mac-green";

export interface Settings {
  appTheme: AppTheme;
  appFontSize: number;
  terminalTheme: TerminalTheme;
  terminalFontSize: number;
  terminalFontFamily: string;
}

export interface SettingsContextType {
  settings: Settings;
  updateSettings: (newSettings: Partial<Settings>) => void;
}

const defaultSettings: Settings = {
  appTheme: "dark",
  appFontSize: 14,
  terminalTheme: "default",
  terminalFontSize: 13,
  terminalFontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
};

const SettingsContext = createContext<SettingsContextType>({
  settings: defaultSettings,
  updateSettings: () => {},
});

export const useSettings = () => useContext(SettingsContext);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("deepconsol_settings");
    if (stored) {
      try {
        setSettings({ ...defaultSettings, ...JSON.parse(stored) });
      } catch {
        /* ignore parse error */
      }
    }
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    localStorage.setItem("deepconsol_settings", JSON.stringify(settings));

    // Apply dark/light mode class to html element
    const html = document.documentElement;
    if (settings.appTheme === "light") {
      html.classList.add("light");
      html.classList.remove("dark"); // just in case
    } else {
      html.classList.remove("light");
      html.classList.add("dark");
    }

    // Apply global font size
    html.style.fontSize = `${settings.appFontSize}px`;
  }, [settings, isLoaded]);

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateSettings: (newSettings) =>
          setSettings((prev) => ({ ...prev, ...newSettings })),
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}
