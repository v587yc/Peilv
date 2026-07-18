"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { readAdminSession } from "@/app/login/auth-client";

export type ClientAdminRole = "super_admin" | "operator" | "auditor";
export type ClientAdminCapability = "admin:view" | "admin:configure" | "admin:execute" | "admin:dangerous" | "admin:manage";
type SessionUser = { id: string; username: string; role: ClientAdminRole };
type SessionContextValue = {
  loading: boolean;
  error: string | null;
  user: SessionUser | null;
  capabilities: readonly ClientAdminCapability[];
  hasCapability: (capability: ClientAdminCapability) => boolean;
};

const ROLE_CAPABILITIES: Record<ClientAdminRole, readonly ClientAdminCapability[]> = {
  super_admin: ["admin:view", "admin:configure", "admin:execute", "admin:dangerous", "admin:manage"],
  operator: ["admin:view", "admin:configure", "admin:execute"],
  auditor: ["admin:view"],
};

const AdminSessionContext = createContext<SessionContextValue>({
  loading: true,
  error: null,
  user: null,
  capabilities: [],
  hasCapability: () => false,
});

function isRole(value: unknown): value is ClientAdminRole {
  return value === "super_admin" || value === "operator" || value === "auditor";
}

export function AdminSessionProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    readAdminSession(controller.signal)
      .then(session => {
        setError(null);
        const candidate = session.user;
        if (session.authenticated && candidate && typeof candidate.id === "string" && typeof candidate.username === "string" && isRole(candidate.role)) {
          setUser({ id: candidate.id, username: candidate.username, role: candidate.role });
        } else if (!session.authenticated) {
          setUser(null);
        }
      })
      .catch(cause => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "管理员会话服务暂时不可用");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const value = useMemo<SessionContextValue>(() => {
    const capabilities = user ? ROLE_CAPABILITIES[user.role] : [];
    return { loading, error, user, capabilities, hasCapability: capability => capabilities.includes(capability) };
  }, [error, loading, user]);

  return <AdminSessionContext.Provider value={value}>{children}</AdminSessionContext.Provider>;
}

export function useAdminSession() {
  return useContext(AdminSessionContext);
}

export const ADMIN_ROLE_LABELS: Record<ClientAdminRole, string> = {
  super_admin: "超级管理员",
  operator: "运营管理员",
  auditor: "只读审计员",
};
