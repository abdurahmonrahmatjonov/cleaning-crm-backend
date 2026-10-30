import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { authenticate, requirePerm, partnerGate, requirePartner } from './middleware/auth.js';
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
import { partnerRouter } from './routes/partner.js';

/** Every path mounted behind the staff gate; the access test iterates this list. */
export const STAFF_MOUNTS = [];

export function createApp(db, opts = {}) {
  STAFF_MOUNTS.length = 0;
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
  const mount = (path, ...handlers) => {
    STAFF_MOUNTS.push(path);
    app.use(path, auth, partnerGate, ...handlers);
  };
  app.use('/api/auth', authRouter(db, opts));
  app.use('/api/partner', auth, requirePartner, partnerRouter(db));
  mount('/api/users', usersRouter(db));
  mount('/api/roles', rolesRouter(db));
  mount('/api/chat', chatRouter(db));
  mount('/api/activity', activityRouter(db));
  mount('/api/comments', commentsRouter(db));
  mount('/api/services', catalogRouter(db, 'services'));
  mount('/api/expense-types', catalogRouter(db, 'expense_types'));
  mount('/api/orders', requirePerm('orders.view'), orderRouter(db));
  mount('/api/expenses', requirePerm('expenses.manage'), expensesRouter(db));

  mount('/api/clients', requirePerm('clients.view'), clientsRouter(db));
  mount('/api/reports', reportsRouter(db));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
