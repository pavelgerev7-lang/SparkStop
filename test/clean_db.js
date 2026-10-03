import fs from 'fs';
import path from 'path';

const DB_FILE = path.resolve('data/local_db.json');
if (fs.existsSync(DB_FILE)) {
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  data.outages = [];
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  console.log('Cleaned DB outages, saved addresses count:', data.saved_addresses.length);
}
