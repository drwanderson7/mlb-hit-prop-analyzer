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

export default async function handler(req) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return respond(500, { error: 'ODDS_API_KEY not set' });

  try {
    // Fetch team_totals + totals markets — team_totals are the actual per-team lines set by books
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=totals,team_totals&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`
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

      const totals = [];
      // team_totals keyed by team name → array of points from each book
      const teamTotalsMap = { [game.home_team]: [], [game.away_team]: [] };

      (game.bookmakers||[]).forEach(bk => {
        (bk.markets||[]).forEach(mkt => {
          if (mkt.key === 'totals') {
            const over = (mkt.outcomes||[]).find(o => o.name === 'Over');
            if (over?.point) totals.push(over.point);
          }
          if (mkt.key === 'team_totals') {
            (mkt.outcomes||[]).forEach(o => {
              // outcome name is "Over" or "Under", description is team name
              if (o.name === 'Over' && o.description && teamTotalsMap[o.description] !== undefined) {
                teamTotalsMap[o.description].push(o.point);
              }
            });
          }
        });
      });

      const gameTotal = avg(totals);
      if (!gameTotal) return;

      // Prefer direct team totals; fall back to splitting game total 50/50
      const homeTeamTotals = teamTotalsMap[game.home_team];
      const awayTeamTotals = teamTotalsMap[game.away_team];

      let homeImplied, awayImplied, source;

      if (homeTeamTotals.length > 0 && awayTeamTotals.length > 0) {
        // Best case: direct team totals from books
        homeImplied = avg(homeTeamTotals);
        awayImplied = avg(awayTeamTotals);
        source = 'team_totals';
      } else if (homeTeamTotals.length > 0) {
        homeImplied = avg(homeTeamTotals);
        awayImplied = gameTotal - homeImplied;
        source = 'team_totals_partial';
      } else if (awayTeamTotals.length > 0) {
        awayImplied = avg(awayTeamTotals);
        homeImplied = gameTotal - awayImplied;
        source = 'team_totals_partial';
      } else {
        // Fallback: split game total evenly — no moneyline distortion
        homeImplied = gameTotal / 2;
        awayImplied = gameTotal / 2;
        source = 'game_total_split';
      }

      result[homeAbbr] = {
        impliedRuns: parseFloat(homeImplied.toFixed(1)),
        gameTotal: parseFloat(gameTotal.toFixed(1)),
        opponent: awayAbbr,
        commenceTime: game.commence_time,
        source,
      };
      result[awayAbbr] = {
        impliedRuns: parseFloat(awayImplied.toFixed(1)),
        gameTotal: parseFloat(gameTotal.toFixed(1)),
        opponent: homeAbbr,
        commenceTime: game.commence_time,
        source,
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
