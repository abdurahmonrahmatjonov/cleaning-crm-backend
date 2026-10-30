import { Router } from 'express';

export function partnerRouter(_db) {
  const r = Router();
  r.get('/ping', (_req, res) => res.json({ ok: true }));
  return r;
}
