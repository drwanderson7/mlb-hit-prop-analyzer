export const config = { runtime: 'edge' };

export default async function handler(req) {
  const year = new URL(req.url).searchParams.get('year') || new Date().getFullYear();
  const type = new URL(req.url).searchParams.get('type') || 'batter';
  const hand = new URL(req.url).searchParams.get('hand') || '';

  let url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=${type}&year=${year}&position=&team=&min=1&csv=true`;
  if (hand) url += `&handedness=${hand}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://baseballsavant.mlb.com/',
      }
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Savant returned ${res.status}` }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const csv = await res.text();
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=21600',
      }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
