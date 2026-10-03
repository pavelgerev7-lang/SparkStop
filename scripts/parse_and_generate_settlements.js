import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const csvPath = path.join(rootDir, 'data', 'settlements_loc.csv');
const outJsonPath = path.join(rootDir, 'data', 'bulgarian_settlements_full.json');

if (!fs.existsSync(csvPath)) {
  console.error('CSV file not found at:', csvPath);
  process.exit(1);
}

const content = fs.readFileSync(csvPath, 'utf8');
const lines = content.split('\n');

const settlements = [];
const addedKeys = new Set();

console.log('Total raw lines:', lines.length);

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  // Format: "village","name","ekatte","province","municipality","postal code","municipality code","geo"
  const regex = /(?:^|,)(?:"([^"]*)"|([^,]*))/g;
  const parts = [];
  let match;
  while ((match = regex.exec(line)) !== null) {
    if (match.index === regex.lastIndex) regex.lastIndex++;
    parts.push(match[1] !== undefined ? match[1] : match[2]);
  }

  if (parts.length < 8) continue;

  const isVillage = parts[0] === '1';
  const name = (parts[1] || '').trim();
  const ekatte = (parts[2] || '').trim();
  let province = (parts[3] || '').trim();
  let municipality = (parts[4] || '').trim();
  const postalCode = (parts[5] || '').trim();
  const geo = (parts[7] || '').trim();

  if (!name || !province) continue;

  // Clean province name formatting
  if (province.toLowerCase() === 'софия') province = 'София-град';
  if (province.toLowerCase() === 'софия (област)') province = 'София-област';

  let lat = 42.6977;
  let lng = 23.3219;
  if (geo && geo.includes(',')) {
    const [gLng, gLat] = geo.split(',').map(s => parseFloat(s.trim()));
    if (!isNaN(gLat) && !isNaN(gLng)) {
      lat = gLat;
      lng = gLng;
    }
  }

  const type = isVillage ? 'с.' : 'гр.';
  const key = `${type}_${name}_${municipality}_${province}`.toLowerCase();

  if (!addedKeys.has(key)) {
    addedKeys.add(key);
    settlements.push({
      name,
      type,
      ekatte,
      postal_code: postalCode,
      municipality,
      region: province,
      lat,
      lng
    });
  }
}

console.log(`Successfully processed ${settlements.length} official Bulgarian settlements!`);

// Sort major cities first, then alphabetically
settlements.sort((a, b) => {
  const majorCities = ['София', 'Пловдив', 'Варна', 'Бургас', 'Русе', 'Стара Загора', 'Плевен', 'Сливен', 'Добрич', 'Шумен', 'Перник', 'Хасково', 'Ямбол', 'Пазарджик', 'Благоевград', 'Велико Търново', 'Враца', 'Габрово', 'Видин', 'Асеновград', 'Казанлък', 'Кърджали', 'Кюстендил', 'Монтана', 'Търговище', 'Силистра', 'Ловеч', 'Разград', 'Смолян'];
  const aIdx = majorCities.indexOf(a.name);
  const bIdx = majorCities.indexOf(b.name);
  if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
  if (aIdx !== -1) return -1;
  if (bIdx !== -1) return 1;
  if (a.type !== b.type) return a.type === 'гр.' ? -1 : 1;
  return a.name.localeCompare(b.name, 'bg');
});

fs.writeFileSync(outJsonPath, JSON.stringify(settlements, null, 2), 'utf8');
console.log(`Saved full registry to ${outJsonPath}`);
