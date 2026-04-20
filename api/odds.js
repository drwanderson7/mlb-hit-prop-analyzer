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

// Convert moneyline win prob to expected run share
// Sharp approximation: run share correlates with win prob but is compressed
// A team with 70% win prob scores ~57% of runs, not 70%
// Formula: runShare = 0.5 + (winProb - 0.5) * 0.45
// This gives: 50% -> 50%, 60% -> 54.5%, 70% -> 59%, 80% -> 63.5%
// Capped at 40-60% since even the best team rarely gets >60% of total runs
function winProbToRunShare(winProb) {
  const raw = 0.5 + (winProb - 0.5) * 0.45;
  return Math.min(0.60, Math.max(0.40, raw));
}

export default async function handler(req) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return respond(500, { error: 'ODDS_API_KEY not set' });

  try {
    // Two calls — same cost as before (2 requests per analysis run)
    const [resH2h, resTeam] = await Promise.all([
      fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=h2h,totals&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`),
      fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=team_totals&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`),
    ]);

    const remaining = resH2h.headers.get('x-requests-remaining') || '?';
    if (!resH2h.ok) {
      const err = await resH2h.text();
      throw new Error(`Odds API ${resH2h.status}: ${err.substring(0,200)}`);
    }

    const gamesH2h  = await resH2h.json();
    const gamesTeam = resTeam.ok ? await resTeam.json() : [];
    if (!Array.isArray(gamesH2h)) throw new Error('Unexpected response format');

    // Build team totals map from bulk team_totals call
    const teamTotalsMap = {};
    if (Array.isArray(gamesTeam)) {
      gamesTeam.forEach(game => {
        const homeAbbr = TEAM_MAP[game.home_team];
        const awayAbbr = TEAM_MAP[game.away_team];
        if (!homeAbbr || !awayAbbr) return;
        const homeSamples = [], awaySamples = [];
        (game.bookmakers||[]).forEach(bk => {
          (bk.markets||[]).forEach(mkt => {
            if (mkt.key !== 'team_totals') return;
            (mkt.outcomes||[]).forEach(o => {
              if (o.name !== 'Over') return;
              const desc = o.description || '';
              if (desc === game.home_team) homeSamples.push(o.point);
              else if (desc === game.away_team) awaySamples.push(o.point);
            });
          });
        });
        if (homeSamples.length) teamTotalsMap[homeAbbr] = avg(homeSamples);
        if (awaySamples.length) teamTotalsMap[awayAbbr] = avg(awaySamples);
      });
    }

    const result = {};

    gamesH2h.forEach(game => {
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

      let homeImplied, awayImplied, source;

      if (teamTotalsMap[homeAbbr] && teamTotalsMap[awayAbbr]) {
        // Best: direct team totals from bookmakers
        homeImplied = teamTotalsMap[homeAbbr];
        awayImplied = teamTotalsMap[awayAbbr];
        source = 'team_totals';
      } else {
        // Fallback: use corrected moneyline-to-run-share conversion
        const homeProb = avg(homeProbs) || 0.5;
        const awayProb = avg(awayProbs) || 0.5;
        // Remove vig
        const vigTotal = homeProb + awayProb;
        const normHome = homeProb / vigTotal;
        // Convert win prob to run share (compressed relationship)
        const homeRunShare = winProbToRunShare(normHome);
        homeImplied = gameTotal * homeRunShare;
        awayImplied = gameTotal * (1 - homeRunShare);
        source = 'moneyline_derived';
      }

      result[homeAbbr] = {
        impliedRuns: parseFloat(homeImplied.toFixed(1)),
        gameTotal: parseFloat(gameTotal.toFixed(1)),
        opponent: awayAbbr,
        source,
      };
      result[awayAbbr] = {
        impliedRuns: parseFloat(awayImplied.toFixed(1)),
        gameTotal: parseFloat(gameTotal.toFixed(1)),
        opponent: homeAbbr,
        source,
      };
    });

    return respond(200, {
      games: result,
      count: gamesH2h.length,
      requestsRemaining: remaining,
      teamTotalsFound: Object.keys(teamTotalsMap).length,
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
