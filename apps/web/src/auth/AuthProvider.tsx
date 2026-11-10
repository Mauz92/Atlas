/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ApiError, api, type UserPublic } from "../api/client";
import { desktopApi } from "../lib/desktop";

type AuthState = "loading" | "setup" | "anonymous" | "authenticated";

interface AuthValue {
  state: AuthState;
  user: UserPublic | null;
  error: string | null;
  /** Whether the server offers recovery by code (`RECOVERY_ENABLED`); true until it says no. */
  recoveryEnabled: boolean;
  /**
   * The recovery code just issued at first-run setup. Held in memory only until the owner
   * confirms having saved it; while set, the app shows nothing else (AUTH-01, ADR-0067).
   */
  pendingRecoveryCode: string | null;
  acknowledgeRecoveryCode: () => void;
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
  const [recoveryEnabled, setRecoveryEnabled] = useState(true);
  const [pendingRecoveryCode, setPendingRecoveryCode] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const status = await api.setupStatus();
        if (!active) return;
        setRecoveryEnabled(status.recovery_enabled ?? true);
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
    const { recovery_code: code, ...me } = await api.setup(email, password, displayName);
    setPendingRecoveryCode(code ?? null);
    setUser(me);
    setState("authenticated");
  }, []);

  const acknowledgeRecoveryCode = useCallback(() => setPendingRecoveryCode(null), []);

  const logout = useCallback(async () => {
    const desktop = desktopApi();
    if (desktop) {
      // the desktop app signs the DEVICE out (revokes its token, forgets it) and shows its sign-in page
      await desktop.signOut();
      return;
    }
    await api.logout();
    setPendingRecoveryCode(null);
    setUser(null);
    setState("anonymous");
  }, []);

  const updateDisplayName = useCallback(async (displayName: string) => {
    setUser(await api.updateProfile(displayName));
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      state,
      user,
      error,
      recoveryEnabled,
      pendingRecoveryCode,
      acknowledgeRecoveryCode,
      login,
      setup,
      logout,
      updateDisplayName,
    }),
    [
      state,
      user,
      error,
      recoveryEnabled,
      pendingRecoveryCode,
      acknowledgeRecoveryCode,
      login,
      setup,
      logout,
      updateDisplayName,
    ],
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
