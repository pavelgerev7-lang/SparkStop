import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectUtilityType, resolveExactOfficialSourceUrl } from '../src/services/aiParserService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbFilePath = path.join(__dirname, '..', 'data', 'local_db.json');

if (fs.existsSync(dbFilePath)) {
  const data = JSON.parse(fs.readFileSync(dbFilePath, 'utf-8'));
  let fixedCount = 0;
  if (data.outages && Array.isArray(data.outages)) {
    data.outages.forEach(o => {
      const correctUtility = detectUtilityType(o.raw_location_text || '', o.provider);
      if (o.utility_type !== correctUtility) {
        console.log(`Fixing [${o.id}] in ${o.city}: ${o.provider} was "${o.utility_type}" -> now "${correctUtility}"`);
        o.utility_type = correctUtility;
        fixedCount++;
      }
      o.source_url = resolveExactOfficialSourceUrl(o.provider, o.city, o.source_url, o.utility_type);
    });
    fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`✅ Finished fixing ${fixedCount} corrupted outage records in local_db.json.`);
  }
}
