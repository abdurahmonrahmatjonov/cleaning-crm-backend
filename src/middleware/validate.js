import { HttpError } from '../utils/httpError.js';

/** validate(schema, 'body' | 'query' | 'params') -> parsed value stored in req.valid[part] */
export const validate = (schema, part = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[part]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return next(new HttpError(400, 'Validation failed', details));
  }
  req.valid = { ...req.valid, [part]: result.data };
  next();
};
