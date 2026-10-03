import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveExactOfficialSourceUrl } from '../src/services/aiParserService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbFilePath = path.join(__dirname, '..', 'data', 'local_db.json');

if (fs.existsSync(dbFilePath)) {
  const data = JSON.parse(fs.readFileSync(dbFilePath, 'utf-8'));
  let updatedCount = 0;
  if (data.outages && Array.isArray(data.outages)) {
    data.outages.forEach(o => {
      const fixed = resolveExactOfficialSourceUrl(o.provider, o.city, o.source_url, o.utility_type);
      if (o.source_url !== fixed) {
        o.source_url = fixed;
        updatedCount++;
      }
    });
    fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`✅ Updated ${updatedCount} outage records in local_db.json with strictly separated utility URLs.`);
  }
}
