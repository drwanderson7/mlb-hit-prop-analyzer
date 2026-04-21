export const config = { runtime: 'edge' };

export default async function handler(req) {
  const year = new URL(req.url).searchParams.get('year') || new Date().getFullYear();
  const type = new URL(req.url).searchParams.get('type') || 'batter';
  const hand = new URL(req.url).searchParams.get('hand') || '';

  // pitcher_hand=R/L gets batter xBA split by opposing pitcher handedness (true platoon splits)
  // handedness=R/L filters by batter hand (not useful for platoon)
  let url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=${type}&year=${year}&position=&team=&min=1&csv=true`;
  if (hand) url += `&pitcher_hand=${hand}`;  // true platoon split by opposing pitcher hand

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://baseballsavant.mlb.com/',
      }
    });

    // Always return the status so frontend can diagnose
    const statusHdr = { 'Access-Control-Allow-Origin': '*', 'X-Savant-Status': String(res.status) };

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Savant returned ${res.status}`, url }), {
        status: 200, // return 200 so frontend gets the error message
        headers: { 'Content-Type': 'application/json', ...statusHdr }
      });
    }

    const csv = await res.text();
    const lines = csv.split('\n').length;
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Cache-Control': 'public, max-age=21600',
        'X-Savant-Rows': String(lines),
        ...statusHdr,
      }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message, url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
