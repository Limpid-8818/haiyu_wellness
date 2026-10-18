import express from 'express';
import cors from 'cors';
import { AppError, sendError } from './errors.js';
// G43：app.js 收敛为组合根——中间件、按域挂载路由与统一错误处理；
// 各域路由见 src/routes/（路径与处理逻辑为纯搬运，未改行为）。
import publicRoutes from './routes/public.js';
import accountsRoutes from './routes/accounts.js';
import bookingRoutes from './routes/booking.js';
import mealsRoutes from './routes/meals.js';
import healthRoutes from './routes/health.js';
import wellnessRoutes from './routes/wellness.js';
import environmentRoutes from './routes/environment.js';
import assistantRoutes from './routes/assistant.js';
import staffRoutes from './routes/staff.js';
import operationsRoutes from './routes/operations.js';
import deanRoutes from './routes/dean.js';
import { allowedBrowserOrigins, browserWriteGuard } from './browser-session.js';
import { createRequestControls } from './request-controls.js';

export function createApp({ requestControls = createRequestControls() } = {}) {
  const app = express();
  app.locals.requestControls = requestControls;
  // G10：仅白名单来源可跨域读取（逗号分隔可用 CORS_ALLOWED_ORIGINS 覆盖；
  // 无 Origin 头的同域请求与服务端调用不受影响）。
  const corsAllowedOrigins = allowedBrowserOrigins();
  app.locals.browserOrigins = corsAllowedOrigins;
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || corsAllowedOrigins.has(origin)) }));
  app.use(browserWriteGuard(corsAllowedOrigins));
  app.use(express.json({ limit: '256kb' }));

  app.use(publicRoutes);
  app.use(accountsRoutes);
  app.use(bookingRoutes);
  app.use(mealsRoutes);
  app.use(healthRoutes);
  app.use(wellnessRoutes);
  app.use(environmentRoutes);
  app.use(assistantRoutes);
  app.use(staffRoutes);
  app.use(operationsRoutes);
  app.use(deanRoutes);

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.parse.failed') return sendError(res, new AppError(400, 'INVALID_JSON', '请求体不是有效 JSON'));
    if (!(error instanceof AppError)) console.error(error);
    return sendError(res, error);
  });
  return app;
}

const app = createApp();
export { app };
export default app;
