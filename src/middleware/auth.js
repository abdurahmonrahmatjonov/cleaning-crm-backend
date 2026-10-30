import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../utils/httpError.js';
import { PERMISSIONS } from '../db.js';

/** Admin always has everything; other roles get what's stored on their role row. */
export function permissionsOf(findRole, role) {
  if (role === 'admin') return [...PERMISSIONS];
  try {
    return JSON.parse(findRole.get(role)?.permissions ?? '[]').filter((p) => PERMISSIONS.includes(p));
  } catch {
    return [];
  }
}

export const signToken = (user) =>
  jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

/** Verifies the Bearer token and loads the (still active) user from the DB on every request. */
export const authenticate = (db) => {
  const findUser = db.prepare('SELECT id, username, fullName, role, isActive, clientId FROM users WHERE id = ?');
  const findRole = db.prepare('SELECT permissions FROM roles WHERE key = ?');
  return (req, _res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next(new HttpError(401, 'Authentication required'));
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const user = findUser.get(payload.sub);
      if (!user || !user.isActive) return next(new HttpError(401, 'Invalid or disabled user'));
      req.user = { ...user, permissions: permissionsOf(findRole, user.role), clientId: user.clientId ?? null };
      next();
    } catch {
      next(new HttpError(401, 'Invalid or expired token'));
    }
  };
};

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'Forbidden for your role'));

/** Allow if the user has at least one of these permissions. */
export const requirePerm = (...perms) => (req, _res, next) =>
  perms.some((p) => req.user.permissions.includes(p)) ? next() : next(new HttpError(403, 'Forbidden for your role'));

/** Deny-by-default: any account tied to a client (saygak) is barred from staff routes. */
export const partnerGate = (req, _res, next) =>
  req.user?.clientId ? next(new HttpError(403, 'Forbidden for your role')) : next();

/** The partner API is only for accounts tied to a client. */
export const requirePartner = (req, _res, next) =>
  req.user?.clientId ? next() : next(new HttpError(403, 'Forbidden for your role'));
