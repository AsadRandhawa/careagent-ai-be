/**
 * Express global error handler.
 * Any route can call next(err) or throw inside an async wrapper
 * and this handler will return a clean JSON response.
 */
export const errorHandler = (err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  const status  = err.status  || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  res.status(status).json({ error: message });
};

/**
 * Wraps an async route handler so we never need try/catch in controllers.
 * Usage:  router.get('/path', asyncHandler(myController))
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
