import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA only talks to the API over HTTP (OpenAPI contract in docs/openapi.json).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.VITE_API_URL ?? 'http://localhost:4000',
      '/health': process.env.VITE_API_URL ?? 'http://localhost:4000',
    },
  },
});
