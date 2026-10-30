import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.VITE_API_URL ?? 'http://localhost:4000';
// The proxy rewrites Host to the API's; pass the browser's host on so the API can tell which bank's portal
// (kestrel.localhost:5173 → Kestrel) the visitor opened (WL-1).
const proxy: ProxyOptions = {
  target: api,
  changeOrigin: true,
  configure: (p) => p.on('proxyReq', (req, inc) => { if (inc.headers.host) req.setHeader('x-forwarded-host', inc.headers.host); }),
};

// The SPA only talks to the API over HTTP (OpenAPI contract in docs/openapi.json).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': proxy, '/health': proxy },
  },
});
