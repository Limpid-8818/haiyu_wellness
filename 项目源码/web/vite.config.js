import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.API_PROXY_TARGET || 'http://localhost:3020';
const webPort = Number(process.env.WEB_PORT) || 5180;

export default defineConfig({ plugins: [react()], server: { port: webPort, proxy: { '/api': apiProxyTarget } } });
