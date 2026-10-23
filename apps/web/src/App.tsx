import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { Layout } from './pages/Layout';
import { HomePage } from './pages/HomePage';
import { UsersPage } from './pages/UsersPage';
import { AuditPage } from './pages/AuditPage';
import { RegisterPage } from './pages/RegisterPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { RelationshipsPage } from './pages/RelationshipsPage';
import { AdminKycPage, AdminSanctionsPage } from './pages/AdminPages';
import { InvoicesPage } from './pages/InvoicesPage';
import { InvoiceNewPage } from './pages/InvoiceNewPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';
import { BankLimitsPage } from './pages/BankLimitsPage';
import { AdminLiensPage, BankInvitationsPage } from './pages/FundingPanels';
import { InsuranceLimitsPage, InsuranceRequestsPage } from './pages/InsurancePages';

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <p className="center">Loading…</p>;
  if (!me?.mfaVerified) return window.location.pathname === '/register' ? <RegisterPage /> : <LoginPage />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="onboarding" element={<OnboardingPage />} />
        <Route path="relationships" element={<RelationshipsPage />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="invoices/new" element={<InvoiceNewPage />} />
        <Route path="invoices/:id" element={<InvoiceDetailPage />} />
        <Route path="limits" element={<BankLimitsPage />} />
        <Route path="bank/invitations" element={<BankInvitationsPage />} />
        <Route path="admin/liens" element={<AdminLiensPage />} />
        <Route path="insurance/requests" element={<InsuranceRequestsPage />} />
        <Route path="insurance/limits" element={<InsuranceLimitsPage />} />
        <Route path="admin/kyc" element={<AdminKycPage />} />
        <Route path="admin/sanctions" element={<AdminSanctionsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
