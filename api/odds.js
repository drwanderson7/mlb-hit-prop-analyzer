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

function impliedProb(americanOdds) {
  const o = parseFloat(americanOdds);
  if (!isFinite(o)) return 0.5;
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
}

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }

export default async function handler(req) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'ODDS_API_KEY env var not set in Vercel' }), {
    status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });

  try {
    // Fetch h2h + totals first (team_totals may not always be available)
    const [resH2h, resTeam] = await Promise.all([
      fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=h2h,totals&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`),
      fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=team_totals&oddsFormat=american&bookmakers=draftkings,fanduel`),
    ]);

    // Log remaining requests for debugging
    const remainingH2h = resH2h.headers.get('x-requests-remaining') || '?';

    if (!resH2h.ok) {
      const errText = await resH2h.text();
      throw new Error(`Odds API ${resH2h.status}: ${errText.substring(0,200)}`);
    }

    const gamesH2h  = await resH2h.json();
    const gamesTeam = resTeam.ok ? await resTeam.json() : [];

    // Build team totals map from second call
    const teamTotalsMap = {}; // "HomeAbbr|AwayAbbr|TeamAbbr" -> implied runs
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
              const teamName = o.description || '';
              if (teamName === game.home_team) homeSamples.push(o.point);
              if (teamName === game.away_team) awaySamples.push(o.point);
            });
          });
        });
        if (homeSamples.length) teamTotalsMap[homeAbbr] = avg(homeSamples);
        if (awaySamples.length) teamTotalsMap[awayAbbr] = avg(awaySamples);
      });
    }

    const result = {};

    if (!Array.isArray(gamesH2h)) throw new Error('Unexpected response: ' + JSON.stringify(gamesH2h).substring(0,200));

    gamesH2h.forEach(game => {
      const homeAbbr = TEAM_MAP[game.home_team];
      const awayAbbr = TEAM_MAP[game.away_team];
      if (!homeAbbr || !awayAbbr) return;

      const gameTotals = [], homeProbSamples = [], awayProbSamples = [];

      (game.bookmakers||[]).forEach(bk => {
        (bk.markets||[]).forEach(mkt => {
          if (mkt.key === 'totals') {
            const over = (mkt.outcomes||[]).find(o => o.name === 'Over');
            if (over?.point) gameTotals.push(over.point);
          }
          if (mkt.key === 'h2h') {
            const homeO = (mkt.outcomes||[]).find(o => o.name === game.home_team);
            const awayO = (mkt.outcomes||[]).find(o => o.name === game.away_team);
            if (homeO?.price) homeProbSamples.push(impliedProb(homeO.price));
            if (awayO?.price) awayProbSamples.push(impliedProb(awayO.price));
          }
        });
      });

      const gameTotal   = avg(gameTotals);
      const homeWinProb = avg(homeProbSamples);
      const awayWinProb = avg(awayProbSamples);

      // Team implied runs: prefer direct team totals, derive from game total + ML if missing
      let homeImplied = teamTotalsMap[homeAbbr] || null;
      let awayImplied = teamTotalsMap[awayAbbr] || null;

      if (!homeImplied && gameTotal && homeWinProb) {
        // Normalize probs (remove vig)
        const total = (homeWinProb||0.5) + (awayWinProb||0.5);
        const normHome = (homeWinProb||0.5) / total;
        const normAway = (awayWinProb||0.5) / total;
        homeImplied = parseFloat((gameTotal * normHome).toFixed(1));
        awayImplied = parseFloat((gameTotal * normAway).toFixed(1));
      }

      const gameKey = `${awayAbbr}@${homeAbbr}`;
      result[gameKey] = {
        homeTeam: homeAbbr, awayTeam: awayAbbr,
        gameTotal:   gameTotal   ? parseFloat(gameTotal.toFixed(1))   : null,
        homeImplied: homeImplied ? parseFloat(homeImplied.toFixed(1)) : null,
        awayImplied: awayImplied ? parseFloat(awayImplied.toFixed(1)) : null,
      };
      // Index by team abbr for easy lookup
      if (homeImplied) result[homeAbbr] = { impliedRuns: parseFloat(homeImplied.toFixed(1)), gameTotal, opponent: awayAbbr };
      if (awayImplied) result[awayAbbr] = { impliedRuns: parseFloat(awayImplied.toFixed(1)), gameTotal, opponent: homeAbbr };
    });

    return new Response(JSON.stringify({
      games: result,
      count: gamesH2h.length,
      requestsRemaining: remainingH2h,
      teamTotalsFound: Object.keys(teamTotalsMap).length,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=600',
      }
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
