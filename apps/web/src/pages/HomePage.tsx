import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SelectField } from '@yaneshtyagi/design-system';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Dashboard, ScorecardBody } from './DashboardPages';
import { Page, Panel } from '../ui';

function LanguageSetting() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const cur = useQuery({ queryKey: ['org-language'], queryFn: async () => (await api.GET('/api/v1/org/language')).data?.language });
  const save = useMutation({ mutationFn: async (language: 'en' | 'hi') => { await api.PUT('/api/v1/org/language', { body: { language } }); }, onSuccess: () => qc.invalidateQueries({ queryKey: ['org-language'] }) });
  if (!me?.permissions.includes('org:manage_users')) return null;
  return (
    <Panel title={t('Notification language')}>
      <SelectField label={t('Notification language')} value={cur.data ?? 'en'} onChange={(e) => save.mutate(e.target.value as 'en' | 'hi')}
        help={save.isSuccess ? t('Saved.') : undefined}>
        <option value="en">{t('English')}</option><option value="hi">{t('Hindi')}</option>
      </SelectField>
    </Panel>
  );
}

export function HomePage() {
  const { me } = useAuth();
  const { t } = useTranslation();
  if (!me?.activeOrg) return null;
  const type = me.activeOrg.type;
  return (
    <>
      <Page title={t('Welcome, {{name}}', { name: me.user.name })} description={t('You are signed in to {{org}} as {{role}}.', { org: me.activeOrg.legalName, role: me.role })} />
      {type === 'platform' ? (me.permissions.includes('audit:read') ? <ScorecardBody /> : null) : <Dashboard type={type} />}
      <LanguageSetting />
    </>
  );
}
