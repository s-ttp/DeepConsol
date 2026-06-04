import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { SettingsProvider } from "@/components/SettingsContext";

export const metadata: Metadata = {
  title: "DeepConsol",
  description: "Secure web SSH terminal + AI copilot for telecom engineers",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-app-bg text-app-text antialiased relative">
        {/* Global animated mesh gradient for liquid glass effect */}
        <div className="fixed inset-0 z-[-1] overflow-hidden pointer-events-none bg-app-bg">
          <div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-brand-purple/20 blur-[120px] mix-blend-screen animate-pulse-slow" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[50vw] h-[50vw] rounded-full bg-brand-green/10 blur-[120px] mix-blend-screen animate-pulse-slow" style={{ animationDelay: '2s' }} />
          <div className="absolute top-[40%] left-[30%] w-[30vw] h-[30vw] rounded-full bg-accent-400/10 blur-[100px] mix-blend-screen animate-pulse-slow" style={{ animationDelay: '4s' }} />
        </div>
        <SettingsProvider>
          <AuthProvider>{children}</AuthProvider>
        </SettingsProvider>
      </body>
    </html>
  );
}
