import axios from 'axios';
import * as cheerio from 'cheerio';

async function getFullSofiaDetails() {
  const res = await axios.get('https://www.sofiyskavoda.bg/water-stops', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(res.data);
  $('script[src]').each((_, el) => {
    console.log($(el).attr('src'));
  });
  console.log('App root html:', $('#app, #root, .main-content, main').html()?.substring(0, 1000));
}

getFullSofiaDetails();
