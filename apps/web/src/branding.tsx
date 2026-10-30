import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client';

export interface Brand { displayName: string; primary: string; accent: string; logo: string | null; welcome: string | null; whiteLabel: boolean; mode: 'network' | 'white-label'; orgId: string | null }
/** The network (Earlio itself) uses the design system's own blue; only a white-label bank overrides it. */
const DEFAULT: Brand = { displayName: 'Earlio', primary: '', accent: '', logo: null, welcome: null, whiteLabel: false, mode: 'network', orgId: null };
const Ctx = createContext<Brand>(DEFAULT);
export const useBrand = () => useContext(Ctx);

export const APP_VERSION = '0.1';

/** The Earlio mark (an E whose middle bar pays out a coin); its colours follow the theme via .earlio-mark. */
export function EarlioMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="earlio-mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <rect className="earlio-mark__coin" x="8" y="26" width="38" height="12" rx="6" />
      <rect x="8" y="8" width="12" height="48" rx="6" />
      <rect x="8" y="8" width="36" height="12" rx="6" />
      <rect x="8" y="44" width="36" height="12" rx="6" />
      <circle className="earlio-mark__coin" cx="53" cy="32" r="7.5" />
    </svg>
  );
}

/** A white-label bank's uploaded logo, else the Earlio mark on the network (a bank without a logo shows none). */
export function brandLogo(b: Brand, size: number) {
  if (b.logo) return <img src={b.logo} alt="" height={size} />;
  return b.whiteLabel ? undefined : <EarlioMark size={size} />;
}
const BRAND_TOKENS = ['--brand-50', '--brand-100', '--brand-500', '--brand-600', '--brand-700', '--accent'] as const;

/**
 * WL-1: the server resolves the hostname to a bank; the SPA maps that bank's primary colour onto the
 * design system's brand tokens (the server guarantees white text reaches 4.5 : 1 on it). With no colour
 * the design system's own palette applies.
 */
export function applyBrand(b: { primary?: string; accent?: string; displayName: string; whiteLabel?: boolean }) {
  const root = document.documentElement;
  const custom = !!b.primary && b.whiteLabel !== false;
  if (custom) {
    root.style.setProperty('--brand-500', b.primary!);
    root.style.setProperty('--brand-600', `color-mix(in srgb, ${b.primary} 86%, black)`);
    root.style.setProperty('--brand-700', `color-mix(in srgb, ${b.primary} 70%, black)`);
    root.style.setProperty('--brand-100', `color-mix(in srgb, ${b.primary} 16%, white)`);
    root.style.setProperty('--brand-50', `color-mix(in srgb, ${b.primary} 8%, white)`);
    if (b.accent) root.style.setProperty('--accent', b.accent);
  } else {
    for (const t of BRAND_TOKENS) root.style.removeProperty(t);
  }
  document.title = b.displayName;
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const q = useQuery({ queryKey: ['branding'], staleTime: 60_000, queryFn: async () => (await api.GET('/api/v1/branding')).data });
  const brand: Brand = q.data ? { ...DEFAULT, ...q.data, orgId: q.data.orgId ?? null } : DEFAULT;
  useEffect(() => { applyBrand(brand); }, [brand.primary, brand.accent, brand.displayName, brand.whiteLabel]);
  return <Ctx.Provider value={brand}>{children}</Ctx.Provider>;
}
