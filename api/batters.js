export const config = { runtime: 'edge' };

// Fetch current season hitting stats for ALL players — no IDs needed
// Uses MLB Stats API bulk endpoint
export default async function handler(req) {
  const year = new URL(req.url).searchParams.get('season') || new Date().getFullYear();

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/stats?stats=season&group=hitting&gameType=R&season=${year}&playerPool=All&limit=2000`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal }
    );
    clearTimeout(tid);

    if (!res.ok) throw new Error(`MLB API ${res.status}`);
    const data = await res.json();

    const out = {};
    (data.stats || []).forEach(statGroup => {
      (statGroup.splits || []).forEach(split => {
        const player = split.player;
        const stat = split.stat;
        if (!player || !stat) return;
        const pa = parseInt(stat.plateAppearances) || 0;
        if (pa < 10) return;
        const bb = parseInt(stat.baseOnBalls) || 0;
        const so = parseInt(stat.strikeOuts) || 0;
        const hits = parseInt(stat.hits) || 0;
        const ab = parseInt(stat.atBats) || 0;
        out[player.fullName] = {
          name: player.fullName,
          pa,
          bbpct: parseFloat((bb / pa).toFixed(4)),
          kpct:  parseFloat((so / pa).toFixed(4)),
          avg:   ab > 0 ? parseFloat((hits / ab).toFixed(3)) : null,
        };
      });
    });

    return new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=21600',
      }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      }
    });
  }
}
