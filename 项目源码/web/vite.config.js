import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../', import.meta.url)), ['WEB_PORT', 'API_PROXY_TARGET']);
  const apiProxyTarget = process.env.API_PROXY_TARGET || env.API_PROXY_TARGET || 'http://localhost:3020';
  const webPort = Number(process.env.WEB_PORT || env.WEB_PORT) || 5180;
  return { plugins: [react()], server: { port: webPort, proxy: { '/api': apiProxyTarget } } };
});
