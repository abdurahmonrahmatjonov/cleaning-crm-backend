import { Router } from 'express';
import { logActivity } from '../utils/activity.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export const DEFAULT_PROJECT_NAME = 'BIS CRM';

// Images are stored inline as data URLs (the web app downsizes them before upload).
const image = (max) =>
  z
    .string()
    .max(max)
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Must be a PNG, JPEG or WebP data URL');

// undefined = leave as is; null or '' = reset to the default
const putSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    logo: image(300_000).nullable(),
    loginTitle: z.string().trim().max(160).nullable(),
    loginSubtitle: z.string().trim().max(200).nullable(),
    loginBackground: image(700_000).nullable(),
    loginColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected #rrggbb').nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');

// request field -> settings key
const KEYS = {
  name: 'projectName',
  logo: 'logo',
  loginTitle: 'loginTitle',
  loginSubtitle: 'loginSubtitle',
  loginBackground: 'loginBackground',
  loginColor: 'loginColor',
};

export function brandingRouter(db) {
  const router = Router();
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const del = db.prepare('DELETE FROM settings WHERE key = ?');

  const read = () => ({
    name: get.get('projectName')?.value ?? DEFAULT_PROJECT_NAME,
    logo: get.get('logo')?.value ?? null,
    loginTitle: get.get('loginTitle')?.value ?? null,
    loginSubtitle: get.get('loginSubtitle')?.value ?? null,
    loginBackground: get.get('loginBackground')?.value ?? null,
    loginColor: get.get('loginColor')?.value ?? null,
  });

  // Public: the login page shows these before anyone is signed in.
  router.get('/', (_req, res) => res.json(read()));

  router.put('/', authenticate(db), requireRole('admin'), validate(putSchema), (req, res) => {
    db.transaction(() => {
      for (const [field, value] of Object.entries(req.valid.body)) {
        if (value === null || value === '') del.run(KEYS[field]);
        else put.run(KEYS[field], value);
      }
      // only which settings changed; images and long text stay out of the log
      logActivity(db, req.user, 'branding', 'main', 'branding.updated', { fields: Object.keys(req.valid.body), name: req.valid.body.name });
    })();
    res.json(read());
  });

  return router;
}
