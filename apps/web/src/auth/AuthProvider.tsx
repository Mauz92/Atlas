/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ApiError, api, type UserPublic } from "../api/client";

type AuthState = "loading" | "setup" | "anonymous" | "authenticated";

interface AuthValue {
  state: AuthState;
  user: UserPublic | null;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  setup: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  updateDisplayName: (displayName: string) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("loading");
  const [user, setUser] = useState<UserPublic | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const status = await api.setupStatus();
        if (!active) return;
        if (status.setup_required) {
          setState("setup");
          return;
        }
        const me = await api.me();
        if (!active) return;
        setUser(me);
        setState("authenticated");
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          setState("anonymous");
          return;
        }
        setError(err instanceof Error ? err.message : "Unable to reach the server");
        setState("anonymous");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const me = await api.login(email, password);
    setUser(me);
    setState("authenticated");
  }, []);

  const setup = useCallback(async (email: string, password: string, displayName: string) => {
    const me = await api.setup(email, password, displayName);
    setUser(me);
    setState("authenticated");
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setState("anonymous");
  }, []);

  const updateDisplayName = useCallback(async (displayName: string) => {
    setUser(await api.updateProfile(displayName));
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ state, user, error, login, setup, logout, updateDisplayName }),
    [state, user, error, login, setup, logout, updateDisplayName],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
