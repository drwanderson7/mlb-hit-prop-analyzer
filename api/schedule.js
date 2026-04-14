export const config = { runtime: 'edge' };

export default async function handler(req) {
  const date = new URL(req.url).searchParams.get('date') || new Date().toLocaleDateString('en-CA');
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups,team,venue`;

  try {
    // Hard 5-second timeout on the MLB API call
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    clearTimeout(tid);

    if (!res.ok) throw new Error(`MLB API returned ${res.status}`);
    const data = await res.text();
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      }
    });
  } catch(e) {
    const isTimeout = e.name === 'AbortError';
    return new Response(JSON.stringify({
      error: isTimeout ? 'MLB API timed out' : e.message,
      dates: []
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      }
    });
  }
}
