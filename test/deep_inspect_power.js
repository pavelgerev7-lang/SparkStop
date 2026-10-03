import axios from 'axios';
import * as cheerio from 'cheerio';

async function deepInspectPowerSources() {
  console.log('=== 1. INSPECTING ERP SEVER (https://erpsever.bg/bg/prekysvanija) ===');
  try {
    const res = await axios.get('https://erpsever.bg/bg/prekysvanija', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });
    const $ = cheerio.load(res.data);
    console.log('Page Title:', $('title').text());
    
    // Look for scripts, APIs, map data, tables
    $('script').each((i, el) => {
      const src = $(el).attr('src') || '';
      const content = $(el).html() || '';
      if (src.includes('map') || src.includes('outage') || src.includes('prek') || content.includes('api') || content.includes('data') || content.includes('json') || content.includes('markers') || content.includes('points') || content.includes('regions')) {
        console.log(`Script src: ${src}`);
        if (content.length > 0 && content.length < 500) {
          console.log(`Script snippet:`, content);
        }
      }
    });

    // Check if there are select dropdowns or table elements
    $('select').each((_, el) => {
      console.log(`Select name: ${$(el).attr('name') || $(el).attr('id')}, Options:`, $(el).find('option').map((_, o) => $(o).text().trim()).get());
    });

    // Look for links to region schedules
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const txt = $(el).text().replace(/\s+/g, ' ').trim();
      if (href.includes('prek') || href.includes('region') || href.includes('oblast') || href.includes('grafik') || txt.includes('Област') || txt.includes('Варна') || txt.includes('Търново')) {
        console.log(`ERP Sever Link: "${txt}" -> ${href}`);
      }
    });

  } catch (e) {
    console.error('ERP Sever error:', e.message);
  }

  console.log('\n=== 2. INSPECTING EP YUG TILES (https://www.elyug.bg/SpecialPages/PowerOffLink.aspx) ===');
  try {
    const res2 = await axios.get('https://www.elyug.bg/SpecialPages/PowerOffLink.aspx', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });
    const $2 = cheerio.load(res2.data);
    console.log('EP Yug Title:', $2('title').text());
    $2('a').each((_, el) => {
      const href = $2(el).attr('href') || '';
      const txt = $2(el).text().replace(/\s+/g, ' ').trim();
      console.log(`EP Yug Link: "${txt}" -> ${href}`);
    });
  } catch (e) {
    console.error('EP Yug error:', e.message);
  }
}

deepInspectPowerSources();
