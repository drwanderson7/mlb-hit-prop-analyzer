export const config = { runtime: 'edge' };

// Team name normalization — Odds API uses full names, MLB API uses abbreviations
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
  if (!americanOdds) return 0.5;
  const o = parseFloat(americanOdds);
  if (isNaN(o)) return 0.5;
  if (o > 0) return 100 / (o + 100);
  return Math.abs(o) / (Math.abs(o) + 100);
}

export default async function handler(req) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'ODDS_API_KEY not set' }), {
    status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });

  try {
    // Fetch h2h (moneyline) + totals + team_totals in one call
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=h2h,totals,team_totals&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Odds API returned ${res.status}`);
    const games = await res.json();

    const result = {};

    games.forEach(game => {
      const homeAbbr = TEAM_MAP[game.home_team] || game.home_team;
      const awayAbbr = TEAM_MAP[game.away_team] || game.away_team;

      let gameTotal = null;
      let homeImplied = null;
      let awayImplied = null;
      let homeTeamTotal = null;
      let awayTeamTotal = null;

      // Average across bookmakers for stability
      const totalSamples = [], homeMLSamples = [], awayMLSamples = [];
      const homeTeamTotalSamples = [], awayTeamTotalSamples = [];

      (game.bookmakers || []).forEach(bk => {
        (bk.markets || []).forEach(mkt => {
          if (mkt.key === 'totals') {
            const over = mkt.outcomes.find(o => o.name === 'Over');
            if (over?.point) totalSamples.push(over.point);
          }
          if (mkt.key === 'h2h') {
            const homeO = mkt.outcomes.find(o => o.name === game.home_team);
            const awayO = mkt.outcomes.find(o => o.name === game.away_team);
            if (homeO?.price) homeMLSamples.push(impliedProb(homeO.price));
            if (awayO?.price) awayMLSamples.push(impliedProb(awayO.price));
          }
          if (mkt.key === 'team_totals') {
            const homeO = mkt.outcomes.find(o => o.name === game.home_team && o.description === 'Over' || o.description?.includes('Over') && o.name === game.home_team);
            const awayO = mkt.outcomes.find(o => o.name === game.away_team && o.description === 'Over' || o.description?.includes('Over') && o.name === game.away_team);
            // team_totals outcomes have {name: 'Over'/'Under', description: team name, point: X}
            mkt.outcomes.forEach(o => {
              if (o.description === game.home_team && o.name === 'Over') homeTeamTotalSamples.push(o.point);
              if (o.description === game.away_team && o.name === 'Over') awayTeamTotalSamples.push(o.point);
            });
          }
        });
      });

      const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;

      gameTotal = avg(totalSamples);
      const homeWinProb = avg(homeMLSamples);
      const awayWinProb = avg(awayMLSamples);

      // Team totals: prefer direct team total lines, fall back to deriving from game total + moneyline
      homeTeamTotal = avg(homeTeamTotalSamples);
      awayTeamTotal = avg(awayTeamTotalSamples);

      // Fallback derivation if team totals not available:
      // Implied runs ≈ game total × team's share of run probability
      // Simple approximation: home_runs = total * home_win_prob * 0.95 (rough but reasonable)
      if (!homeTeamTotal && gameTotal && homeWinProb) {
        // Better method: use pythagorean-style split
        // If total = 8.5 and home ML implies 55% win, home gets ~55% of scoring
        homeTeamTotal = parseFloat((gameTotal * (homeWinProb || 0.5)).toFixed(1));
        awayTeamTotal = parseFloat((gameTotal * (awayWinProb || 0.5)).toFixed(1));
      }

      const gameKey = `${awayAbbr}@${homeAbbr}`;
      result[gameKey] = {
        homeTeam: homeAbbr,
        awayTeam: awayAbbr,
        gameTotal:      gameTotal      ? parseFloat(gameTotal.toFixed(1))      : null,
        homeImplied:    homeTeamTotal  ? parseFloat(homeTeamTotal.toFixed(1))  : null,
        awayImplied:    awayTeamTotal  ? parseFloat(awayTeamTotal.toFixed(1))  : null,
        homeWinProb:    homeWinProb    ? parseFloat(homeWinProb.toFixed(3))    : null,
        awayWinProb:    awayWinProb    ? parseFloat(awayWinProb.toFixed(3))    : null,
        commence:       game.commence_time,
      };
      // Also index by each team abbr for easy lookup
      result[homeAbbr] = { impliedRuns: result[gameKey].homeImplied, gameTotal: result[gameKey].gameTotal, opponent: awayAbbr };
      result[awayAbbr] = { impliedRuns: result[gameKey].awayImplied, gameTotal: result[gameKey].gameTotal, opponent: homeAbbr };
    });

    return new Response(JSON.stringify({ games: result, count: games.length }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=1800', // 30 min cache — odds move
      }
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
