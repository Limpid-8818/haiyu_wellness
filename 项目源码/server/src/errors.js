export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const body = {
    error: status === 500 ? '服务器内部错误' : (error.message || '请求失败'),
    code: error?.code || 'INTERNAL_ERROR'
  };
  if (error?.details !== undefined) body.details = error.details;
  return res.status(status).json(body);
}
