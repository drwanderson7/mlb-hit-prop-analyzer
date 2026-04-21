export const config = { runtime: 'edge' };

// Fetch current 2026 season hitting stats for a list of MLB player IDs
// Uses MLB Stats API — free, no key required
// Returns: { [playerId]: { kpct, bbpct, avg, obp, slg, pa, ab, hits, so, name } }

export default async function handler(req) {
  const url = new URL(req.url);
  const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
  const season = url.searchParams.get('season') || new Date().getFullYear();

  if (!ids.length) {
    return respond(400, { error: 'No batter IDs provided' });
  }

  // Fetch stats for all batters in parallel
  const fetches = ids.map(async (id) => {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=season&group=hitting&season=${season}&sportId=1`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal }
      );
      clearTimeout(tid);
      if (!res.ok) return { id, error: res.status };
      const data = await res.json();
      const splits = data?.stats?.[0]?.splits;
      if (!splits?.length) return { id, error: 'no splits' };
      const s = splits[0].stat;
      const pa  = parseInt(s.plateAppearances) || 0;
      const so  = parseInt(s.strikeOuts) || 0;
      const bb  = parseInt(s.baseOnBalls) || 0;
      const hits = parseInt(s.hits) || 0;
      const ab  = parseInt(s.atBats) || 0;
      return {
        id,
        name: splits[0].player?.fullName || '',
        pa,
        so,
        bb,
        hits,
        ab,
        kpct:  pa > 0 ? parseFloat((so / pa).toFixed(4)) : null,
        bbpct: pa > 0 ? parseFloat((bb / pa).toFixed(4)) : null,
        avg:   ab > 0 ? parseFloat((hits / ab).toFixed(3)) : null,
      };
    } catch(e) {
      return { id, error: e.message };
    }
  });

  const results = await Promise.all(fetches);
  const out = {};
  results.forEach(r => {
    if (r && !r.error) out[r.id] = r;
  });

  return respond(200, out);
}

function respond(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    }
  });
}
