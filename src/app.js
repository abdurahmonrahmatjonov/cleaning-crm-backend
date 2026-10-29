import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { authenticate, requireRole } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { catalogRouter } from './routes/catalog.js';
import { orderRouter } from './routes/orders.js';
import { expensesRouter } from './routes/expenses.js';
import { clientsRouter } from './routes/clients.js';
import { reportsRouter } from './routes/reports.js';

// Who may use what. Change the roles here if the business rules differ.
const ORDERS_ROLES = ['admin', 'operator', 'driver'];
const EXPENSES_ROLES = ['admin', 'operator'];

export function createApp(db, opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins, maxAge: 600 }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const auth = authenticate(db);
  app.use('/api/auth', authRouter(db, opts));
  app.use('/api/users', auth, usersRouter(db));
  app.use('/api/services', auth, catalogRouter(db, 'services'));
  app.use('/api/expense-types', auth, catalogRouter(db, 'expense_types'));
  app.use('/api/orders', auth, requireRole(...ORDERS_ROLES), orderRouter(db));
  app.use('/api/expenses', auth, requireRole(...EXPENSES_ROLES), expensesRouter(db));

  app.use('/api/clients', auth, requireRole(...ORDERS_ROLES), clientsRouter(db));
  app.use('/api/reports', auth, reportsRouter(db));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
