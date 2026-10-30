import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate, permissionsOf, signToken } from '../middleware/auth.js';
import { HttpError } from '../utils/httpError.js';

const loginSchema = z.object({ username: z.string().trim().min(1), password: z.string().min(1) });

// A hash to compare against when the username does not exist, so timing doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export function authRouter(db, { loginLimit = 10 } = {}) {
  const router = Router();
  const findByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
  const findRole = db.prepare('SELECT name, permissions FROM roles WHERE key = ?');

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: loginLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, try again later' },
  });

  router.post('/login', limiter, validate(loginSchema), (req, res) => {
    const { username, password } = req.valid.body;
    const user = findByUsername.get(username);
    const ok = bcrypt.compareSync(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.isActive || !ok) throw new HttpError(401, 'Wrong username or password');
    res.json({
      token: signToken(user),
      user: { id: user.id, username: user.username, fullName: user.fullName, role: user.role, roleName: findRole.get(user.role)?.name ?? user.role, permissions: permissionsOf(findRole, user.role) },
    });
  });

  router.get('/me', authenticate(db), (req, res) => {
    const { id, username, fullName, role, permissions } = req.user;
    res.json({ id, username, fullName, role, roleName: findRole.get(role)?.name ?? role, permissions });
  });

  return router;
}
