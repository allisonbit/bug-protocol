"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { supabaseBrowser, SUPABASE_CONFIGURED } from "@/lib/supabase/client";
import type { Profile } from "@/lib/db";

type AuthState = {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  configured: boolean;
  refreshProfile: () => void;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<AuthState>({
  user: null,
  profile: null,
  loading: true,
  configured: SUPABASE_CONFIGURED,
  refreshProfile: () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(
    async (uid: string) => {
      if (!sb) return;
      const { data } = await sb.from("profiles").select("*").eq("id", uid).maybeSingle();
      setProfile((data as Profile) ?? null);
    },
    [sb],
  );

  useEffect(() => {
    if (!sb) {
      setLoading(false);
      return;
    }
    let active = true;

    sb.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      if (!active) return;
      const u = data.session?.user ?? null;
      setUser(u);
      setLoading(false);
      if (u) loadProfile(u.id);
    });

    const { data: sub } = sb.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      if (!active) return;
      const u = session?.user ?? null;
      setUser(u);
      // Defer the profile fetch so we don't re-enter the auth client synchronously.
      if (u) setTimeout(() => active && loadProfile(u.id), 0);
      else setProfile(null);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [sb, loadProfile]);

  const signOut = useCallback(async () => {
    await sb?.auth.signOut();
    setUser(null);
    setProfile(null);
  }, [sb]);

  const refreshProfile = useCallback(() => {
    if (user) loadProfile(user.id);
  }, [user, loadProfile]);

  const value = useMemo(
    () => ({ user, profile, loading, configured: SUPABASE_CONFIGURED, refreshProfile, signOut }),
    [user, profile, loading, refreshProfile, signOut],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  return useContext(AuthCtx);
}
