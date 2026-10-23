import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { BrandProvider } from './branding';
import { AuthProvider } from './auth/AuthContext';
import './styles.css';

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrandProvider>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </BrandProvider>
    </QueryClientProvider>
  </StrictMode>,
);
