import { runScraperJob } from '../src/services/scraperService.js';
import { inMemoryDB, persistLocalDB } from '../src/config/db.js';

async function updateLiveFeeds() {
  console.log('Fetching live feeds from providers...');
  const results = await runScraperJob();
  console.log(`✅ Scraper finished. Upserted ${results.length} outages.`);
}

updateLiveFeeds();
