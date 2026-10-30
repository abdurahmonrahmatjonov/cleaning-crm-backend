import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { authenticate, requirePerm } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { rolesRouter } from './routes/roles.js';
import { brandingRouter } from './routes/branding.js';
import { chatRouter } from './routes/chat.js';
import { activityRouter } from './routes/activity.js';
import { commentsRouter } from './routes/comments.js';
import { catalogRouter } from './routes/catalog.js';
import { orderRouter } from './routes/orders.js';
import { expensesRouter } from './routes/expenses.js';
import { clientsRouter } from './routes/clients.js';
import { reportsRouter } from './routes/reports.js';

export function createApp(db, opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins, maxAge: 600 }),
  );
  // Branding carries a small inline logo, so it gets a bigger body limit than the rest of the API.
  app.use('/api/branding', express.json({ limit: '1.5mb' }), brandingRouter(db));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const auth = authenticate(db);
  app.use('/api/auth', authRouter(db, opts));
  app.use('/api/users', auth, usersRouter(db));
  app.use('/api/roles', auth, rolesRouter(db));
  app.use('/api/chat', auth, chatRouter(db));
  app.use('/api/activity', auth, activityRouter(db));
  app.use('/api/comments', auth, commentsRouter(db));
  app.use('/api/services', auth, catalogRouter(db, 'services'));
  app.use('/api/expense-types', auth, catalogRouter(db, 'expense_types'));
  app.use('/api/orders', auth, requirePerm('orders.view'), orderRouter(db));
  app.use('/api/expenses', auth, requirePerm('expenses.manage'), expensesRouter(db));

  app.use('/api/clients', auth, requirePerm('clients.view'), clientsRouter(db));
  app.use('/api/reports', auth, reportsRouter(db));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
