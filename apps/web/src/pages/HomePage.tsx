import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Dashboard, ScorecardPage } from './DashboardPages';

function LanguageSetting() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const cur = useQuery({ queryKey: ['org-language'], queryFn: async () => (await api.GET('/api/v1/org/language')).data?.language });
  const save = useMutation({ mutationFn: async (language: 'en' | 'hi') => { await api.PUT('/api/v1/org/language', { body: { language } }); }, onSuccess: () => qc.invalidateQueries({ queryKey: ['org-language'] }) });
  if (!me?.permissions.includes('org:manage_users')) return null;
  return (
    <p className="filters"><label>{t('Notification language')}
      <select value={cur.data ?? 'en'} onChange={(e) => save.mutate(e.target.value as 'en' | 'hi')}><option value="en">{t('English')}</option><option value="hi">{t('Hindi')}</option></select></label>
      {save.isSuccess && <span className="hint" role="status">{t('Saved.')}</span>}</p>
  );
}

export function HomePage() {
  const { me } = useAuth();
  const { t } = useTranslation();
  if (!me?.activeOrg) return null;
  const type = me.activeOrg.type;
  return (
    <section>
      <h2>{t('Welcome, {{name}}', { name: me.user.name })}</h2>
      <p>{t('You are signed in to {{org}} as {{role}}.', { org: me.activeOrg.legalName, role: me.role })}</p>
      <LanguageSetting />
      {type === 'platform' ? (me.permissions.includes('audit:read') ? <ScorecardPage /> : null) : <Dashboard type={type} />}
    </section>
  );
}
