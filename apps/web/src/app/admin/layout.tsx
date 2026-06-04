"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading, logout } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
    else if (user.role !== "admin") router.replace("/workspace");
  }, [loading, user, router]);

  if (loading || !user || user.role !== "admin") return null;

  const isActive = (href: string): boolean => pathname === href || pathname.startsWith(href + "/");

  return (
    <main className="flex h-screen flex-col bg-ink-950 text-app-text">
      <header className="z-10 flex items-center justify-between border-b border-ink-800 bg-ink-900 px-5 py-3">
        <div className="flex items-center gap-3">
          <a href="/" className="text-base font-semibold tracking-tight text-ink-100">
            <span className="text-brand-green">Deep</span>Consol
          </a>
          <span className="rounded border border-ink-700 bg-ink-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-300">Admin</span>
        </div>
        <div className="flex items-center gap-5 text-xs text-ink-300">
          <a href="/workspace" className="text-ink-300 hover:text-ink-100 transition-colors">← Workspace</a>
          <span className="text-ink-400">{user.email}</span>
          <button onClick={() => void logout()} className="text-ink-300 hover:text-ink-100 transition-colors">Logout</button>
        </div>
      </header>
      <div className="grid flex-1 grid-cols-[220px_1fr] overflow-hidden">
        <nav className="border-r border-ink-800 bg-ink-900/60 p-3 text-sm">
          <NavLink href="/admin/documents" active={isActive("/admin/documents")}>Documents</NavLink>
          <NavLink href="/admin/groups" active={isActive("/admin/groups")}>Groups</NavLink>
          <NavLink href="/admin/users" active={isActive("/admin/users")}>Users</NavLink>
          <NavLink href="/admin/llm-config" active={isActive("/admin/llm-config")}>LLM Config</NavLink>
          <NavLink href="/admin/embedding-config" active={isActive("/admin/embedding-config")}>Embeddings</NavLink>
          <NavLink href="/admin/sanitizer" active={isActive("/admin/sanitizer")}>Filters</NavLink>
        </nav>
        <section className="overflow-y-auto bg-ink-950 p-6">{children}</section>
      </div>
    </main>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className={`mb-1 block rounded-md px-3 py-2 transition-colors ${
        active
          ? "bg-brand-purple/15 text-brand-purple border border-brand-purple/30"
          : "border border-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-100"
      }`}
    >
      {children}
    </a>
  );
}
