export const config = { runtime: 'edge' };

export default async function handler(req) {
  const date = new URL(req.url).searchParams.get('date') || new Date().toLocaleDateString('en-CA');
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups,team,venue`;

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) throw new Error(`MLB API returned ${res.status}`);
    const data = await res.text();
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300', // 5 min cache
      }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message, dates: [] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
