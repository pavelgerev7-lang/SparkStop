import axios from 'axios';
import * as cheerio from 'cheerio';
import { PROVIDER_TARGETS } from '../src/services/scraperService.js';

async function testAll() {
  console.log(`Testing ${PROVIDER_TARGETS.length} scraper targets...`);
  const working = [];
  const failing = [];

  for (const target of PROVIDER_TARGETS) {
    try {
      const res = await axios.get(target.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 5000
      });
      const $ = cheerio.load(res.data);
      const textCount = $('p, article, .news-item, a').length;
      console.log(`✅ [${res.status}] ${target.city} - ${target.provider}: ${target.url} (Elements: ${textCount})`);
      working.push(target);
    } catch (err) {
      console.log(`❌ [FAIL] ${target.city} - ${target.provider}: ${target.url} -> ${err.message}`);
      failing.push({ ...target, error: err.message });
    }
  }

  console.log(`\n========================================`);
  console.log(`Total: ${PROVIDER_TARGETS.length} | Working: ${working.length} | Failing: ${failing.length}`);
}

testAll();
