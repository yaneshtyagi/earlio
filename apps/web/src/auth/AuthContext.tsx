import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken } from '../api/client';

export interface Me {
  user: { id: string; email: string; name: string };
  mfaEnabled: boolean;
  mfaVerified: boolean;
  csrfToken: string;
  activeOrg: { id: string; type: 'supplier' | 'buyer' | 'bank' | 'insurer' | 'platform'; legalName: string; country: string; ratingTier: 'AA' | 'A' | 'BBB' | null; isPartner: boolean } | null;
  role: string | null;
  permissions: string[];
  memberships: { orgId: string; orgName: string; orgType: string; role: string }[];
}

interface AuthState { me: Me | null; loading: boolean; refresh: () => Promise<void>; signOut: () => Promise<void> }
const Ctx = createContext<AuthState>({ me: null, loading: true, refresh: async () => {}, signOut: async () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    retry: false,
    queryFn: async () => {
      const { data, response } = await api.GET('/api/v1/auth/me');
      if (!response.ok || !data) return null;
      setCsrfToken(data.csrfToken);
      return data as Me;
    },
  });
  const value: AuthState = {
    me: q.data ?? null,
    loading: q.isLoading,
    refresh: async () => { await qc.invalidateQueries({ queryKey: ['me'] }); },
    signOut: async () => {
      try { await api.POST('/api/v1/auth/logout'); } catch { /* the session cookie is cleared below either way */ }
      setCsrfToken('');
      qc.clear();
      qc.setQueryData(['me'], null);
      // Hard redirect: drops every in-memory cache and lands on the login page from any route.
      window.location.assign('/');
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
