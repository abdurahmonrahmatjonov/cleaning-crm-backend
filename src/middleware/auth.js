import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../utils/httpError.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

/** Verifies the Bearer token and loads the (still active) user from the DB on every request. */
export const authenticate = (db) => {
  const findUser = db.prepare('SELECT id, username, fullName, role, isActive FROM users WHERE id = ?');
  return (req, _res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next(new HttpError(401, 'Authentication required'));
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const user = findUser.get(payload.sub);
      if (!user || !user.isActive) return next(new HttpError(401, 'Invalid or disabled user'));
      req.user = user;
      next();
    } catch {
      next(new HttpError(401, 'Invalid or expired token'));
    }
  };
};

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'Forbidden for your role'));
