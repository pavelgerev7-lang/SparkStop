import axios from 'axios';

async function findSofiaApi() {
  try {
    const res = await axios.get('https://www.sofiyskavoda.bg/water-stops', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = res.data;
    
    // Look for API endpoints or json data embedded in html
    const apiMatches = html.match(/https?:\/\/[^"'\s]+\/(?:api|stops|outages|stoppages|graphql|json)[^"'\s]*/gi) || [];
    console.log('API Matches:', apiMatches);

    const scriptMatches = html.match(/drupalSettings\s*=\s*(\{[\s\S]+?\});/);
    if (scriptMatches) {
      console.log('Found drupalSettings!');
      const sub = scriptMatches[1].substring(0, 500);
      console.log(sub);
    }
  } catch (e) {
    console.error('Err:', e.message);
  }
}

findSofiaApi();
