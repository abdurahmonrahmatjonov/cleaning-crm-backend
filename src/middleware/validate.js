import { HttpError } from '../utils/httpError.js';

/** validate(schema, 'body' | 'query' | 'params') -> parsed value stored in req.valid[part] */
export const validate = (schema, part = 'body') => (req, _res, next) => {
  // A blank filter (`?from=&to=`) means "not set", not an invalid value.
  const input = part === 'query' ? Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')) : req[part];
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return next(new HttpError(400, 'Validation failed', details));
  }
  req.valid = { ...req.valid, [part]: result.data };
  next();
};
