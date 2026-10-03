import dotenv from 'dotenv';
import { runScraperJob } from '../services/scraperService.js';
import { configureEgress } from '../utils/egress.js';

dotenv.config();
configureEgress();

async function main() {
  console.log('🚀 Running СпаркСтоп Standalone Scraper & AI Parser...');
  try {
    const results = await runScraperJob();
    console.log(`\n🎉 Scraper finished successfully. Total outages processed: ${results.length}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Scraper execution failed:', err);
    process.exit(1);
  }
}

main();
