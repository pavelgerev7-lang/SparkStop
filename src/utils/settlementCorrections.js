// Corrections to the settlement registry, each verified against OpenStreetMap on 2026-09-24/26
// (a full pass over every settlement the live map showed: 361 of 414 already agreed within 3 km;
// these are the ones that did not). Keys are "<lower-case name>|<lower-case province>".

// The name a provider writes -> the registry's own spelling.
export const SETTLEMENT_ALIASES = {
  'васил друмево|шумен': 'васил друмев',
  'ламбриново|силистра': 'полковник ламбриново',
  'иширково|силистра': 'професор иширково',
  'дедево|пловдив': 'дедово',
  // The registry spells the village with its definite article.
  'чукили|габрово': 'чукилите',
  'врабци|габрово': 'врабците',
  'ясени|габрово': 'ясените',
  // OSM: "Горна Хаджийска", община Златарица.
  'хаджийска|велико търново': 'горна хаджийска',
  // ВиК Добрич writes "с. Вичево"; the village of община Генерал Тошево is Вичово.
  'вичево|добрич': 'вичово'
};

// The registry has the wrong coordinates, or lacks the village.
export const SETTLEMENT_OVERRIDES = {
  // Registry: 43.1833, 27.4667 — 24 km from the village.
  'добротич|варна': { lat: 43.3955, lng: 27.4249, name: 'Добротич', region: 'Варна', municipality: 'Вълчи дол', type: 'с.' },
  // Registry: 41.8467, 25.9117 — 11 km from the village.
  'славяново|хасково': { lat: 41.8074, lng: 25.7825, name: 'Славяново', region: 'Хасково', municipality: 'Харманли', type: 'с.' },
  // Not in the registry (Птичево, община Омуртаг).
  'средище|търговище': { lat: 43.0602, lng: 26.2965, name: 'Средище', region: 'Търговище', municipality: 'Омуртаг', type: 'с.' },
  // Not in the registry (OSM: м. Янкула, Горнова могила, община Габрово).
  'янкула|габрово': { lat: 42.8510, lng: 25.2577, name: 'Янкула', region: 'Габрово', municipality: 'Габрово', type: 'с.' },
  // Not in the registry (OSM: Гургулят, община Сливница) — EVN/Електрохолд list it under "София-област".
  'гургулят|софия-град': { lat: 42.7913, lng: 22.9757, name: 'Гургулят', region: 'София-град', municipality: 'Сливница', type: 'с.' },
  // The resort (курортен комплекс Слънчев бряг, община Несебър) is not a registry settlement of its own;
  // EVN lists sites there ("гр. Слънчев Бряг Общежитие Лале").
  'слънчев бряг|бургас': { lat: 42.6939, lng: 27.7105, name: 'Слънчев бряг', region: 'Бургас', municipality: 'Несебър', type: 'гр.' }
};

// Registry positions that were WRONG until 2026-09-26 (68 villages moved to their OpenStreetMap position). A street lookup that
// failed used to be cached as "the settlement centre" — i.e. as one of these old points; such a cached point is now dropped
// and looked up again instead of being trusted as a real street position.
export const SUPERSEDED_SETTLEMENT_POINTS = [
  [42.0333, 23.6667],
  [42.920842, 25.538921],
  [43.4833, 28.2167],
  [41.9833, 23.6667],
  [43.544029, 28.364501],
  [41.4774, 23.1798],
  [42.9333, 26.1167],
  [42.048388, 23.131804],
  [41.7167, 25.6333],
  [41.5167, 24.6667],
  [42.152056, 25.908983],
  [42.5333, 24.0167],
  [41.5333, 24.9167],
  [41.6833, 25.4333],
  [43.9333, 27.4333],
  [42.87766, 25.523224],
  [41.4167, 23.0167],
  [43.2407, 25.9333],
  [42.271584, 24.943104],
  [43.8833, 27.3667],
  [42.574, 23.0744],
  [43.7167, 27.5333],
  [43.2333, 26.4833],
  [42.8705, 25.8885],
  [42.067908, 22.739247],
  [41.5667, 25.3833],
  [43.5167, 26.5417],
  [42.9667, 24.2333],
  [42.5778, 25.3926],
  [42.9833, 27.7167],
  [43.9333, 26.9833],
  [43.1833, 27.4667],
  [41.526445, 25.611899],
  [41.9833, 23.2667],
  [42.87211, 25.918408],
  [42.6167, 23.1833],
  [42.9667, 25.0333],
  [42.6667, 25.6333],
  [43.7833, 27.3167],
  [41.417487, 25.586133],
  [43.7833, 28.0833],
  [43.1333, 26.0667],
  [43.2778, 26.9444],
  [43.9667, 27.0667],
  [43.1333, 26.2833],
  [41.476411, 25.742549],
  [41.8667, 23.1833],
  [43.6833, 27.3667],
  [43.7306, 26.8667],
  [42.9167, 27.0833],
  [42.816667, 25.6],
  [43.2667, 26.1833],
  [41.8467, 25.9117],
  [42.8937, 27.2021],
  [42.9167, 26.1333],
  [42.4167, 25.8833],
  [42.075885, 22.721113],
  [42.5667, 23.6333],
  [42.627407, 23.583115],
  [43.8095, 27.6429],
  [42.9167, 23.8333],
  [42.8833, 23.3833]
];
