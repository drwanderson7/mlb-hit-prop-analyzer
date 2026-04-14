export const config = { runtime: 'edge' };

// Fetch MLB box score for a specific date and check if players got hits
// Returns: { date, players: [{name, team, gotHit, hits, atBats, gameStatus}] }

export default async function handler(req) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date'); // YYYY-MM-DD
  const players = url.searchParams.get('players'); // comma-separated player names

  if (!date || !players) {
    return new Response(JSON.stringify({ error: 'date and players params required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    // Get schedule for the date to find gamePks
    const schedRes = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=team`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!schedRes.ok) throw new Error('Schedule fetch failed: ' + schedRes.status);
    const schedData = await schedRes.json();
    const games = (schedData.dates || [])[0]?.games || [];

    if (!games.length) {
      return new Response(JSON.stringify({ date, games: 0, players: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Only look at completed/in-progress games
    const finishedGames = games.filter(g =>
      ['Final','Game Over','Completed Early','Pre-Game','Live'].includes(g.status?.detailedState) ||
      g.status?.statusCode === 'F' || g.status?.statusCode === 'O'
    );

    // Fetch box scores for all finished games in parallel
    const boxScores = await Promise.all(
      finishedGames.map(g =>
        fetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`, {
          headers: { 'Accept': 'application/json' }
        })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
      )
    );

    // Build player hit map from all box scores
    const hitMap = {}; // normalized name -> {hits, atBats, gameStatus}
    boxScores.forEach((box, i) => {
      if (!box) return;
      const gameStatus = finishedGames[i]?.status?.detailedState || 'Unknown';
      const gamePk = finishedGames[i]?.gamePk;
      ['home','away'].forEach(side => {
        const batters = box.teams?.[side]?.batters || [];
        const players = box.teams?.[side]?.players || {};
        batters.forEach(batterId => {
          const player = players['ID' + batterId];
          if (!player) return;
          const name = player.person?.fullName || '';
          const stats = player.stats?.batting || {};
          const hits = parseInt(stats.hits || 0);
          const ab = parseInt(stats.atBats || 0);
          if (name) {
            hitMap[name.toLowerCase()] = { hits, atBats: ab, gameStatus, gamePk };
          }
        });
      });
    });

    // Check each requested player
    const playerNames = players.split(',').map(p => p.trim());
    const results = playerNames.map(name => {
      const key = name.toLowerCase();
      const data = hitMap[key];
      // Fuzzy match if exact not found
      let matched = data;
      if (!matched) {
        const parts = key.split(' ');
        const lastName = parts[parts.length - 1];
        const matchKey = Object.keys(hitMap).find(k => k.endsWith(lastName) && k[0] === key[0]);
        if (matchKey) matched = hitMap[matchKey];
      }

      if (!matched) return { name, gotHit: null, hits: null, atBats: null, gameStatus: 'No game found', note: 'not in box score' };
      return {
        name,
        gotHit: matched.hits > 0,
        hits: matched.hits,
        atBats: matched.atBats,
        gameStatus: matched.gameStatus,
      };
    });

    return new Response(JSON.stringify({
      date,
      gamesChecked: finishedGames.length,
      totalGames: games.length,
      players: results,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      }
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
