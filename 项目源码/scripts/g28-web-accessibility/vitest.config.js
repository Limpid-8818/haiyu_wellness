import { mergeConfig } from 'vitest/config';
import config from '../../web/vitest.config.js';
import path from 'node:path';
export default mergeConfig(config, {
  root: path.resolve('web'), envDir: process.env.RESOURCE_TMPDIR,
  cacheDir: path.join(process.env.RESOURCE_TMPDIR, 'vitest-cache'),
  test: { fileParallelism: false, maxWorkers: 1, minWorkers: 1 },
});
