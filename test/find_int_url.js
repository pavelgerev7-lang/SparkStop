import axios from 'axios';
import * as cheerio from 'cheerio';

async function getInterruptionsUrl() {
  const res = await axios.get('https://erpsever.bg/bg/prekysvanija', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = res.data;
  const match = text.match(/interruptionsUrl\s*=\s*['"]([^'"]+)['"]/);
  console.log('interruptionsUrl match:', match ? match[1] : 'Not found');
  const allMatches = text.match(/[a-zA-Z0-9_/.-]+interruptions[a-zA-Z0-9_/.-]*/gi);
  console.log('All interruption endpoints:', allMatches);
}

getInterruptionsUrl();
