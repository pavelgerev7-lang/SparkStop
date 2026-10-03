import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { geocodeStreetWithNominatim } from '../src/services/geocodingService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../data/local_db.json');

if (!fs.existsSync(dbPath)) {
  console.log('No local_db.json found.');
  process.exit(0);
}

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const outages = db.outages || [];

console.log(`Found ${outages.length} outages to pre-geocode...`);

async function run() {
  for (const o of outages) {
    const city = o.city;
    const streets = Array.isArray(o.affected_streets) ? o.affected_streets : [o.raw_location_text];
    for (const st of streets) {
      if (!st) continue;
      const res = await geocodeStreetWithNominatim(city, st);
      console.log(`Geocoded [${st}, ${city}] => lat: ${res.lat}, lng: ${res.lng}`);
      // gentle delay for Nominatim rate policy
      await new Promise(r => setTimeout(r, 400));
    }
  }
  console.log('✅ Finished pre-geocoding all active outage streets!');
}

run();
