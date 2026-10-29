import { HttpError } from '../utils/httpError.js';

export const notFoundHandler = (_req, _res, next) => next(new HttpError(404, 'Route not found'));

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details && { details: err.details }) });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
