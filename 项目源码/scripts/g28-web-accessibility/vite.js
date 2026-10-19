import { createServer } from 'vite';
import path from 'node:path';
const server = await createServer({ root: path.resolve('web'), envDir: process.env.G28_ENV_DIR });
await server.listen();
console.log('G28_VITE_READY');
let closing = false;
async function close() { if (closing) return; closing = true; await server.close(); }
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
