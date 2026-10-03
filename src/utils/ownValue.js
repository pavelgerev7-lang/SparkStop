// Lookup tables in this project are plain objects keyed by place names, and the keys come from the outside world
// (query strings, saved addresses, scraped text). On a plain object a key like "constructor", "__proto__" or
// "toString" is not a miss: it returns an inherited function or object, which then blows up in the first loop or
// .map() that touches it. Measured with a fuzz run: ?city=constructor made /api/addresses/autocomplete,
// /api/outages/check, /api/geo/municipalities/autocomplete and POST /api/addresses/save answer 500.
// ownValue() only ever returns what the table itself holds.
export function ownValue(table, key) {
  return table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
