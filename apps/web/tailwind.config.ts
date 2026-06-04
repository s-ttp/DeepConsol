import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: {
          50: "var(--ink-50)",
          100: "var(--ink-100)",
          200: "var(--ink-200)",
          300: "var(--ink-300)",
          400: "var(--ink-400)",
          500: "var(--ink-500)",
          600: "var(--ink-600)",
          700: "var(--ink-700)",
          800: "var(--ink-800)",
          900: "var(--ink-900)",
          950: "var(--ink-950)",
        },
        accent: {
          400: "#38bdf8",
          500: "#0ea5e9",
          600: "#0284c7",
        },
        warn: { 500: "#f59e0b" },
        danger: { 500: "#ef4444", 600: "#dc2626" },
        brand: {
          green: "#00FFA3",
          // Softened from pure violet (#8A2BE2) to indigo. Sits more
          // harmoniously next to the cyan gradient endpoint and reads as
          // "tech" rather than "fashion".
          purple: "#6366F1",
        },
        kb: "var(--kb-color)",
        gen: "var(--gen-color)",
        web: "var(--web-color)",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      animation: {
        "pulse-slow": "pulse-slow 10s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "typing-dot": "typing-dot 1.2s ease-in-out infinite",
        "pin-glow": "pin-glow 1.5s ease-out 1",
        "stream-edge": "stream-edge 2.5s linear infinite",
        "badge-glow": "badge-glow 5s ease-out 1",
      },
      keyframes: {
        "pulse-slow": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: ".7", transform: "scale(1.05)" },
        },
        "typing-dot": {
          "0%, 80%, 100%": { transform: "scale(0.7)", opacity: "0.4" },
          "40%": { transform: "scale(1)", opacity: "1" },
        },
        "pin-glow": {
          "0%": { boxShadow: "0 0 0 2px rgba(0, 255, 163, 0.6), 0 0 20px rgba(0, 255, 163, 0.4)" },
          "100%": { boxShadow: "0 0 0 0 rgba(0, 255, 163, 0)" },
        },
        "stream-edge": {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "badge-glow": {
          "0%": { filter: "drop-shadow(0 0 10px currentColor)" },
          "100%": { filter: "drop-shadow(0 0 0 transparent)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
