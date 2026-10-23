import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { Layout } from './pages/Layout';
import { HomePage } from './pages/HomePage';
import { UsersPage } from './pages/UsersPage';
import { AuditPage } from './pages/AuditPage';

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <p className="center">Loading…</p>;
  if (!me?.mfaVerified) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
