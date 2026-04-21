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

function impliedProb(o) {
  const n = parseFloat(o);
  if (!isFinite(n)) return 0.5;
  return n > 0 ? 100/(n+100) : Math.abs(n)/(Math.abs(n)+100);
}

// Compressed run share: 70% win prob -> ~59% of runs, not 70%
function winProbToRunShare(winProb) {
  const raw = 0.5 + (winProb - 0.5) * 0.45;
  return Math.min(0.60, Math.max(0.40, raw));
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

    const result = {};

    games.forEach(game => {
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

      // Derive team implied runs from moneyline + game total
      const homeProb = avg(homeProbs) || 0.5;
      const awayProb = avg(awayProbs) || 0.5;
      const vigTotal = homeProb + awayProb;
      const normHome = homeProb / vigTotal;
      const homeRunShare = winProbToRunShare(normHome);
      const homeImplied = gameTotal * homeRunShare;
      const awayImplied = gameTotal * (1 - homeRunShare);

      result[homeAbbr] = {
        impliedRuns: parseFloat(homeImplied.toFixed(1)),
        gameTotal: parseFloat(gameTotal.toFixed(1)),
        opponent: awayAbbr,
        source: 'moneyline_derived',
      };
      result[awayAbbr] = {
        impliedRuns: parseFloat(awayImplied.toFixed(1)),
        gameTotal: parseFloat(gameTotal.toFixed(1)),
        opponent: homeAbbr,
        source: 'moneyline_derived',
      };
    });

    return respond(200, {
      games: result,
      count: games.length,
      requestsRemaining: remaining,
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
