import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client';

export interface Brand { displayName: string; primary: string; accent: string; logo: string | null; welcome: string | null; whiteLabel: boolean; mode: 'network' | 'white-label'; orgId: string | null }
const DEFAULT: Brand = { displayName: 'Earlio', primary: '#0b5d3b', accent: '#c9a227', logo: null, welcome: null, whiteLabel: false, mode: 'network', orgId: null };
const Ctx = createContext<Brand>(DEFAULT);
export const useBrand = () => useContext(Ctx);

/** WL-1: the server resolves the hostname to a bank; the SPA themes itself with CSS variables. */
export function applyBrand(b: Pick<Brand, 'primary' | 'accent' | 'displayName'>) {
  const root = document.documentElement;
  root.style.setProperty('--brand', b.primary);
  root.style.setProperty('--accent', b.accent);
  document.title = b.displayName;
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const q = useQuery({ queryKey: ['branding'], staleTime: 60_000, queryFn: async () => (await api.GET('/api/v1/branding')).data });
  const brand: Brand = q.data ? { ...DEFAULT, ...q.data, orgId: q.data.orgId ?? null } : DEFAULT;
  useEffect(() => { applyBrand(brand); }, [brand.primary, brand.accent, brand.displayName]);
  return <Ctx.Provider value={brand}>{children}</Ctx.Provider>;
}

export function BrandMark({ size = 28 }: { size?: number }) {
  const b = useBrand();
  return <span className="brandmark">{b.logo ? <img src={b.logo} alt="" height={size} /> : null}<strong>{b.displayName}</strong></span>;
}
