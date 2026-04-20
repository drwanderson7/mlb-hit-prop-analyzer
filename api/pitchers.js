export const config = { runtime: 'edge' };

// Fetch current 2026 season pitching stats for a list of MLB player IDs
// Uses MLB Stats API — free, no key required
// Returns: { [playerId]: { era, whip, k9, kpct, hand, name, pa } }

export default async function handler(req) {
  const url = new URL(req.url);
  const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
  const season = url.searchParams.get('season') || new Date().getFullYear();

  if (!ids.length) {
    return respond(400, { error: 'No pitcher IDs provided' });
  }

  // Fetch stats for all pitchers in parallel
  // MLB Stats API: /api/v1/people/{id}/stats?stats=season&group=pitching&season=YYYY
  const fetches = ids.map(async (id) => {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);

      // Fetch both season stats and person info (for hand) in parallel
      const [statsRes, personRes] = await Promise.all([
        fetch(
          `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=season&group=pitching&season=${season}`,
          { signal: controller.signal, headers: { 'Accept': 'application/json' } }
        ),
        fetch(
          `https://statsapi.mlb.com/api/v1/people/${id}?hydrate=currentTeam`,
          { signal: controller.signal, headers: { 'Accept': 'application/json' } }
        )
      ]);
      clearTimeout(tid);

      const [statsData, personData] = await Promise.all([
        statsRes.json(),
        personRes.json()
      ]);

      const person = personData?.people?.[0];
      const hand = person?.pitchHand?.code || 'R';
      const name = person?.fullName || '';
      const stats = statsData?.stats?.[0]?.splits?.[0]?.stat;

      if (!stats) return [id, { hand, name, era: null, whip: null, k9: null, kpct: null, pa: 0 }];

      const ip   = parseFloat(stats.inningsPitched) || 0;
      const bf   = parseInt(stats.battersFaced)     || 0;
      const so   = parseInt(stats.strikeOuts)        || 0;
      const era  = parseFloat(stats.era)             || null;
      const whip = parseFloat(stats.whip)            || null;
      const k9   = ip > 0 ? (so / ip) * 9 : null;
      const kpct = bf > 0 ? so / bf : null;

      return [id, { hand, name, era, whip, k9, kpct, pa: bf }];
    } catch (e) {
      return [id, { error: e.message, hand: 'R', name: '', era: null, whip: null, k9: null, kpct: null, pa: 0 }];
    }
  });

  const results = await Promise.all(fetches);
  const pitchers = Object.fromEntries(results);

  return respond(200, { pitchers, season, fetched: ids.length });
}

function respond(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=1800', // 30min cache — stats update after each game
    }
  });
}
