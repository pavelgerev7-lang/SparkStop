import fs from 'fs';

const dbPath = 'data/local_db.json';
const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

const ghostIds = new Set([
  'outage-721d29f4-cd06-4fd9-ac8a-252ce6717ec0',
  'outage-c6c39ff3-813d-4daa-8498-77c2980d11ef',
  'outage-cc61be38-3f7b-440a-b187-93082d9296ac',
  'outage-838d77a7-0f1a-4f49-86b8-4ec09ec1cdf3',
  'outage-4ba15125-fb4c-43e0-bb48-a07d63f99f12',
  'outage-1c064ce0-751b-4cc0-b473-f43053b36fa0'
]);

data.outages = data.outages.filter(o => !ghostIds.has(o.id));
fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
console.log('Successfully cleaned up all ghost gas outages from DB.');
