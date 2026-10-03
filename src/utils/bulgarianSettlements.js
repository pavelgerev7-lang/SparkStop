import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ownValue } from './ownValue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');

export const BULGARIAN_PROVINCES = [
  'Благоевград', 'Бургас', 'Варна', 'Велико Търново', 'Видин', 'Враца',
  'Габрово', 'Добрич', 'Кърджали', 'Кюстендил', 'Ловеч', 'Монтана',
  'Пазарджик', 'Перник', 'Плевен', 'Пловдив', 'Разград', 'Русе',
  'Силистра', 'Сливен', 'Смолян', 'София-град', 'София-област', 'Стара Загора',
  'Търговище', 'Хасково', 'Шумен', 'Ямбол'
];

export const BULGARIAN_MUNICIPALITIES_BY_PROVINCE = {
  'Благоевград': ['Благоевград', 'Банско', 'Белица', 'Гоце Делчев', 'Гърмен', 'Кресна', 'Петрич', 'Разлог', 'Сандански', 'Сатовча', 'Симитли', 'Струмяни', 'Хаджидимово', 'Якоруда'],
  'Бургас': ['Бургас', 'Айтос', 'Камено', 'Карнобат', 'Малко Търново', 'Несебър', 'Поморие', 'Приморско', 'Руен', 'Созопол', 'Средец', 'Сунгурларе', 'Царево'],
  'Варна': ['Варна', 'Аврен', 'Аксаково', 'Белослав', 'Бяла', 'Ветрино', 'Вълчи дол', 'Девня', 'Долни чифлик', 'Дългопол', 'Провадия', 'Суворово'],
  'Велико Търново': ['Велико Търново', 'Горна Оряховица', 'Елена', 'Златарица', 'Лясковец', 'Павликени', 'Полски Тръмбеш', 'Свищов', 'Стражица', 'Сухиндол'],
  'Видин': ['Видин', 'Белоградчик', 'Бойница', 'Брегово', 'Грамада', 'Димово', 'Кула', 'Макреш', 'Ново село', 'Ружинци', 'Чупрене'],
  'Враца': ['Враца', 'Борован', 'Бяла Слатина', 'Козлодуй', 'Криводол', 'Мездра', 'Мизия', 'Оряхово', 'Роман', 'Хайредин'],
  'Габрово': ['Габрово', 'Дряново', 'Севлиево', 'Трявна'],
  'Добрич': ['Добрич-град', 'Добричка', 'Балчик', 'Генерал Тошево', 'Каварна', 'Крушари', 'Тервел', 'Шабла'],
  'Кърджали': ['Кърджали', 'Ардино', 'Джебел', 'Кирково', 'Крумовград', 'Момчилград', 'Черноочене'],
  'Кюстендил': ['Кюстендил', 'Бобов дол', 'Бобошево', 'Дупница', 'Кочериново', 'Невестино', 'Рила', 'Сапарева баня', 'Трекляно'],
  'Ловеч': ['Ловеч', 'Априлци', 'Летница', 'Луковит', 'Тетевен', 'Троян', 'Угърчин', 'Ябланица'],
  'Монтана': ['Монтана', 'Берковица', 'Бойчиновци', 'Брусарци', 'Вълчедръм', 'Вършец', 'Георги Дамяново', 'Лом', 'Медковец', 'Чипровци', 'Якимово'],
  'Пазарджик': ['Пазарджик', 'Батак', 'Белово', 'Брацигово', 'Велинград', 'Лесичово', 'Панагюрище', 'Пещера', 'Ракитово', 'Септември', 'Стрелча', 'Сърница'],
  'Перник': ['Перник', 'Брезник', 'Земен', 'Ковачевци', 'Радомир', 'Трън'],
  'Плевен': ['Плевен', 'Белене', 'Гулянци', 'Долна Митрополия', 'Долни Дъбник', 'Искър', 'Кнежа', 'Левски', 'Никопол', 'Пордим', 'Червен бряг'],
  'Пловдив': ['Пловдив', 'Асеновград', 'Брезово', 'Калояново', 'Карлово', 'Кричим', 'Куклен', 'Лъки', 'Марица', 'Перущица', 'Първомай', 'Раковски', 'Родопи', 'Садово', 'Сопот', 'Стамболийски', 'Съединение', 'Хисаря'],
  'Разград': ['Разград', 'Завет', 'Исперих', 'Кубрат', 'Лозница', 'Самуил', 'Цар Калоян'],
  'Русе': ['Русе', 'Борово', 'Бяла', 'Ветово', 'Две могили', 'Иваново', 'Сливо поле', 'Ценово'],
  'Силистра': ['Силистра', 'Алфатар', 'Главиница', 'Дулово', 'Кайнарджа', 'Ситово', 'Тутракан'],
  'Сливен': ['Сливен', 'Котел', 'Нова Загора', 'Твърдица'],
  'Смолян': ['Смолян', 'Баните', 'Борино', 'Девин', 'Доспат', 'Златоград', 'Мадан', 'Неделино', 'Рудозем', 'Чепеларе'],
  'София-град': ['Столична'],
  'София-област': ['Антон', 'Божурище', 'Ботевград', 'Годеч', 'Горна Малина', 'Долна баня', 'Драгоман', 'Елин Пелин', 'Етрополе', 'Златица', 'Ихтиман', 'Копривщица', 'Костенец', 'Костинброд', 'Мирково', 'Пирдоп', 'Правец', 'Самоков', 'Своге', 'Сливница', 'Чавдар', 'Челопеч'],
  'Стара Загора': ['Стара Загора', 'Братя Даскалови', 'Гурково', 'Гълъбово', 'Казанлък', 'Мъглиж', 'Николаево', 'Опан', 'Павел баня', 'Раднево', 'Чирпан'],
  'Търговище': ['Търговище', 'Антоново', 'Омуртаг', 'Опака', 'Попово'],
  'Хасково': ['Хасково', 'Димитровград', 'Ивайловград', 'Любимец', 'Маджарово', 'Минерални бани', 'Свиленград', 'Симеоновград', 'Стамболово', 'Тополовград', 'Харманли'],
  'Шумен': ['Шумен', 'Венец', 'Върбица', 'Каолиново', 'Каспичан', 'Никола Козлево', 'Нови пазар', 'Смядово', 'Хитрино'],
  'Ямбол': ['Ямбол', 'Болярово', 'Елхово', 'Стралджа', 'Тунджа']
};

/**
 * Load complete National Registry of 5,265 settlements
 */
let settlementsData = [];
const fullJsonPath = path.join(rootDir, 'data', 'bulgarian_settlements_full.json');

try {
  if (fs.existsSync(fullJsonPath)) {
    settlementsData = JSON.parse(fs.readFileSync(fullJsonPath, 'utf8'));
  }
} catch (e) {
  console.warn('Could not load full settlements JSON, using built-in array:', e.message);
}

if (!settlementsData || settlementsData.length === 0) {
  settlementsData = [
    { name: 'София', type: 'гр.', municipality: 'Столична', region: 'София-град', lat: 42.6977, lng: 23.3219 },
    { name: 'Пловдив', type: 'гр.', municipality: 'Пловдив', region: 'Пловдив', lat: 42.1354, lng: 24.7453 },
    { name: 'Варна', type: 'гр.', municipality: 'Варна', region: 'Варна', lat: 43.2141, lng: 27.9147 },
    { name: 'Бургас', type: 'гр.', municipality: 'Бургас', region: 'Бургас', lat: 42.5048, lng: 27.4626 },
    { name: 'Караисен', type: 'с.', municipality: 'Павликени', region: 'Велико Търново', lat: 43.3747, lng: 25.3416 }
  ];
}

export const BULGARIAN_SETTLEMENTS = settlementsData;

export function getMunicipalitiesByProvince(province) {
  if (!province) return [];
  const cleanP = province.trim();
  return ownValue(BULGARIAN_MUNICIPALITIES_BY_PROVINCE, cleanP) || [];
}

export function searchProvinces(query = '', limit = 10) {
  const cleanQ = (query || '').trim().toLowerCase();
  if (!cleanQ) return BULGARIAN_PROVINCES.slice(0, limit);
  return BULGARIAN_PROVINCES
    .filter(p => p.toLowerCase().includes(cleanQ))
    .slice(0, limit);
}

export function searchMunicipalities(query = '', province = '', limit = 15) {
  const cleanQ = (query || '').trim().toLowerCase();
  const cleanP = (province || '').trim();

  let list = [];
  if (cleanP && ownValue(BULGARIAN_MUNICIPALITIES_BY_PROVINCE, cleanP)) {
    list = ownValue(BULGARIAN_MUNICIPALITIES_BY_PROVINCE, cleanP).map(m => ({
      name: m,
      province: cleanP
    }));
  } else {
    for (const [prov, munis] of Object.entries(BULGARIAN_MUNICIPALITIES_BY_PROVINCE)) {
      if (!cleanP || prov.toLowerCase().includes(cleanP.toLowerCase())) {
        for (const m of munis) {
          list.push({ name: m, province: prov });
        }
      }
    }
  }

  if (!cleanQ) return list.slice(0, limit);
  return list.filter(item => item.name.toLowerCase().includes(cleanQ)).slice(0, limit);
}

export function getSettlementsByAdmin(province = '', municipality = '', query = '') {
  const cleanQ = (query || '').trim().toLowerCase().replace(/^(?:гр\.\s*|с\.\s*|к\.к\.\s*|село\s+|град\s+)/i, '');
  const cleanP = (province || '').trim().toLowerCase();
  const cleanM = (municipality || '').trim().toLowerCase();

  return BULGARIAN_SETTLEMENTS.filter(s => {
    const matchP = !cleanP || s.region.toLowerCase() === cleanP || s.region.toLowerCase().includes(cleanP);
    const matchM = !cleanM || (s.municipality && (s.municipality.toLowerCase() === cleanM || s.municipality.toLowerCase().includes(cleanM)));
    const matchQ = !cleanQ || s.name.toLowerCase().includes(cleanQ);
    return matchP && matchM && matchQ;
  }).map(formatSettlementOutput);
}

/**
 * Searches Bulgarian settlements with optional province and municipality filtering
 */
export function searchSettlements(query = '', limit = 25, province = '', municipality = '') {
  const cleanQ = (query || '').trim().toLowerCase()
    .replace(/^(?:гр\.\s*|с\.\s*|к\.к\.\s*|кв\.\s*|село\s+|град\s+)/i, '')
    .trim();
  const cleanP = (province || '').trim().toLowerCase();
  const cleanM = (municipality || '').trim().toLowerCase();

  const results = [];
  const addedKeys = new Set();

  for (const s of BULGARIAN_SETTLEMENTS) {
    if (cleanP && s.region.toLowerCase() !== cleanP && !s.region.toLowerCase().includes(cleanP)) continue;
    if (cleanM && s.municipality && s.municipality.toLowerCase() !== cleanM && !s.municipality.toLowerCase().includes(cleanM)) continue;

    const sName = s.name.toLowerCase();
    const sMuni = (s.municipality || '').toLowerCase();
    const sReg = (s.region || '').toLowerCase();

    let score = 0;

    if (!cleanQ) {
      score = 50;
    } else if (sName === cleanQ) {
      score = 200;
    } else if (sName.startsWith(cleanQ)) {
      score = 150 - (sName.length - cleanQ.length);
    } else if (sName.includes(cleanQ)) {
      score = 100;
    } else if (sMuni.startsWith(cleanQ)) {
      score = 70;
    } else if (sReg.startsWith(cleanQ)) {
      score = 50;
    }

    if (score > 0) {
      const key = `${s.type}_${s.name}_${s.municipality}_${s.region}`.toLowerCase();
      if (!addedKeys.has(key)) {
        addedKeys.add(key);
        results.push({
          score,
          data: formatSettlementOutput(s)
        });
      }
    }
  }

  // Sort by highest relevance score
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map(r => r.data);
}

function formatSettlementOutput(s) {
  const typePrefix = s.type ? `${s.type} ` : '';
  const fullName = `${typePrefix}${s.name}`;
  const muniLabel = s.municipality ? `общ. ${s.municipality}` : '';
  const regLabel = s.region ? `обл. ${s.region}` : '';
  const adminLabel = [muniLabel, regLabel].filter(Boolean).join(', ');

  return {
    name: s.name,
    type: s.type || 'гр.',
    full_name: fullName,
    municipality: s.municipality || s.name,
    region: s.region || s.name,
    display_label: adminLabel ? `${fullName} (${adminLabel})` : fullName,
    admin_detail: adminLabel,
    lat: s.lat,
    lng: s.lng
  };
}
