import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const resourceManaged = process.env.HAIYU_RESOURCE_MANAGED === '1';
  const env = resourceManaged
    ? {}
    : loadEnv(mode, fileURLToPath(new URL('../', import.meta.url)), ['WEB_PORT', 'API_PROXY_TARGET']);
  const apiProxyTarget = process.env.API_PROXY_TARGET || env.API_PROXY_TARGET || 'http://localhost:3020';
  const configuredWebPort = process.env.WEB_PORT || env.WEB_PORT || '5180';
  const webPort = Number(configuredWebPort);
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_534) {
    throw new Error(`WEB_PORT must be an integer from 1 to 65534; received ${configuredWebPort}`);
  }
  const viteCacheDir = resourceManaged ? process.env.HAIYU_VITE_CACHE_DIR : '';
  if (viteCacheDir && !path.isAbsolute(viteCacheDir)) {
    throw new Error('HAIYU_VITE_CACHE_DIR must be an absolute path inside the managed resource directory');
  }
  const apiProxy = { '/api': apiProxyTarget };
  return {
    plugins: [react()],
    ...(viteCacheDir ? { cacheDir: viteCacheDir } : {}),
    server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy: apiProxy },
    preview: { host: '127.0.0.1', port: webPort + 1, strictPort: true, proxy: apiProxy },
    build: process.env.HAIYU_RESOURCE_BUILD_OUT_DIR
      ? { outDir: process.env.HAIYU_RESOURCE_BUILD_OUT_DIR, emptyOutDir: true }
      : {}
  };
});
