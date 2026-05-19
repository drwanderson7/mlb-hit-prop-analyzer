export const config = { runtime: 'edge' };

const TEAM_MAP = {
  'Arizona Diamondbacks':'AZ','Atlanta Braves':'ATL','Baltimore Orioles':'BAL',
  'Boston Red Sox':'BOS','Chicago Cubs':'CHC','Chicago White Sox':'CHW',
  'Cincinnati Reds':'CIN','Cleveland Guardians':'CLE','Colorado Rockies':'COL',
  'Detroit Tigers':'DET','Houston Astros':'HOU','Kansas City Royals':'KC',
  'Los Angeles Angels':'LAA','Los Angeles Dodgers':'LAD','Miami Marlins':'MIA',
  'Milwaukee Brewers':'MIL','Minnesota Twins':'MIN','New York Mets':'NYM',
  'New York Yankees':'NYY','Athletics':'ATH','Oakland Athletics':'ATH',
  'Philadelphia Phillies':'PHI','Pittsburgh Pirates':'PIT','San Diego Padres':'SD',
  'San Francisco Giants':'SF','Seattle Mariners':'SEA','St. Louis Cardinals':'STL',
  'Tampa Bay Rays':'TB','Texas Rangers':'TEX','Toronto Blue Jays':'TOR',
  'Washington Nationals':'WSH',
};

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function getTomorrowUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function impliedProb(o) {
  const n = parseFloat(o);
  if (!isFinite(n)) return 0.5;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

// Convert normalized win probability to expected run differential
// At 50%  → 0.0 run diff (pick'em)
// At 60%  → ~0.44 runs
// At 70%  → ~0.88 runs
// At 80%  → ~1.32 runs
// Capped at ±1.5 runs
function winProbToRunDiff(normWinProb) {
  const diff = (normWinProb - 0.5) * 4.4;
  return Math.min(1.5, Math.max(-1.5, diff));
}

export default async function handler(req) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return respond(500, { error: 'ODDS_API_KEY not set' });

  try {
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=h2h,totals&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`
    );

    const remaining = res.headers.get('x-requests-remaining') || '?';
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Odds API ${res.status}: ${err.substring(0,200)}`);
    }

    const games = await res.json();
    if (!Array.isArray(games)) throw new Error('Unexpected response format');

    const today = getTodayUTC();
    const tomorrow = getTomorrowUTC();

    const todayGames = games.filter(g => {
      const ct = g.commence_time || '';
      return ct.startsWith(today) || ct.startsWith(tomorrow);
    });

    const gameList = todayGames.length > 0 ? todayGames : games;

    const result = {};

    gameList.forEach(game => {
      const homeAbbr = TEAM_MAP[game.home_team];
      const awayAbbr = TEAM_MAP[game.away_team];
      if (!homeAbbr || !awayAbbr) return;

      const totals = [], homeProbs = [], awayProbs = [];

      (game.bookmakers||[]).forEach(bk => {
        (bk.markets||[]).forEach(mkt => {
          if (mkt.key === 'totals') {
            const over = (mkt.outcomes||[]).find(o => o.name === 'Over');
            if (over?.point) totals.push(over.point);
          }
          if (mkt.key === 'h2h') {
            const homeO = (mkt.outcomes||[]).find(o => o.name === game.home_team);
            const awayO = (mkt.outcomes||[]).find(o => o.name === game.away_team);
            if (homeO?.price) homeProbs.push(impliedProb(homeO.price));
            if (awayO?.price) awayProbs.push(impliedProb(awayO.price));
          }
        });
      });

      const gameTotal = avg(totals);
      if (!gameTotal) return;

      // Remove vig, normalize to true win probabilities
      const rawHome = avg(homeProbs) || 0.5;
      const rawAway = avg(awayProbs) || 0.5;
      const vigTotal = rawHome + rawAway;
      const normHome = rawHome / vigTotal;

      // Derive run differential: favorite gets slightly more of the total
      // (total + diff) / 2 for the favorite, (total - diff) / 2 for the dog
      const runDiff = winProbToRunDiff(normHome); // positive = home favored
      const homeImplied = (gameTotal + runDiff) / 2;
      const awayImplied = (gameTotal - runDiff) / 2;

      result[homeAbbr] = {
        impliedRuns: parseFloat(homeImplied.toFixed(1)),
        gameTotal: parseFloat(gameTotal.toFixed(1)),
        opponent: awayAbbr,
        commenceTime: game.commence_time,
        source: 'run_diff_derived',
      };
      result[awayAbbr] = {
        impliedRuns: parseFloat(awayImplied.toFixed(1)),
        gameTotal: parseFloat(gameTotal.toFixed(1)),
        opponent: homeAbbr,
        commenceTime: game.commence_time,
        source: 'run_diff_derived',
      };
    });

    return respond(200, {
      games: result,
      count: gameList.length,
      requestsRemaining: remaining,
      today,
    });

  } catch(e) {
    return respond(500, { error: e.message });
  }
}

function respond(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=600',
    }
  });
}
