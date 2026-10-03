export function extractStreetsHeuristic(text) {
  const streets = [];
  const stopWords = ['ще', 'поради', 'от', 'до', 'във', 'в', 'като', 'за', 'с', 'на', '№', 'номер', 'бл', 'блок', 'се', 'очаква', 'водоподаването', 'е', 'са', 'част', 'и'];
  
  // Cyrillic-safe prefix boundary
  const regex = /(?:^|[\s,.;:("„«/–—-])(ул\.?|улица|бул\.?|булевард|кв\.?|квартал|ж\.?к\.?|с\.|село|местност|м-т)\s*["'„”«»]?\s*([А-Яа-яA-Za-z0-9.\-\s]+?)(?=[,.;:\n\r\t/–—-]|\s+(?:ще|поради|от|до|във|в|като|за|с|на|№|\d{1,4}\b|се|очаква|водоподаването|е|са|част|и\s+(?:ул|бул|кв|жк|с\.))\b|$)/gi;
  
  let match;
  while ((match = regex.exec(text)) !== null) {
    const prefix = match[1].trim();
    let nameRaw = match[2].replace(/["'„”«»]/g, '').replace(/\s+/g, ' ').trim();
    nameRaw = nameRaw.replace(/[,.;:\-/–—]+$/, '').trim();
    
    const parts = nameRaw.split(' ');
    const nameParts = [];
    
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].toLowerCase().replace(/[,.;:]+$/, '');
      if (stopWords.includes(p)) break;
      nameParts.push(parts[i]);
    }
    
    if (nameParts.length > 0) {
      let cleanStreet = `${prefix} ${nameParts.join(' ')}`.trim();
      cleanStreet = cleanStreet.replace(/[,.;:\-/–—]+$/, '').trim();
      if (cleanStreet.length > 3 && !streets.includes(cleanStreet)) {
        streets.push(cleanStreet);
      }
    }
  }

  if (streets.length === 0) {
    streets.push('Централна градска част');
  }

  return streets;
}

const sample1 = 'Съобщение (22 авг. 2026): Днес 22.08.2026 г. поради удължаване на ремонтните дейности на кръстовището на ул. Самара и ул. Генерал Драгомиров, ще бъде спряно водоподаването и към високите части на кв.Б.Българанов, като се очаква да бъде отстранена аварията до 21:00 часа.';
const sample2 = 'Съобщение (22 авг. 2026): Днес 22.08.2026 г. поради възникнала авария на ул. Генерал Драгомиров 154 в кв. Боян Българанов ще бъде спряно водоподаването в района на ул. Генерал Драгомиров, ул. Генерал Тотлебен, ул. Дунав, ул. Бели Лом, ул. Искър и част от местност „Под манастира“ от 12:00 часа до 19:00 часа.';

console.log('Sample 1 Streets:', extractStreetsHeuristic(sample1));
console.log('Sample 2 Streets:', extractStreetsHeuristic(sample2));
