import axios from 'axios';
import { ownValue } from '../utils/ownValue.js';

/**
 * Exhaustive List of Bulgarian Regional, Municipal Cities, Towns and Villages with Coordinates
 */
export const BULGARIAN_CITIES = [
  // Major Regional Cities
  { name: 'София', type: 'град', region: 'София-град', lat: 42.6977, lng: 23.3219 },
  { name: 'Пловдив', type: 'град', region: 'Пловдив', lat: 42.1354, lng: 24.7453 },
  { name: 'Варна', type: 'град', region: 'Варна', lat: 43.2141, lng: 27.9147 },
  { name: 'Бургас', type: 'град', region: 'Бургас', lat: 42.5048, lng: 27.4626 },
  { name: 'Русе', type: 'град', region: 'Русе', lat: 43.8564, lng: 25.9704 },
  { name: 'Стара Загора', type: 'град', region: 'Стара Загора', lat: 42.4258, lng: 25.6345 },
  { name: 'Плевен', type: 'град', region: 'Плевен', lat: 43.4170, lng: 24.6067 },
  { name: 'Сливен', type: 'град', region: 'Сливен', lat: 42.6817, lng: 26.3228 },
  { name: 'Добрич', type: 'град', region: 'Добрич', lat: 43.5726, lng: 27.8273 },
  { name: 'Шумен', type: 'град', region: 'Шумен', lat: 43.2712, lng: 26.9361 },
  { name: 'Перник', type: 'град', region: 'Перник', lat: 42.6052, lng: 23.0378 },
  { name: 'Хасково', type: 'град', region: 'Хасково', lat: 41.9344, lng: 25.5556 },
  { name: 'Ямбол', type: 'град', region: 'Ямбол', lat: 42.4828, lng: 26.5033 },
  { name: 'Пазарджик', type: 'град', region: 'Пазарджик', lat: 42.1928, lng: 24.3336 },
  { name: 'Благоевград', type: 'град', region: 'Благоевград', lat: 42.0209, lng: 23.0943 },
  { name: 'Велико Търново', type: 'град', region: 'Велико Търново', lat: 43.0757, lng: 25.6172 },
  { name: 'Габрово', type: 'град', region: 'Габрово', lat: 42.8742, lng: 25.3187 },
  { name: 'Враца', type: 'град', region: 'Враца', lat: 43.2102, lng: 23.5529 },
  { name: 'Казанлък', type: 'град', region: 'Стара Загора', lat: 42.6194, lng: 25.3929 },
  { name: 'Видин', type: 'град', region: 'Видин', lat: 43.9962, lng: 22.8679 },
  { name: 'Кърджали', type: 'град', region: 'Кърджали', lat: 41.6500, lng: 25.3667 },
  { name: 'Кюстендил', type: 'град', region: 'Кюстендил', lat: 42.2839, lng: 22.6914 },
  { name: 'Монтана', type: 'град', region: 'Монтана', lat: 43.4085, lng: 23.2257 },
  { name: 'Търговище', type: 'град', region: 'Търговище', lat: 43.2506, lng: 26.5722 },
  { name: 'Димитровград', type: 'град', region: 'Хасково', lat: 42.0578, lng: 25.5961 },
  { name: 'Силистра', type: 'град', region: 'Силистра', lat: 44.1147, lng: 27.2672 },
  { name: 'Ловеч', type: 'град', region: 'Ловеч', lat: 43.1370, lng: 24.7142 },
  { name: 'Дупница', type: 'град', region: 'Кюстендил', lat: 42.2644, lng: 23.1178 },
  { name: 'Разград', type: 'град', region: 'Разград', lat: 43.5256, lng: 26.5250 },
  { name: 'Горна Оряховица', type: 'град', region: 'Велико Търново', lat: 43.1278, lng: 25.7000 },
  { name: 'Смолян', type: 'град', region: 'Смолян', lat: 41.5744, lng: 24.7128 },
  { name: 'Петрич', type: 'град', region: 'Благоевград', lat: 41.3983, lng: 23.2072 },
  { name: 'Сандански', type: 'град', region: 'Благоевград', lat: 41.5644, lng: 23.2783 },
  { name: 'Самоков', type: 'град', region: 'София-област', lat: 42.3375, lng: 23.5606 },
  { name: 'Свищов', type: 'град', region: 'Велико Търново', lat: 43.6167, lng: 25.3500 },
  { name: 'Лом', type: 'град', region: 'Монтана', lat: 43.8253, lng: 23.2369 },
  { name: 'Карлово', type: 'град', region: 'Пловдив', lat: 42.6433, lng: 24.8089 },
  { name: 'Велинград', type: 'град', region: 'Пазарджик', lat: 42.0275, lng: 23.9914 },
  { name: 'Нова Загора', type: 'град', region: 'Сливен', lat: 42.4914, lng: 26.0139 },
  { name: 'Троян', type: 'град', region: 'Ловеч', lat: 42.8947, lng: 24.7119 },
  { name: 'Асеновград', type: 'град', region: 'Пловдив', lat: 42.0108, lng: 24.8778 },
  { name: 'Ботевград', type: 'град', region: 'София-област', lat: 42.9078, lng: 23.7936 },
  { name: 'Пещера', type: 'град', region: 'Пазарджик', lat: 42.0333, lng: 24.3000 },
  { name: 'Поморие', type: 'град', region: 'Бургас', lat: 42.5583, lng: 27.6439 },
  { name: 'Несебър', type: 'град', region: 'Бургас', lat: 42.6592, lng: 27.7189 },
  { name: 'Созопол', type: 'град', region: 'Бургас', lat: 42.4178, lng: 27.6953 },
  { name: 'Банско', type: 'град', region: 'Благоевград', lat: 41.8383, lng: 23.4883 },
  { name: 'Разлог', type: 'град', region: 'Благоевград', lat: 41.8867, lng: 23.4667 },
  { name: 'Балчик', type: 'град', region: 'Добрич', lat: 43.4167, lng: 28.1667 },
  { name: 'Каварна', type: 'град', region: 'Добрич', lat: 43.4333, lng: 28.3333 },
  { name: 'Царево', type: 'град', region: 'Бургас', lat: 42.1667, lng: 27.8500 },
  { name: 'Приморско', type: 'град', region: 'Бургас', lat: 42.2667, lng: 27.7500 },
  { name: 'Свети Влас', type: 'град', region: 'Бургас', lat: 42.7139, lng: 27.7589 },
  { name: 'Бяла', type: 'град', region: 'Варна', lat: 42.8750, lng: 27.8889 },
  { name: 'Провадия', type: 'град', region: 'Варна', lat: 43.1833, lng: 27.4333 },
  { name: 'Елин Пелин', type: 'град', region: 'София-област', lat: 42.6667, lng: 23.6000 },
  { name: 'Костинброд', type: 'град', region: 'София-област', lat: 42.8167, lng: 23.2167 },
  { name: 'Своге', type: 'град', region: 'София-област', lat: 42.9667, lng: 23.3500 },
  { name: 'Ихтиман', type: 'град', region: 'София-област', lat: 42.4333, lng: 23.8167 },
  { name: 'Костенец', type: 'град', region: 'София-област', lat: 42.3000, lng: 23.8667 },
  { name: 'Тетевен', type: 'град', region: 'Ловеч', lat: 42.9167, lng: 24.2667 },
  { name: 'Севлиево', type: 'град', region: 'Габрово', lat: 43.0250, lng: 25.1111 },
  { name: 'Трявна', type: 'град', region: 'Габрово', lat: 42.8667, lng: 25.5000 },
  { name: 'Панагюрище', type: 'град', region: 'Пазарджик', lat: 42.5000, lng: 24.1833 },
  { name: 'Харманли', type: 'град', region: 'Хасково', lat: 41.9333, lng: 25.9000 },
  { name: 'Свиленград', type: 'град', region: 'Хасково', lat: 41.7667, lng: 26.2000 },
  { name: 'Попово', type: 'град', region: 'Търговище', lat: 43.3500, lng: 26.2333 },
  { name: 'Радомир', type: 'град', region: 'Перник', lat: 42.5500, lng: 22.9667 },
  { name: 'Козлодуй', type: 'град', region: 'Враца', lat: 43.7833, lng: 23.7333 },
  { name: 'Мездра', type: 'град', region: 'Враца', lat: 43.1500, lng: 23.7167 },
  { name: 'Берковица', type: 'град', region: 'Монтана', lat: 43.2333, lng: 23.1333 },
  { name: 'Червен бряг', type: 'град', region: 'Плевен', lat: 43.2750, lng: 24.0833 },
  { name: 'Левски', type: 'град', region: 'Плевен', lat: 43.3667, lng: 25.1333 },
  { name: 'Павликени', type: 'град', region: 'Велико Търново', lat: 43.2333, lng: 25.3000 },
  { name: 'Елена', type: 'град', region: 'Велико Търново', lat: 42.9333, lng: 25.8833 },
  { name: 'Дебелец', type: 'град', region: 'Велико Търново', lat: 43.0333, lng: 25.6167 },
  { name: 'Килифарево', type: 'град', region: 'Велико Търново', lat: 42.9833, lng: 25.6333 },
  { name: 'Чирпан', type: 'град', region: 'Стара Загора', lat: 42.2000, lng: 25.3333 },
  { name: 'Раднево', type: 'град', region: 'Стара Загора', lat: 42.2833, lng: 25.9333 },
  { name: 'Гълъбово', type: 'град', region: 'Стара Загора', lat: 42.1500, lng: 26.0167 },
  { name: 'Тополовград', type: 'град', region: 'Хасково', lat: 42.0833, lng: 26.3333 },
  { name: 'Елхово', type: 'град', region: 'Ямбол', lat: 42.1667, lng: 26.5667 },
  { name: 'Стралджа', type: 'град', region: 'Ямбол', lat: 42.6000, lng: 26.6833 },
  { name: 'Карнобат', type: 'град', region: 'Бургас', lat: 42.6500, lng: 27.0000 },
  { name: 'Айтос', type: 'град', region: 'Бургас', lat: 42.7000, lng: 27.2500 },
  { name: 'Средец', type: 'град', region: 'Бургас', lat: 42.3500, lng: 27.1833 },
  { name: 'Раковски', type: 'град', region: 'Пловдив', lat: 42.3000, lng: 24.9667 },
  { name: 'Стамболийски', type: 'град', region: 'Пловдив', lat: 42.1333, lng: 24.5333 },
  { name: 'Кричим', type: 'град', region: 'Пловдив', lat: 42.0500, lng: 24.4667 },
  { name: 'Перущица', type: 'град', region: 'Пловдив', lat: 42.0500, lng: 24.5500 },
  { name: 'Съединение', type: 'град', region: 'Пловдив', lat: 42.2667, lng: 24.5500 },
  { name: 'Хисаря', type: 'град', region: 'Пловдив', lat: 42.5000, lng: 24.7000 },
  { name: 'Сопот', type: 'град', region: 'Пловдив', lat: 42.6500, lng: 24.7500 },
  { name: 'Батак', type: 'град', region: 'Пазарджик', lat: 41.9500, lng: 24.2167 },
  { name: 'Септември', type: 'град', region: 'Пазарджик', lat: 42.2167, lng: 24.1000 },
  { name: 'Белово', type: 'град', region: 'Пазарджик', lat: 42.2167, lng: 24.0167 },
  { name: 'Ракитово', type: 'град', region: 'Пазарджик', lat: 41.9833, lng: 24.0833 },
  { name: 'Стрелча', type: 'град', region: 'Пазарджик', lat: 42.5000, lng: 24.3167 },
  { name: 'Гоце Делчев', type: 'град', region: 'Благоевград', lat: 41.5667, lng: 23.7333 },
  { name: 'Симитли', type: 'град', region: 'Благоевград', lat: 41.8833, lng: 23.1167 },
  { name: 'Кресна', type: 'град', region: 'Благоевград', lat: 41.7333, lng: 23.1500 },
  { name: 'Белица', type: 'град', region: 'Благоевград', lat: 41.9500, lng: 23.5667 },
  { name: 'Якоруда', type: 'град', region: 'Благоевград', lat: 42.0167, lng: 23.6833 },
  { name: 'Сапарева баня', type: 'град', region: 'Кюстендил', lat: 42.2833, lng: 23.2667 },
  { name: 'Бобов дол', type: 'град', region: 'Кюстендил', lat: 42.3667, lng: 23.0167 },
  { name: 'Белоградчик', type: 'град', region: 'Видин', lat: 43.6167, lng: 22.6833 },
  { name: 'Кула', type: 'град', region: 'Видин', lat: 43.8833, lng: 22.5167 },
  { name: 'Вършец', type: 'град', region: 'Монтана', lat: 43.1833, lng: 23.2833 },
  { name: 'Бяла Слатина', type: 'град', region: 'Враца', lat: 43.4667, lng: 23.9333 },
  { name: 'Оряхово', type: 'град', region: 'Враца', lat: 43.7333, lng: 23.9667 },
  { name: 'Луковит', type: 'град', region: 'Ловеч', lat: 43.2000, lng: 24.1667 },
  { name: 'Дряново', type: 'град', region: 'Габрово', lat: 42.9833, lng: 25.4833 },
  { name: 'Кубрат', type: 'град', region: 'Разград', lat: 43.8000, lng: 26.5000 },
  { name: 'Исперих', type: 'град', region: 'Разград', lat: 43.7167, lng: 26.8333 },
  { name: 'Тутракан', type: 'град', region: 'Силистра', lat: 44.0500, lng: 26.6000 },
  { name: 'Дулово', type: 'град', region: 'Силистра', lat: 43.8167, lng: 27.1500 },
  { name: 'Нови пазар', type: 'град', region: 'Шумен', lat: 43.3500, lng: 27.2000 },
  { name: 'Велики Преслав', type: 'град', region: 'Шумен', lat: 43.1667, lng: 26.8167 },
  { name: 'Омуртаг', type: 'град', region: 'Търговище', lat: 43.1167, lng: 26.4167 },
  { name: 'Момчилград', type: 'град', region: 'Кърджали', lat: 41.5333, lng: 25.4167 },
  { name: 'Крумовград', type: 'град', region: 'Кърджали', lat: 41.4667, lng: 25.6500 },
  { name: 'Златоград', type: 'град', region: 'Смолян', lat: 41.3833, lng: 25.1000 },
  { name: 'Девин', type: 'град', region: 'Смолян', lat: 41.7500, lng: 24.4000 },
  { name: 'Чепеларе', type: 'град', region: 'Смолян', lat: 41.7333, lng: 24.6833 },
  { name: 'Мадан', type: 'град', region: 'Смолян', lat: 41.5000, lng: 24.9333 },
  { name: 'Рудозем', type: 'град', region: 'Смолян', lat: 41.4833, lng: 24.8500 },

  // Key Villages & Suburbs (Села и Предградия)
  { name: 'с. Драганово', type: 'село', region: 'Велико Търново (Горна Оряховица)', lat: 43.2167, lng: 25.7500 },
  { name: 'с. Царев брод', type: 'село', region: 'Шумен', lat: 43.3333, lng: 27.0167 },
  { name: 'с. Малки Чифлик', type: 'село', region: 'Велико Търново', lat: 43.0667, lng: 25.6833 },
  { name: 'с. Самоводене', type: 'село', region: 'Велико Търново', lat: 43.1333, lng: 25.6167 },
  { name: 'с. Шемшево', type: 'село', region: 'Велико Търново', lat: 43.0667, lng: 25.5667 },
  { name: 'с. Леденик', type: 'село', region: 'Велико Търново', lat: 43.0833, lng: 25.5500 },
  { name: 'с. Беляковец', type: 'село', region: 'Велико Търново', lat: 43.1000, lng: 25.5833 },
  { name: 'с. Присово', type: 'село', region: 'Велико Търново', lat: 43.0333, lng: 25.6500 },
  { name: 'с. Арбанаси', type: 'село', region: 'Велико Търново', lat: 43.0986, lng: 25.6694 },
  { name: 'с. Ресен', type: 'село', region: 'Велико Търново', lat: 43.2000, lng: 25.5500 },
  { name: 'с. Марково', type: 'село', region: 'Пловдив (Родопи)', lat: 42.0667, lng: 24.7000 },
  { name: 'с. Белащица', type: 'село', region: 'Пловдив (Родопи)', lat: 42.0667, lng: 24.7500 },
  { name: 'с. Браниполе', type: 'село', region: 'Пловдив (Родопи)', lat: 42.0833, lng: 24.7500 },
  { name: 'с. Брестник', type: 'село', region: 'Пловдив (Родопи)', lat: 42.0500, lng: 24.7833 },
  { name: 'с. Първенец', type: 'село', region: 'Пловдив (Родопи)', lat: 42.0833, lng: 24.6667 },
  { name: 'с. Крумово', type: 'село', region: 'Пловдив (Родопи)', lat: 42.0833, lng: 24.8333 },
  { name: 'с. Ягодово', type: 'село', region: 'Пловдив (Родопи)', lat: 42.1167, lng: 24.8500 },
  { name: 'с. Труд', type: 'село', region: 'Пловдив (Марица)', lat: 42.2333, lng: 24.7333 },
  { name: 'с. Граф Игнатиево', type: 'село', region: 'Пловдив (Марица)', lat: 42.2833, lng: 24.7500 },
  { name: 'с. Рогош', type: 'село', region: 'Пловдив (Марица)', lat: 42.1833, lng: 24.8667 },
  { name: 'с. Войводиново', type: 'село', region: 'Пловдив (Марица)', lat: 42.1833, lng: 24.7833 },
  { name: 'с. Калековец', type: 'село', region: 'Пловдив (Марица)', lat: 42.2333, lng: 24.8167 },
  { name: 'с. Царацово', type: 'село', region: 'Пловдив (Марица)', lat: 42.2000, lng: 24.6833 },
  { name: 'с. Лозен', type: 'село', region: 'София-град', lat: 42.6000, lng: 23.4833 },
  { name: 'с. Бистрица', type: 'село', region: 'София-град', lat: 42.5833, lng: 23.3667 },
  { name: 'с. Панчарево', type: 'село', region: 'София-град', lat: 42.5833, lng: 23.4167 },
  { name: 'с. Казичене', type: 'село', region: 'София-град', lat: 42.6667, lng: 23.4667 },
  { name: 'с. Герман', type: 'село', region: 'София-град', lat: 42.6167, lng: 23.4167 },
  { name: 'с. Владая', type: 'село', region: 'София-град', lat: 42.6333, lng: 23.2000 },
  { name: 'с. Иваняне', type: 'село', region: 'София-град', lat: 42.7000, lng: 23.1667 },
  { name: 'с. Мърчаево', type: 'село', region: 'София-град', lat: 42.5833, lng: 23.1833 },
  { name: 'с. Волуяк', type: 'село', region: 'София-град', lat: 42.7667, lng: 23.2500 },
  { name: 'с. Равно поле', type: 'село', region: 'София-област (Елин Пелин)', lat: 42.6667, lng: 23.5333 },
  { name: 'с. Нови хан', type: 'село', region: 'София-област (Елин Пелин)', lat: 42.6000, lng: 23.6000 },
  { name: 'с. Тополи', type: 'село', region: 'Варна', lat: 43.2167, lng: 27.8333 },
  { name: 'с. Звездица', type: 'село', region: 'Варна', lat: 43.1667, lng: 27.8667 },
  { name: 'с. Константиново', type: 'село', region: 'Варна', lat: 43.1667, lng: 27.7833 },
  { name: 'с. Приселци', type: 'село', region: 'Варна (Аврен)', lat: 43.0833, lng: 27.8667 },
  { name: 'с. Каменар', type: 'село', region: 'Варна', lat: 43.2500, lng: 27.9167 },
  { name: 'с. Кранево', type: 'село', region: 'Добрич (Балчик)', lat: 43.3333, lng: 28.0500 },
  { name: 'с. Шкорпиловци', type: 'село', region: 'Варна (Долни чифлик)', lat: 42.9667, lng: 27.9000 },
  { name: 'с. Равда', type: 'село', region: 'Бургас (Несебър)', lat: 42.6417, lng: 27.6750 },
  { name: 'с. Равадиново', type: 'село', region: 'Бургас (Созопол)', lat: 42.3833, lng: 27.6667 },
  { name: 'с. Лозенец', type: 'село', region: 'Бургас (Царево)', lat: 42.2167, lng: 27.8000 },
  { name: 'с. Синеморец', type: 'село', region: 'Бургас (Царево)', lat: 42.0611, lng: 27.9778 },
  { name: 'с. Ахтопол', type: 'град', region: 'Бургас (Царево)', lat: 42.1000, lng: 27.9333 },
  { name: 'с. Китен', type: 'град', region: 'Бургас (Приморско)', lat: 42.2333, lng: 27.7833 },
  { name: 'с. Баня', type: 'село', region: 'Благоевград (Разлог)', lat: 41.8833, lng: 23.5333 },
  { name: 'с. Добринище', type: 'град', region: 'Благоевград (Банско)', lat: 41.8167, lng: 23.5667 },
  { name: 'с. Бачево', type: 'село', region: 'Благоевград (Разлог)', lat: 41.9167, lng: 23.4500 }
];

/**
 * Searches Bulgarian settlements (cities, towns and villages) matching a query string
 * @param {string} query 
 */
export async function getSettlementSuggestions(query = '') {
  const cleanQ = (query || '').trim().toLowerCase().replace(/^(?:гр\.\s*|с\.\s*|гр\s+|с\s+|село\s+|град\s+)/i, '');
  if (!cleanQ) {
    return BULGARIAN_CITIES.slice(0, 15);
  }

  const results = BULGARIAN_CITIES.filter((c) => {
    const nameClean = c.name.toLowerCase().replace(/^(?:гр\.\s*|с\.\s*|гр\s+|с\s+|село\s+|град\s+)/i, '');
    const nameMatch = nameClean.includes(cleanQ) || c.name.toLowerCase().includes(cleanQ);
    const regionMatch = c.region && c.region.toLowerCase().includes(cleanQ);
    return nameMatch || regionMatch;
  });

  return results.slice(0, 20);
}

/**
 * Curated street database per major city for instant, ultra-fast autocomplete matching
 */
export const CITY_STREETS_DATABASE = {
  'София': [
    { street: 'бул. Витоша', district: 'Център / Триадица', lat: 42.6932, lng: 23.3204 },
    { street: 'бул. България', district: 'Триадица', lat: 42.6796, lng: 23.3186 },
    { street: 'бул. Цариградско шосе', district: 'Младост / Изгрев', lat: 42.6711, lng: 23.3705 },
    { street: 'ул. Иван Вазов', district: 'Средец', lat: 42.6966, lng: 23.3317 },
    { street: 'ул. Шипка', district: 'Оборище', lat: 42.6950, lng: 23.3380 },
    { street: 'ул. Георги С. Раковски', district: 'Център', lat: 42.6960, lng: 23.3270 },
    { street: 'бул. Васил Левски', district: 'Център', lat: 42.6940, lng: 23.3330 },
    { street: 'бул. Патриарх Евтимий', district: 'Център', lat: 42.6890, lng: 23.3210 },
    { street: 'ул. Граф Игнатиев', district: 'Център', lat: 42.6910, lng: 23.3260 },
    { street: 'бул. Княз Александър Дондуков', district: 'Център', lat: 42.6980, lng: 23.3320 },
    { street: 'бул. Сливница', district: 'Люлин / Илинден', lat: 42.7090, lng: 23.3100 },
    { street: 'бул. Тодор Александров', district: 'Възраждане', lat: 42.7010, lng: 23.3050 },
    { street: 'бул. Черни връх', district: 'Лозенец', lat: 42.6650, lng: 23.3170 },
    { street: 'ул. Оборище', district: 'Оборище', lat: 42.6960, lng: 23.3400 },
    { street: 'кв. Младост 1', district: 'Младост', lat: 42.6634, lng: 23.3738 },
    { street: 'кв. Младост 2', district: 'Младост', lat: 42.6520, lng: 23.3710 },
    { street: 'кв. Младост 3', district: 'Младост', lat: 42.6480, lng: 23.3790 },
    { street: 'кв. Младост 4', district: 'Младост', lat: 42.6390, lng: 23.3780 },
    { street: 'кв. Люлин 1', district: 'Люлин', lat: 42.7210, lng: 23.2450 },
    { street: 'кв. Люлин 5', district: 'Люлин', lat: 42.7150, lng: 23.2550 },
    { street: 'кв. Лозенец', district: 'Лозенец', lat: 42.6780, lng: 23.3280 },
    { street: 'кв. Студентски град', district: 'Студентски', lat: 42.6510, lng: 23.3440 },
    { street: 'ул. Гоце Делчев', district: 'Красно село', lat: 42.6740, lng: 23.2980 },
    { street: 'ул. Ерусалим', district: 'Младост 1', lat: 42.6620, lng: 23.3750 },
    // Added after confirming live: Топлофикация София's own bulletins
    // report almost every outage by кв./ж.к. name alone (no street), and
    // these particular districts were MISSING from this curated list
    // entirely — with no entry here, resolveExactCoordinates() fell through
    // to treating the bare district name as if it were a nationwide
    // settlement search. For "Дружба"/"Слатина" that silently matched an
    // unrelated same-named place elsewhere in Bulgaria (over 100km away);
    // for the rest it found nothing at all and collapsed onto Sofia's
    // generic city-center point — confirmed live, 57 of 76 active Sofia
    // heating outages (75%) were stacked on just 2 shared coordinates this
    // way. Гео Милев/Дружба 1/Мусагеница coordinates are taken from
    // Електрохолд's own real-time GIS feed (already geocoded precisely by
    // the source itself); the rest are approximate neighborhood centers, at
    // the same precision tier as every other district entry in this list.
    { street: 'Гео Милев', district: 'Гео Милев', lat: 42.6743, lng: 23.3676 },
    { street: 'Дружба 1', district: 'Дружба', lat: 42.6605, lng: 23.4017 },
    { street: 'Дружба 2', district: 'Дружба', lat: 42.6520, lng: 23.4100 },
    { street: 'Мусагеница', district: 'Мусагеница', lat: 42.6617, lng: 23.3632 },
    { street: 'Дианабад', district: 'Дианабад', lat: 42.6605, lng: 23.3480 },
    { street: 'Слатина', district: 'Слатина', lat: 42.6810, lng: 23.3620 },
    { street: 'Дървеница', district: 'Дървеница', lat: 42.6580, lng: 23.3570 },
    { street: 'Изток', district: 'Изток', lat: 42.6870, lng: 23.3450 },
    { street: 'Полигона', district: 'Полигона', lat: 42.6810, lng: 23.3160 },
    { street: 'Толстой', district: 'Толстой', lat: 42.6710, lng: 23.3110 },
    { street: 'Яворов', district: 'Яворов', lat: 42.6990, lng: 23.3510 }
  ],
  'Пловдив': [
    { street: 'Главна улица (ул. Княз Александър I)', district: 'Център', lat: 42.1460, lng: 24.7480 },
    { street: 'бул. Цар Борис III Обединител', district: 'Център', lat: 42.1440, lng: 24.7520 },
    { street: 'бул. 6-ти Септември', district: 'Център / Мараша', lat: 42.1520, lng: 24.7410 },
    { street: 'бул. Руски', district: 'Център', lat: 42.1430, lng: 24.7400 },
    { street: 'бул. България', district: 'Северен / Кършияка', lat: 42.1590, lng: 24.7450 },
    { street: 'бул. Освобождение', district: 'Тракия', lat: 42.1310, lng: 24.7820 },
    { street: 'ул. Капитан Райчо', district: 'Каменица', lat: 42.1400, lng: 24.7570 },
    { street: 'кв. Капана', district: 'Център', lat: 42.1490, lng: 24.7490 },
    { street: 'ж.к. Тракия', district: 'Тракия', lat: 42.1320, lng: 24.7890 },
    { street: 'кв. Кършияка', district: 'Северен', lat: 42.1570, lng: 24.7460 },
    { street: 'кв. Смирненски', district: 'Западен', lat: 42.1380, lng: 24.7150 }
  ],
  'Варна': [
    { street: 'бул. Княз Борис I', district: 'Център / Чайка', lat: 43.2110, lng: 27.9250 },
    { street: 'бул. Владислав Варненчик', district: 'Център / Младост', lat: 43.2180, lng: 27.8990 },
    { street: 'бул. Сливница', district: 'Център', lat: 43.2090, lng: 27.9150 },
    { street: 'бул. Мария Луиза', district: 'Център', lat: 43.2060, lng: 27.9170 },
    { street: 'ул. Отец Паисий', district: 'Център', lat: 43.2130, lng: 27.9100 },
    { street: 'кв. Чайка', district: 'Приморски', lat: 43.2180, lng: 27.9400 },
    { street: 'кв. Младост', district: 'Младост', lat: 43.2320, lng: 27.8810 },
    { street: 'кв. Левски', district: 'Приморски', lat: 43.2270, lng: 27.9300 },
    { street: 'кв. Аспарухово', district: 'Аспарухово', lat: 43.1780, lng: 27.9010 }
  ],
  'Бургас': [
    { street: 'ул. Александровска', district: 'Център', lat: 42.4970, lng: 27.4720 },
    { street: 'ул. Богориди', district: 'Център', lat: 42.4930, lng: 27.4760 },
    { street: 'бул. Стефан Стамболов', district: 'Център / Зорница', lat: 42.5180, lng: 27.4580 },
    { street: 'бул. Демокрация', district: 'Лазур / Център', lat: 42.5060, lng: 27.4730 },
    { street: 'к-с Лазур', district: 'Лазур', lat: 42.5120, lng: 27.4710 },
    { street: 'к-с Славейков', district: 'Славейков', lat: 42.5270, lng: 27.4490 },
    { street: 'к-с Меден рудник', district: 'Меден рудник', lat: 42.4580, lng: 27.4190 },
    { street: 'к-с Изгрев', district: 'Изгрев', lat: 42.5290, lng: 27.4700 }
  ],
  'Русе': [
    { street: 'ул. Александровска', district: 'Център', lat: 43.8500, lng: 25.9550 },
    { street: 'бул. Цар Освободител', district: 'Център', lat: 43.8470, lng: 25.9610 },
    { street: 'ул. Борисова', district: 'Център', lat: 43.8420, lng: 25.9510 },
    { street: 'кв. Възраждане', district: 'Възраждане', lat: 43.8480, lng: 25.9720 },
    { street: 'кв. Дружба 1', district: 'Дружба', lat: 43.8310, lng: 25.9600 }
  ],
  'Стара Загора': [
    { street: 'бул. Цар Симеон Велики', district: 'Център', lat: 42.4260, lng: 25.6300 },
    { street: 'ул. Генерал Гурко', district: 'Център', lat: 42.4230, lng: 25.6320 },
    { street: 'бул. Патриарх Евтимий', district: 'Център', lat: 42.4290, lng: 25.6420 },
    { street: 'кв. Железник', district: 'Железник', lat: 42.4180, lng: 25.5920 },
    { street: 'кв. Казански', district: 'Казански', lat: 42.4170, lng: 25.6130 }
  ],
  'Плевен': [
    { street: 'ул. Васил Левски', district: 'Център', lat: 43.4090, lng: 24.6200 },
    { street: 'ул. Иван Вазов', district: 'Център', lat: 43.4110, lng: 24.6180 },
    { street: 'бул. Христо Ботев', district: 'Сторгозия', lat: 43.4240, lng: 24.5980 },
    { street: 'ж.к. Сторгозия', district: 'Сторгозия', lat: 43.4250, lng: 24.5950 },
    { street: 'ж.к. Дружба', district: 'Дружба', lat: 43.3980, lng: 24.6350 }
  ],
  'Велико Търново': [
    { street: 'ул. Васил Левски', district: 'Център', lat: 43.0820, lng: 25.6310 },
    { street: 'бул. България', district: 'Център / Колю Фичето', lat: 43.0840, lng: 25.6150 },
    { street: 'ул. Стефан Стамболов', district: 'Стар град', lat: 43.0840, lng: 25.6450 },
    { street: 'ул. Независимост', district: 'Център', lat: 43.0840, lng: 25.6420 },
    { street: 'ул. Шемшевско шосе', district: 'Западна индустриална зона', lat: 43.0760, lng: 25.6020 },
    { street: 'ул. Симеон Велики', district: 'Колю Фичето', lat: 43.0825, lng: 25.6290 },
    { street: 'ул. Козлодуй', district: 'Център', lat: 43.0835, lng: 25.6320 },
    { street: 'ул. Никола Габровски', district: 'Колю Фичето', lat: 43.0780, lng: 25.6130 },
    { street: 'кв. Колю Фичето', district: 'Колю Фичето', lat: 43.0850, lng: 25.6080 },
    { street: 'кв. Бузлуджа', district: 'Бузлуджа', lat: 43.0710, lng: 25.6210 }
  ],
  'Благоевград': [
    { street: 'ул. Тодор Александров', district: 'Център', lat: 42.0210, lng: 23.0970 },
    { street: 'бул. Васил Левски', district: 'Център', lat: 42.0190, lng: 23.0890 },
    { street: 'бул. Св. Димитър Солунски', district: 'Център', lat: 42.0130, lng: 23.0980 },
    { street: 'ул. Иван Михайлов', district: 'Център / Освобождение', lat: 42.0225, lng: 23.1020 },
    { street: 'ул. Владо Черноземски', district: 'Център', lat: 42.0240, lng: 23.0950 },
    { street: 'ж.к. Еленово', district: 'Еленово', lat: 42.0080, lng: 23.1190 },
    { street: 'ж.к. Струмско', district: 'Струмско', lat: 41.9960, lng: 23.0820 }
  ],
  'Сливен': [
    { street: 'бул. Цар Освободител', district: 'Център', lat: 42.6840, lng: 26.3190 },
    { street: 'бул. Стефан Караджа', district: 'Център', lat: 42.6810, lng: 26.3260 },
    { street: 'ул. Раковски', district: 'Център', lat: 42.6830, lng: 26.3140 }
  ],
  'Добрич': [
    { street: 'бул. 25-ти Септември', district: 'Център', lat: 43.5710, lng: 27.8280 },
    { street: 'бул. Добруджа', district: 'Център', lat: 43.5680, lng: 27.8320 },
    { street: 'ул. Отец Паисий', district: 'Център', lat: 43.5735, lng: 27.8250 }
  ],
  'Шумен': [
    { street: 'бул. Славянски', district: 'Център', lat: 43.2720, lng: 26.9290 },
    { street: 'бул. Симеон Велики', district: 'Център', lat: 43.2700, lng: 26.9380 },
    { street: 'ул. Съединение', district: 'Център', lat: 43.2740, lng: 26.9240 },
    { street: 'ул. Цар Освободител', district: 'Център', lat: 43.2680, lng: 26.9310 }
  ],
  'Перник': [
    { street: 'ул. Търговска', district: 'Център', lat: 42.6060, lng: 23.0330 },
    { street: 'ул. Кракра', district: 'Център', lat: 42.6040, lng: 23.0360 },
    { street: 'кв. Изток', district: 'Изток', lat: 42.5980, lng: 23.0720 },
    { street: 'ул. Юрий Гагарин', district: 'Изток', lat: 42.5950, lng: 23.0780 }
  ],
  'Хасково': [
    { street: 'бул. България', district: 'Център', lat: 41.9330, lng: 25.5580 },
    { street: 'бул. Освобождение', district: 'Център', lat: 41.9370, lng: 25.5520 },
    { street: 'ул. Сан Стефано', district: 'Център', lat: 41.9350, lng: 25.5610 },
    { street: 'ул. Дунав', district: 'Център', lat: 41.9310, lng: 25.5490 }
  ],
  'Пазарджик': [
    { street: 'бул. България', district: 'Център', lat: 42.1940, lng: 24.3310 },
    { street: 'ул. Пловдивска', district: 'Център', lat: 42.1910, lng: 24.3380 },
    { street: 'ул. Генерал Гурко', district: 'Център', lat: 42.1960, lng: 24.3270 },
    { street: 'ул. Хан Крум', district: 'Център', lat: 42.1890, lng: 24.3350 }
  ],
  'Габрово': [
    { street: 'ул. Радецка', district: 'Център', lat: 42.8730, lng: 25.3190 },
    { street: 'бул. Априлов', district: 'Център', lat: 42.8710, lng: 25.3160 },
    { street: 'ул. Брянска', district: 'Център', lat: 42.8760, lng: 25.3210 },
    { street: 'ул. Скобелевска', district: 'Център', lat: 42.8745, lng: 25.3175 }
  ],
  'Враца': [
    { street: 'бул. Христо Ботев', district: 'Център', lat: 43.2080, lng: 23.5510 },
    { street: 'ул. Никола Войводов', district: 'Център', lat: 43.2050, lng: 23.5540 },
    { street: 'бул. Васил Кънчов', district: 'Център', lat: 43.2120, lng: 23.5470 }
  ],
  'Ямбол': [
    { street: 'ул. Георги С. Раковски', district: 'Център', lat: 42.4840, lng: 26.5050 },
    { street: 'бул. Граф Игнатиев', district: 'Център', lat: 42.4810, lng: 26.5120 },
    { street: 'бул. Димитър Благоев', district: 'Център', lat: 42.4860, lng: 26.4980 }
  ],
  'Видин': [
    { street: 'ул. Градинска', district: 'Център', lat: 43.9890, lng: 22.8760 },
    { street: 'бул. Панония', district: 'Център', lat: 43.9850, lng: 22.8680 },
    { street: 'ул. Цар Симеон Велики', district: 'Център', lat: 43.9920, lng: 22.8730 }
  ],
  'Кърджали': [
    { street: 'бул. България', district: 'Център', lat: 41.6440, lng: 25.3720 },
    { street: 'бул. Беломорски', district: 'Център', lat: 41.6480, lng: 25.3670 },
    { street: 'ул. Сан Стефано', district: 'Център', lat: 41.6420, lng: 25.3750 }
  ],
  'Кюстендил': [
    { street: 'бул. България', district: 'Център', lat: 42.2850, lng: 22.6890 },
    { street: 'ул. Цар Освободител', district: 'Център', lat: 42.2820, lng: 22.6930 },
    { street: 'ул. Пауталия', district: 'Център', lat: 42.2870, lng: 22.6840 }
  ],
  'Монтана': [
    { street: 'бул. Трети Март', district: 'Център', lat: 43.4090, lng: 23.2240 },
    { street: 'ул. Васил Левски', district: 'Център', lat: 43.4060, lng: 23.2280 },
    { street: 'бул. Александър Стамболийски', district: 'Център', lat: 43.4120, lng: 23.2190 }
  ],
  'Търговище': [
    { street: 'бул. Митрополит Андрей', district: 'Център', lat: 43.2510, lng: 26.5740 },
    { street: 'ул. Васил Левски', district: 'Център', lat: 43.2480, lng: 26.5690 },
    { street: 'ул. Стефан Караджа', district: 'Център', lat: 43.2530, lng: 26.5780 }
  ],
  'Силистра': [
    { street: 'ул. Симеон Велики', district: 'Център', lat: 44.1170, lng: 27.2640 },
    { street: 'бул. Македония', district: 'Център', lat: 44.1130, lng: 27.2690 },
    { street: 'ул. Добруджа', district: 'Център', lat: 44.1190, lng: 27.2590 }
  ],
  'Ловеч': [
    { street: 'ул. Търговска', district: 'Център', lat: 43.1360, lng: 24.7170 },
    { street: 'бул. България', district: 'Център', lat: 43.1320, lng: 24.7210 },
    { street: 'ул. Васил Левски', district: 'Вароша', lat: 43.1310, lng: 24.7140 }
  ],
  'Разград': [
    { street: 'бул. Бели Лом', district: 'Център', lat: 43.5260, lng: 26.5240 },
    { street: 'бул. България', district: 'Център', lat: 43.5290, lng: 26.5290 },
    { street: 'ул. Васил Левски', district: 'Център', lat: 43.5230, lng: 26.5190 }
  ],
  'Смолян': [
    { street: 'бул. България', district: 'Нов център', lat: 41.5760, lng: 24.7110 },
    { street: 'ул. Дичо Петров', district: 'Устово', lat: 41.5720, lng: 24.7250 },
    { street: 'ул. Полковник Серафимов', district: 'Стар център', lat: 41.5790, lng: 24.6980 }
  ],
  'Казанлък': [
    { street: 'ул. Искра', district: 'Център', lat: 42.6210, lng: 25.3940 },
    { street: 'бул. Розова Долина', district: 'Център', lat: 42.6170, lng: 25.3890 },
    { street: 'бул. Княз Александър Батенберг', district: 'Център', lat: 42.6240, lng: 25.3990 }
  ],
  'Димитровград': [
    { street: 'бул. България', district: 'Център', lat: 42.0560, lng: 25.5970 },
    { street: 'бул. Трети Март', district: 'Център', lat: 42.0590, lng: 25.5920 },
    { street: 'ул. Димитър Димов', district: 'Център', lat: 42.0530, lng: 25.6020 }
  ],
  'Дупница': [
    { street: 'ул. Николаевска', district: 'Център', lat: 42.2630, lng: 23.1190 },
    { street: 'ул. Свети Иван Рилски', district: 'Център', lat: 42.2660, lng: 23.1140 },
    { street: 'ул. Цар Освободител', district: 'Център', lat: 42.2610, lng: 23.1230 }
  ],
  'Горна Оряховица': [
    { street: 'ул. Цар Освободител', district: 'Център', lat: 43.1290, lng: 25.6980 },
    { street: 'ул. Иван Вазов', district: 'Център', lat: 43.1260, lng: 25.7030 },
    { street: 'ул. Васил Левски', district: 'Център', lat: 43.1310, lng: 25.6920 }
  ],
  'Сандански': [
    { street: 'ул. Македония', district: 'Център', lat: 41.5650, lng: 23.2790 },
    { street: 'бул. Свобода', district: 'Център', lat: 41.5620, lng: 23.2840 }
  ],
  'Петрич': [
    { street: 'ул. Цар Борис III', district: 'Център', lat: 41.3990, lng: 23.2060 },
    { street: 'ул. Рокфелер', district: 'Център', lat: 41.3960, lng: 23.2110 }
  ],
  'Самоков': [
    { street: 'ул. Търговска', district: 'Център', lat: 42.3380, lng: 23.5590 },
    { street: 'бул. Искър', district: 'Център', lat: 42.3350, lng: 23.5640 }
  ],
  'Свищов': [
    { street: 'ул. Цар Освободител', district: 'Център', lat: 43.6180, lng: 25.3480 },
    { street: 'ул. Черни Връх', district: 'Център', lat: 43.6140, lng: 25.3530 }
  ],
  'Карлово': [
    { street: 'ул. Генерал Карцов', district: 'Център', lat: 42.6420, lng: 24.8090 },
    { street: 'ул. Васил Левски', district: 'Център', lat: 42.6450, lng: 24.8040 }
  ],
  'Асеновград': [
    { street: 'ул. Цар Иван Асен II', district: 'Център', lat: 42.0120, lng: 24.8760 },
    { street: 'бул. България', district: 'Център', lat: 42.0090, lng: 24.8810 }
  ],
  'Ботевград': [
    { street: 'бул. Цар Освободител', district: 'Център', lat: 42.9060, lng: 23.7940 },
    { street: 'ул. Академик Стоян Романски', district: 'Център', lat: 42.9090, lng: 23.7890 }
  ],
  'Велинград': [
    { street: 'бул. Съединение', district: 'Център / Лъджене', lat: 42.0290, lng: 23.9920 },
    { street: 'ул. Хан Аспарух', district: 'Чепино', lat: 42.0240, lng: 23.9870 }
  ],
  'Банско': [
    { street: 'ул. Пирин', district: 'Център / Стария град', lat: 41.8390, lng: 23.4870 },
    { street: 'ул. Глазне', district: 'Център', lat: 41.8360, lng: 23.4910 }
  ]
};

/**
 * Resolves precise coordinates for a street inside a city
 * @param {string} city
 * @param {string} streetName
 * @returns {{lat: number, lng: number, district?: string} | null}
 */
export function getStreetCoordinates(city, streetName) {
  if (!city || !streetName) return null;
  const cleanCity = city.trim();
  const streets = ownValue(CITY_STREETS_DATABASE, cleanCity);
  if (streets && Array.isArray(streets)) {
    const cleanStreet = streetName.toLowerCase().replace(/^(ул\.|бул\.|кв\.|ж\.к\.)\s*/, '').trim();
    const found = streets.find(s => {
      const sClean = s.street.toLowerCase().replace(/^(ул\.|бул\.|кв\.|ж\.к\.)\s*/, '').trim();
      return cleanStreet.includes(sClean) || sClean.includes(cleanStreet);
    });
    if (found && found.lat && found.lng) {
      return { lat: found.lat, lng: found.lng, district: found.district };
    }
  }
  return null;
}

/**
 * Common nationwide Bulgarian streets present in virtually every town and village
 */
export const COMMON_BULGARIAN_STREETS = [
  'ул. Васил Левски',
  'ул. Христо Ботев',
  'ул. Иван Вазов',
  'ул. Георги С. Раковски',
  'ул. Стефан Караджа',
  'ул. Хан Аспарух',
  'ул. Цар Симеон',
  'ул. 6-ти Септември',
  'ул. 3-ти Март',
  'ул. Любен Каравелов',
  'ул. Паисий Хилендарски',
  'ул. Шипка',
  'ул. Сливница',
  'ул. Оборище',
  'ул. Независимост',
  'ул. Търговска',
  'ул. Главна',
  'ул. Стара планина',
  'ул. Родопи',
  'ул. Пирин',
  'ул. Рила',
  'ул. Дунав',
  'ул. Марица',
  'ул. Янтра',
  'ул. Черно море',
  'ул. Изгрев',
  'ул. Здравец',
  'ул. Цветна',
  'ул. Пролет',
  'ул. Мир',
  'ул. Свобода',
  'ул. Победа',
  'ул. Бор',
  'ул. Дъб',
  'ул. Липа',
  'ул. България',
  'бул. България',
  'бул. Васил Левски',
  'бул. Христо Ботев',
  'бул. Княз Александър Дондуков',
  'бул. Драган Цанков',
  'ул. Димитър Петков',
  'ул. Драгоман',
  'ул. Дебър',
  'ул. Дамян Груев',
  'ул. Дойран',
  'ул. Денкоглу',
  'ул. Драговица',
  'ул. Димитър Талев',
  'ул. Д-р Г. М. Димитров',
  'ул. Кирил и Методий',
  'ул. Алеко Константинов',
  'ул. Пейо Яворов',
  'ул. Димчо Дебелянов',
  'ул. Цар Освободител',
  'ул. Георги Бенковски',
  'ул. Хаджи Димитър',
  'ул. Бачо Киро',
  'ул. Филип Тотю',
  'ул. Петко Р. Славейков',
  'ул. Бузлуджа',
  'ул. Братя Миладинови',
  'ул. Бели Лом',
  'ул. Боряна',
  'ул. Битоля',
  'ул. Брегалница',
  'ул. Борово',
  'ул. Балкан',
  'ул. Батак',
  'ул. Врабча',
  'ул. Веслец',
  'ул. Владайска',
  'ул. Вардар',
  'ул. Гурко',
  'ул. Генерал Гурко',
  'ул. Генерал Столетов',
  'ул. Екзарх Йосиф',
  'ул. Житница',
  'ул. Захари Стоянов',
  'ул. Ивайло',
  'ул. Йордан Йовков',
  'ул. Калоян',
  'ул. Лавеле',
  'ул. Македония',
  'ул. Неофит Рилски',
  'ул. Опълченска',
  'ул. Позитано',
  'ул. Раковски',
  'ул. Солунска',
  'ул. Тракия',
  'ул. Филип Станиславов',
  'ул. Христо Смирненски',
  'ул. Цар Самуил',
  'ул. Чудомир',
  'ул. Шандор Петьофи',
  'ул. Щросмайер',
  'ул. Юри Гагарин',
  'ул. Яков Крайков'
];

/**
 * Helper to compute match relevance score for a street name against clean user query
 */
function scoreStreetMatch(streetName, cleanQuery) {
  if (!cleanQuery) return 0;
  const sLower = streetName.toLowerCase();
  const cleanStreet = sLower.replace(/^(?:ул\.\s*|бул\.\s*|кв\.\s*|ж\.?к\.?\s*|улица\s+|булевард\s+|квартал\s+)/i, '').trim();

  // Exact prefix match of clean street name (e.g. "България" vs "б" or "Дондуков" vs "д") -> Top Score
  if (cleanStreet.startsWith(cleanQuery)) {
    return 100 - (cleanStreet.length - cleanQuery.length);
  }

  // Any word in the street name starts with the query (e.g. "Княз Александър Дондуков" vs "дон" or "Хаджи Димитър" vs "дим")
  const words = cleanStreet.split(/[\s\-]+/);
  if (words.some(w => w.startsWith(cleanQuery))) {
    return 80;
  }

  // Substring match in street name only for queries of length >= 3
  if (cleanQuery.length >= 3 && cleanStreet.includes(cleanQuery)) {
    return 50;
  }

  return 0;
}

/**
 * Searches and autocompletes Bulgarian streets and addresses in real-time
 * using comprehensive local Bulgarian database with zero latency.
 * 
 * @param {string} city - Bulgarian city or village name
 * @param {string} query - Query substring typed by the user
 * @returns {Promise<Array>} Array of suggestion objects
 */
export async function getStreetSuggestions(city = 'София', query = '') {
  const cleanCity = (city || 'София')
    .trim()
    .replace(/^(?:гр\.\s*|с\.\s*|гр\s+|с\s+|село\s+|град\s+)/i, '')
    .replace(/\s*\(.*\)$/, '')
    .trim();

  const rawQuery = (query || '').trim();
  if (!rawQuery) return [];

  const cleanQuery = rawQuery
    .toLowerCase()
    .replace(/^(?:ул\.\s*|бул\.\s*|кв\.\s*|ж\.?к\.?\s*|улица\s+|булевард\s+|квартал\s+)/i, '')
    .replace(/\s*\d+.*$/, '')
    .trim();

  if (!cleanQuery) return [];

  const candidateList = [];
  const addedKeys = new Set();

  // 1. Check City-specific curated database
  const cityStreets = ownValue(CITY_STREETS_DATABASE, cleanCity) || [];
  for (const item of cityStreets) {
    const score = scoreStreetMatch(item.street, cleanQuery);
    if (score > 0) {
      const key = item.street.toLowerCase();
      if (!addedKeys.has(key)) {
        addedKeys.add(key);
        candidateList.push({
          score: score + 20, // City boost
          item: {
            street_name: item.street,
            district: item.district || '',
            city: cleanCity,
            lat: item.lat,
            lng: item.lng,
            source: 'local'
          }
        });
      }
    }
  }

  // 2. Check Nationwide Bulgarian common streets database
  for (const st of COMMON_BULGARIAN_STREETS) {
    const score = scoreStreetMatch(st, cleanQuery);
    if (score > 0) {
      const key = st.toLowerCase();
      if (!addedKeys.has(key)) {
        addedKeys.add(key);
        candidateList.push({
          score: score,
          item: {
            street_name: st,
            district: '', // the nationwide list knows no district — never invent one
            city: cleanCity,
            lat: null,
            lng: null,
            source: 'national'
          }
        });
      }
    }
  }

  // Sort by highest relevance score
  candidateList.sort((a, b) => b.score - a.score);
  const results = candidateList.slice(0, 15).map(c => c.item);

  // 3. If user typed a specific house/block number (e.g. "България 45"), or a full street without matches
  const hasNumber = /\d+/.test(rawQuery);
  const isCustomComplete = hasNumber || (cleanQuery.length >= 4 && results.length === 0);

  if (isCustomComplete) {
    const formattedUserStreet = rawQuery.startsWith('ул.') || rawQuery.startsWith('бул.') || rawQuery.startsWith('кв.') || rawQuery.startsWith('ж.к.')
      ? rawQuery
      : `ул. ${rawQuery}`;

    const key = `${formattedUserStreet.toLowerCase()}_${cleanCity.toLowerCase()}`;
    if (!addedKeys.has(key)) {
      results.unshift({
        street_name: formattedUserStreet,
        district: '',
        city: cleanCity,
        lat: null,
        lng: null,
        source: 'input'
      });
    }
  }

  return results.slice(0, 15);
}
