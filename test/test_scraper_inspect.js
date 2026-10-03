import axios from 'axios';
import * as cheerio from 'cheerio';

async function test() {
  const res = await axios.get('https://www.vik-shumen.net/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 8000
  });

  const $ = cheerio.load(res.data);
  console.log('--- ET_PB_POSTS ---');
  $('article, .et_pb_post').each((i, el) => {
    const titleEl = $(el).find('h2 a, .entry-title a, a').first();
    const title = titleEl.text().trim();
    const link = titleEl.attr('href');
    const meta = $(el).find('.post-meta, .published').text().trim();
    const snippet = $(el).find('.post-content, p').text().trim();
    console.log(`[${i}] Title: "${title}" | Link: ${link} | Meta: "${meta}"`);
    console.log(`     Snippet: ${snippet.substring(0, 120)}...\n`);
  });
}

test().catch(console.error);
