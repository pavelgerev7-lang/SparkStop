import axios from 'axios';
import * as cheerio from 'cheerio';
import { parseOutageTextWithAI } from '../src/services/aiParserService.js';

async function test() {
  const url = 'https://www.vik-shumen.net/';
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 8000
  });

  const $ = cheerio.load(res.data);
  const items = [];

  $('article, .et_pb_post, .news-item, .post').each((_, el) => {
    if ($(el).find('article, .et_pb_post, .post').length > 0) {
      return;
    }

    const linkEl = $(el).find('h2 a, .entry-title a, a').first();
    let href = linkEl.attr('href') || '';
    const title = linkEl.text().trim();
    const meta = $(el).find('.post-meta, .published, time, .date').text().replace(/\s+/g, ' ').trim();
    const body = $(el).find('.post-content, p, .entry-content').text().replace(/\s+/g, ' ').trim();

    if (href && (href.includes('/category/') || href.includes('/author/') || href.includes('/page/') || href.includes('/tag/') || href.includes('#'))) {
      return;
    }

    if (body.length > 20 && (body.includes('авария') || body.includes('ремонт') || body.includes('спиране') || body.includes('водоподаване'))) {
      items.push({
        title,
        href,
        meta,
        text: `${title} (${meta}): ${body}`
      });
    }
  });

  console.log(`Found ${items.length} clean articles for ViK Shumen:`);
  for (const it of items) {
    console.log(`\nURL: ${it.href}`);
    console.log(`Text: ${it.text.substring(0, 120)}...`);
    const parsed = await parseOutageTextWithAI(it.text, 'ВиК Шумен', 'Шумен', it.href);
    console.log(`Parsed:`, {
      streets: parsed.affected_streets,
      start: parsed.start_time,
      end: parsed.expected_end_time,
      status: parsed.status,
      source_url: parsed.source_url
    });
  }
}

test().catch(console.error);
