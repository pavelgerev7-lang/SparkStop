import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseBulgarianDateTime } from '../src/services/aiParserService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../data/local_db.json');

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

console.log(`Processing ${db.outages.length} outages to synchronize exact hours...`);

let updatedCount = 0;
for (const o of db.outages) {
  if (o.raw_location_text) {
    const timeInfo = parseBulgarianDateTime(o.raw_location_text);
    o.start_time = timeInfo.start_time;
    o.expected_end_time = timeInfo.expected_end_time;
    o.status = timeInfo.status;
    updatedCount++;
  }
}

fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
console.log(`✅ Successfully synchronized exact hours for ${updatedCount} outages in local_db.json!`);
