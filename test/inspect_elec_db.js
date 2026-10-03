import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbFilePath = path.join(__dirname, '..', 'data', 'local_db.json');

const data = JSON.parse(fs.readFileSync(dbFilePath, 'utf-8'));
data.outages.filter(o => o.utility_type === 'electricity' || o.provider.includes('EVN') || o.provider.includes('Енерго')).forEach(o => {
  console.log(`[${o.city}] ${o.provider} (${o.utility_type}): ${o.source_url}`);
});
