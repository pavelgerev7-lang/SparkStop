// A repeated or bracketed query parameter (?q=a&q=b, ?q[x]=1) reaches Express as an array / object, while every
// handler treats query values as plain strings (.trim(), .toLowerCase(), …). Measured with a robustness test: six
// public routes (settlement / address / province / municipality lookups) answered 500 to ?q=a&q=b. Normalising once,
// before the routes, makes every handler safe: an array becomes its first value, a nested object becomes empty.
export function normalizeQuery(req, res, next) {
  const q = req.query;
  if (q && typeof q === 'object') {
    for (const key of Object.keys(q)) {
      const value = q[key];
      if (Array.isArray(value)) q[key] = typeof value[0] === 'string' ? value[0] : '';
      else if (value && typeof value === 'object') q[key] = '';
    }
  }
  next();
}
