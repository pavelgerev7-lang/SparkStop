# СпаркСтоп (SparkStop)

**Интелигентна система за автоматизирано събиране, анализ и визуализация в реално време на аварии и комунални прекъсвания в България.**
*An Intelligent System for Automated Real-Time Collection, Analysis, and Visualization of Utility Outages in Bulgaria.*

Живо приложение / live app: **https://www.sparkstopapp.com**
Автор / author: Павел Тодоров Герев
Проект за Тринадесетата ученическа научна сесия на УчИ-БАН, 2026 г.

## Какво прави
Следи официалните сайтове на над 60 доставчика (ЕРП, ВиК, топлофикации, газоразпределителни дружества), извлича аварии и планирани профилактики от свободен текст, определя точните им места и ги показва на една карта. Потребителят може да запази до 3 адреса и да получава push известия 24 часа и 1 час преди планирано спиране и когато то приключи.

## Как е устроено (накратко)
| Слой | Къде е | Какво прави |
|------|--------|-------------|
| Събиране на данни | `src/services/scraperService.js` | Обхожда доставчиците по разписание, повторни опити, учтиво към чуждите сървъри |
| Структуриране | `src/services/aiParserService.js` | Google Gemini + резервни регулярни изрази и речници |
| Геокодиране | `src/services/geocodingService.js` | Кураторски улици, кеш, Nominatim/OpenStreetMap, регистър на 5 265 населени места |
| Съхранение | `src/config/db.js`, `schema.sql` | PostgreSQL (Neon) |
| Известия | `src/services/notificationService.js`, `reminderService.js` | Firebase Cloud Messaging |
| Интерфейс | `index.html`, `sw.js` | Едностранично приложение (PWA), Leaflet + MapTiler |
| Сигурност | `src/server.js`, `src/utils/` | Helmet, CORS, ограничения на заявките, Cloudflare Turnstile, защита от ботове, до 25 профила на денонощие от един IP адрес |

Android приложението е Trusted Web Activity (Bubblewrap) и зарежда същия сайт.

## Стартиране
```bash
npm install
cp .env.example .env     # попълни ключовете; без DATABASE_URL работи с локална база
npm start                # http://localhost:3000
npm test                 # автоматичните тестове (над 500 проверки)
```
Тайните (пароли, ключове) не са част от хранилището — виж `.env.example`.

## Лиценз
Всички права запазени — виж `LICENSE`. Кодът е публикуван за преглед от журито на УчИ-БАН.

---
*This repository is a read-only snapshot of the application source code published for the jury of the 13th Student Science Session of the Institute of Students at the Bulgarian Academy of Sciences (УчИ-БАН), 2026. Secrets are not included.*
