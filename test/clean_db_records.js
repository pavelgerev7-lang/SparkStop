import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cleanOutageAnnouncementText } from '../src/utils/textCleaner.js';
import { resolveExactOfficialSourceUrl } from '../src/services/aiParserService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbFilePath = path.join(__dirname, '..', 'data', 'local_db.json');

if (fs.existsSync(dbFilePath)) {
  const data = JSON.parse(fs.readFileSync(dbFilePath, 'utf-8'));
  let cleanedCount = 0;
  if (data.outages && Array.isArray(data.outages)) {
    data.outages.forEach(o => {
      // 1. Clean the raw text from any repetitive boilerplate/footer
      const cleanedText = cleanOutageAnnouncementText(o.raw_location_text || '');
      if (cleanedText && cleanedText !== o.raw_location_text) {
        o.raw_location_text = cleanedText;
        cleanedCount++;
      }
      // 2. Ensure exact URL
      o.source_url = resolveExactOfficialSourceUrl(o.provider, o.city, o.source_url);
    });
    fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`✅ Successfully cleaned ${cleanedCount} outage records in local_db.json.`);
  }
}
