"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export default function Home() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
    else if (user.must_rotate_password) router.replace("/rotate-password");
    else router.replace("/workspace");
  }, [loading, user, router]);

  return (
    <main className="min-h-screen flex items-center justify-center text-ink-400">
      Loading…
    </main>
  );
}
