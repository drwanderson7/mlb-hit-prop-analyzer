export const config = { runtime: 'edge' };
export default async function handler(req) {
  const params = new URL(req.url).searchParams;
  const year  = params.get('year') || new Date().getFullYear();
  const type  = params.get('type') || 'batter';
  const hand  = params.get('hand') || '';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://baseballsavant.mlb.com/',
  };
  const cors = { 'Access-Control-Allow-Origin': '*' };

  let url;
  if (type === 'statcast') {
    url = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${year}&position=&team=&min=1&csv=true`;
  } else if (type === 'pitcher') {
    url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=${year}&position=&team=&min=1&csv=true`;
  } else if (type === 'bbstats') {
    // Fetch BB% from Savant custom leaderboard — includes walk rate for batters
    url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=batter&filter=&sort=bb_percent&sortDir=desc&min=1&selections=b_bb_percent,b_k_percent&csv=true`;
  } else {
    url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&min=1&csv=true`;
    if (hand) url += `&pitcher_hand=${hand}`;
  }

  try {
    const res = await fetch(url, { headers });
    const statusHdr = { ...cors, 'X-Savant-Status': String(res.status) };
    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Savant ${res.status}`, url }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...statusHdr },
      });
    }
    const csv = await res.text();
    if (csv.trim().startsWith('<') || csv.length < 200) {
      return new Response(JSON.stringify({ error: 'Got HTML instead of CSV', url }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...statusHdr },
      });
    }
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Cache-Control': 'public, max-age=21600',
        'X-Savant-Rows': String(csv.split('\n').length),
        ...statusHdr,
      },
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message, url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}
