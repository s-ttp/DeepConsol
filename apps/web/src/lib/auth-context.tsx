"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";

export interface CurrentUser {
  id: string;
  email: string;
  role: "engineer" | "admin";
  must_rotate_password: boolean;
  group_ids: string[];
}

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<CurrentUser>("/auth/me");
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try { await api.post("/auth/logout"); } catch { /* noop */ }
    setUser(null);
    if (typeof window !== "undefined") window.location.href = "/login";
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
