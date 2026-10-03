import fs from 'fs';

const db = JSON.parse(fs.readFileSync('data/local_db.json', 'utf8'));
const gasOutages = db.outages.filter(o => o.utility_type === 'gas' || (o.provider && o.provider.toLowerCase().includes('газ')));
console.log('Total gas outages in DB:', gasOutages.length);

for (const o of gasOutages) {
  console.log({
    id: o.id,
    city: o.city,
    provider: o.provider,
    url: o.source_url,
    streets: o.affected_streets,
    raw: o.raw_location_text?.slice(0, 100)
  });
}
