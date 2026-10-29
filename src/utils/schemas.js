import { z } from 'zod';

const pad = (n) => String(n).padStart(2, '0');

function isRealDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** "YYYY-MM-DD" -> "YYYY-MM-DD" (validated) */
export const dateString = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => isRealDate(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)), 'Invalid date');

/** "YYYY-MM-DD HH:MM[:SS]" or ISO-like with "T" -> normalised "YYYY-MM-DD HH:MM:SS" */
export const dateTimeString = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/, 'Expected YYYY-MM-DD HH:MM[:SS]')
  .transform((s) => s.replace('T', ' '))
  .refine((s) => {
    const [y, m, d] = [+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)];
    const [hh, mm, ss] = [+s.slice(11, 13), +s.slice(14, 16), s.length > 16 ? +s.slice(17, 19) : 0];
    return isRealDate(y, m, d) && hh < 24 && mm < 60 && ss < 60;
  }, 'Invalid date/time')
  .transform((s) => (s.length === 16 ? `${s}:00` : s));

export const phoneString = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s()-]{7,20}$/, 'Invalid phone number')
  .transform((s) => s.replace(/[\s()-]/g, '')) // stored as +998901234567 so one client = one phone
  .refine((s) => s.replace('+', '').length >= 7, 'Invalid phone number');

export const money = z.number().finite().min(0).max(1e12);
export const id = z.coerce.number().int().positive();

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

export { pad };
