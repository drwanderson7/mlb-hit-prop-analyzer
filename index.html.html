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

  // Build Savant URL — expected_statistics for xBA (batter & pitcher)
  let url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=${type === 'pitcher' ? 'pitcher' : 'batter'}&year=${year}&position=&team=&min=1&csv=true`;
  if (hand) url += `&pitcher_hand=${hand}`;

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
