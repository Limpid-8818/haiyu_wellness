import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.API_PROXY_TARGET || 'http://localhost:3020';

export default defineConfig({ plugins: [react()], server: { port: 5180, proxy: { '/api': apiProxyTarget } } });
