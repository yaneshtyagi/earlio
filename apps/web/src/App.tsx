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
import { BuyerPaymentsPage, ControlRoomPage, IntegrationInspectorPage, NotificationsPage, SettlementConsolePage } from './pages/SettlementPages';
import { ClaimsPage, DisputeDetailPage, DisputesPage, ExportProceedsPage, RecoveryPage, RecoursePage } from './pages/ExceptionPages';
import { ApprovalsPage, BankConsolePage, GuardrailConsolePage } from './pages/GovernancePages';
import { BankIntegrationPage } from './pages/IntegrationPages';
import { ScorecardPage } from './pages/DashboardPages';
import { NetworkPage } from './pages/NetworkPage';
import { TermsSetPage, TermsStudioPage } from './pages/TermsPages';
import { InsuranceLimitsPage, InsuranceRequestsPage } from './pages/InsurancePages';

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <p className="center-note" role="status">Loading…</p>;
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
        <Route path="disputes" element={<DisputesPage />} />
        <Route path="disputes/:id" element={<DisputeDetailPage />} />
        <Route path="recovery" element={<RecoveryPage />} />
        <Route path="claims" element={<ClaimsPage />} />
        <Route path="recourse" element={<RecoursePage />} />
        <Route path="export-proceeds" element={<ExportProceedsPage />} />
        <Route path="terms" element={<TermsStudioPage />} />
        <Route path="terms/:id" element={<TermsSetPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="bank/console" element={<BankConsolePage />} />
        <Route path="bank/integration" element={<BankIntegrationPage />} />
        <Route path="admin/scorecard" element={<ScorecardPage />} />
        <Route path="admin/network" element={<NetworkPage />} />
        <Route path="admin/guardrails" element={<GuardrailConsolePage />} />
        <Route path="payments" element={<BuyerPaymentsPage />} />
        <Route path="settlement" element={<SettlementConsolePage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="admin/control-room" element={<ControlRoomPage />} />
        <Route path="admin/integrations" element={<IntegrationInspectorPage />} />
        <Route path="admin/kyc" element={<AdminKycPage />} />
        <Route path="admin/sanctions" element={<AdminSanctionsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
