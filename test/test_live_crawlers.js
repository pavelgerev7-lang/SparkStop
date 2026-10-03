import axios from 'axios';
import * as cheerio from 'cheerio';
import { parseBulgarianDateTime, parseOutageTextHeuristic } from '../src/services/aiParserService.js';

async function testAllLiveCrawlers() {
  const sources = [
    {
      name: 'ВиК Велико Търново',
      city: 'Велико Търново',
      provider: 'ВиК Йовковци',
      url: 'https://vik-vt.com/bg/news',
      crawl: async () => {
        const res = await axios.get('https://vik-vt.com/bg/news', {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 8000
        });
        const $ = cheerio.load(res.data);
        const items = [];
        const links = [];
        $('a').each((_, el) => {
          const title = $(el).text().replace(/\s+/g, ' ').trim();
          let href = $(el).attr('href') || '';
          if (href && (title.includes('ремонт') || title.includes('авария') || title.includes('спиране') || title.includes('Търново'))) {
            if (!href.startsWith('http')) href = 'https://vik-vt.com' + (href.startsWith('/') ? '' : '/') + href;
            if (!links.includes(href)) links.push(href);
          }
        });
        for (const link of links.slice(0, 5)) {
          try {
            const aRes = await axios.get(link, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
            const a$ = cheerio.load(aRes.data);
            const title = a$('h1, h2, .title').first().text().trim() || 'Авария';
            const body = a$('div.content, article, main, p').text().replace(/\s+/g, ' ').trim();
            items.push({ title, text: `${title}: ${body.substring(0, 400)}`, url: link });
          } catch (e) {}
        }
        return items;
      }
    },
    {
      name: 'ВиК Варна',
      city: 'Варна',
      provider: 'ВиК Варна',
      url: 'https://vikvarna.com/bg/category/avarii.html',
      crawl: async () => {
        const res = await axios.get('https://vikvarna.com/bg/category/avarii.html', {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 8000
        });
        const $ = cheerio.load(res.data);
        const items = [];
        $('.news-item, article, .item, p').each((_, el) => {
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (text.length > 30 && (text.includes('ремонт') || text.includes('авария') || text.includes('вода'))) {
            items.push({ title: 'ВиК Варна Авария', text: text.substring(0, 300), url: 'https://vikvarna.com/bg/category/avarii.html' });
          }
        });
        return items.slice(0, 5);
      }
    },
    {
      name: 'ВиК Пловдив',
      city: 'Пловдив',
      provider: 'ВиК Пловдив',
      url: 'https://vik.bg/avarii/',
      crawl: async () => {
        const res = await axios.get('https://vik.bg/avarii/', {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 8000
        });
        const $ = cheerio.load(res.data);
        const items = [];
        $('table tr, .outage-item, p').each((_, el) => {
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (text.length > 30 && (text.includes('ремонт') || text.includes('авария') || text.includes('бул.') || text.includes('ул.'))) {
            items.push({ title: 'ВиК Пловдив Авария', text: text.substring(0, 300), url: 'https://vik.bg/avarii/' });
          }
        });
        return items.slice(0, 5);
      }
    },
    {
      name: 'ВиК Бургас',
      city: 'Бургас',
      provider: 'ВиК Бургас',
      url: 'https://vik-burgas.com/current-repairments/',
      crawl: async () => {
        const res = await axios.get('https://vik-burgas.com/current-repairments/', {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 8000
        });
        const $ = cheerio.load(res.data);
        const items = [];
        $('table tr, .content p, article').each((_, el) => {
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (text.length > 30 && (text.includes('ремонт') || text.includes('авария') || text.includes('ул.') || text.includes('ж.к.'))) {
            items.push({ title: 'ВиК Бургас Ремонт', text: text.substring(0, 300), url: 'https://vik-burgas.com/current-repairments/' });
          }
        });
        return items.slice(0, 5);
      }
    }
  ];

  for (const src of sources) {
    console.log(`\n========================================`);
    console.log(`🔍 Crawling: ${src.name} (${src.url})`);
    console.log(`========================================`);
    try {
      const items = await src.crawl();
      console.log(`Found ${items.length} live items:`);
      for (const it of items) {
        const parsed = parseOutageTextHeuristic(it.text, src.provider, src.city, it.url);
        console.log(`\n  📄 Street(s): ${parsed.affected_streets.join(', ')}`);
        console.log(`     Dates: ${parsed.start_time.split('T')[0]} -> ${parsed.expected_end_time.split('T')[0]}`);
        console.log(`     Status: ${parsed.status.toUpperCase()} ${parsed.status === 'resolved' ? '✅ (PAST/FINISHED)' : '🔴 (ACTIVE/FUTURE)'}`);
        console.log(`     Link: ${parsed.source_url}`);
      }
    } catch (e) {
      console.log(`Error crawling ${src.name}:`, e.message);
    }
  }
}

testAllLiveCrawlers();
