// Real geometry of the named boulevards ("бул.") of the regional centres (data/major_streets.json, built from
// OpenStreetMap on 2026-09-26). A boulevard is 5-13 km long and OSM has it as dozens of separate segments, so a
// geocoder answer for "бул. България, Русе" can be any of them — or, with a fuzzy match, a point that is not on the
// boulevard at all (measured: a pin 2.6 km beyond the end of Русе's бул. България). The pin of such a boulevard must
// lie ON it: a point that is already within 180 m of the boulevard is kept, anything else moves to the boulevard's
// nearest point.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let DATA = {};
try { DATA = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'major_streets.json'), 'utf8')); } catch (e) { DATA = {}; }

const BOULEVARD_PREFIX_RE = /^(?:бул(?:евард)?\.?\s*)/i;
const baseName = (s) => String(s || '').toLowerCase().replace(/[„“”"'‘’«»]/g, '').replace(BOULEVARD_PREFIX_RE, '').replace(/\s+\d[\d\s,а-я\-–]*$/i, '').replace(/\s+/g, ' ').trim();
const cityKey = (c) => String(c || '').toLowerCase().replace(/^(?:гр\.\s*|град\s+)/, '').trim();

const INDEX = new Map(); // city -> Map(base name -> { mid, pts })
for (const [city, streets] of Object.entries(DATA)) {
  const m = new Map();
  for (const [name, v] of Object.entries(streets)) m.set(baseName(name), v);
  INDEX.set(cityKey(city), m);
}

const haversineKm = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Points chosen by hand (verified against OpenStreetMap) that beat any geocoder answer.
const CURATED_POINTS = {
  // ж.к. Възраждане (OSM place=suburb); the geocoder put it 1 km south, in ж.к. Възраждане - Юг.
  'русе|кв. възраждане': [43.85708, 25.96731]
};

// The notice names a landmark next to the boulevard: use the boulevard's stretch by that landmark.
const CONTEXT_HINTS = [
  // "гр. Русе, Дунав мост, бул. България 123, 125, 133 …" — the boulevard ends at the Danube Bridge.
  { city: 'русе', name: 'българия', when: /дунав\s*мост/i, point: [43.87552, 26.01629] }
];

function lookup(cleanCity, street) {
  const s = String(street || '').trim();
  if (!BOULEVARD_PREFIX_RE.test(s)) return null;
  const idx = INDEX.get(cityKey(cleanCity));
  return idx ? (idx.get(baseName(s)) || null) : null;
}

/** The hand-picked or landmark-based point for this street, or null. */
export function curatedStreetPoint(cleanCity, street, contextText = '') {
  const city = cityKey(cleanCity);
  const curated = CURATED_POINTS[`${city}|${String(street || '').toLowerCase().trim()}`];
  if (curated) return { lat: curated[0], lng: curated[1] };
  if (BOULEVARD_PREFIX_RE.test(String(street || '').trim())) {
    const name = baseName(street);
    const hint = CONTEXT_HINTS.find((h) => h.city === city && h.name === name && h.when.test(String(contextText || '')));
    if (hint) return { lat: hint.point[0], lng: hint.point[1] };
  }
  return null;
}

/**
 * A point that is on the boulevard: the given one if it already is, else the boulevard's own point NEAREST to it
 * (so a pin that was 300 m beside the road moves 300 m, and one that was 2.6 km beyond its end lands on that end).
 */
export function snapToMajorStreet(cleanCity, street, point) {
  const e = lookup(cleanCity, street);
  if (!e || !point) return point;
  const p = [point.lat, point.lng];
  let best = null, bestD = Infinity;
  for (const q of e.pts) {
    const d = haversineKm(p, q);
    if (d < bestD) { bestD = d; best = q; }
  }
  if (!best || bestD <= 0.18) return point;
  return { lat: best[0], lng: best[1] };
}

export function hasMajorStreet(cleanCity, street) { return !!lookup(cleanCity, street); }
