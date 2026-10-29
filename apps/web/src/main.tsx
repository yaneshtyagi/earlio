import '@yaneshtyagi/design-system/fonts.css';
import '@yaneshtyagi/design-system/styles.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppRoot, ThemeProvider, ToastProvider } from '@yaneshtyagi/design-system';
import { App } from './App';
import { BrandProvider } from './branding';
import { AuthProvider } from './auth/AuthContext';
import './i18n';

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <AppRoot>
          <QueryClientProvider client={qc}>
            <BrandProvider>
              <BrowserRouter>
                <AuthProvider>
                  <App />
                </AuthProvider>
              </BrowserRouter>
            </BrandProvider>
          </QueryClientProvider>
        </AppRoot>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
