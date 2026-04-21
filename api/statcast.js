export const config = { runtime: 'edge' };

export default async function handler(req) {
  const year = new URL(req.url).searchParams.get('year') || new Date().getFullYear();

  const urlCurrent = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&min=1&csv=true`;
  const urlPrior   = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year - 1}&position=&team=&min=100&csv=true`;
  const urlPitcher = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=${year}&position=&team=&min=1&csv=true`;
  const urlRHP     = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&handedness=R&min=1&csv=true`;
  const urlLHP     = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&handedness=L&min=1&csv=true`;
  const urlRoll7   = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&min=1&rolling_days=7&csv=true`;

  const hdrs = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
    'Referer': 'https://baseballsavant.mlb.com/',
  };

  const fetchCsv = async (url) => {
    try {
      const r = await fetch(url, { headers: hdrs });
      return r.ok ? await r.text() : '';
    } catch(e) { return ''; }
  };

  const parseCsv = (csv, type = 'batter') => {
    if (!csv || csv.trim().startsWith('{')) return {};
    const lines = csv.trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) return {};
    const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim().toLowerCase());
    const col = (...names) => { for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; } return -1; };
    const iName   = col('last_name, first_name', 'player_name');
    const iXBA    = col('xba', 'est_ba');
    const iK      = col('k_percent');
    const iHH     = col('hard_hit_percent');
    const iBarrel = col('barrel_batted_rate', 'brl_percent');
    const iWhiff  = col('whiff_percent');
    const iBA     = col('ba', 'batting_average');
    const iPA     = col('pa');
    if (iName < 0 || iXBA < 0) return {};
    const result = {};
    lines.slice(1).forEach(line => {
      if (!line.trim()) return;
      const cols = line.split(',').map(c => c.replace(/"/g,'').trim());
      let name = cols[iName] || '';
      if (name.includes(',')) { const p = name.split(','); name = p[1].trim() + ' ' + p[0].trim(); }
      if (!name) return;
      const safe = (i, div = 1) => { if (i < 0 || i >= cols.length) return null; const v = parseFloat(cols[i]); return isFinite(v) ? v / div : null; };
      const xba = safe(iXBA);
      if (!xba || xba < 0 || xba > 0.500) return;
      const pa = parseInt(cols[iPA]) || 0;
      const key = name.toLowerCase();
      if (type === 'batter') {
        result[key] = { name, pa, xba, kpct: safe(iK, 100), hardhitpct: safe(iHH, 100), barrelpct: safe(iBarrel, 100), ba: safe(iBA) };
      } else {
        result[key] = { name, pa, xbaAllowed: xba, kpct: safe(iK, 100), hardHitAllowed: safe(iHH, 100), barrelAllowed: safe(iBarrel, 100), whiffPct: safe(iWhiff, 100) };
      }
    });
    return result;
  };

  const blend = (cur, pri, thresh = 100) => {
    const out = {};
    new Set([...Object.keys(cur), ...Object.keys(pri)]).forEach(k => {
      const c = cur[k], p = pri[k];
      if (!c && !p) return;
      if (!p) { out[k] = { ...c, source: 'current' }; return; }
      if (!c || (c.pa || 0) < 10) { out[k] = { ...p, source: 'prior' }; return; }
      const wC = Math.min(1, (c.pa || 0) / thresh), wP = 1 - wC;
      const bv = (a, b) => (a == null && b == null) ? null : a == null ? b : b == null ? a : +(a * wC + b * wP).toFixed(4);
      const merged = { name: c.name || p.name, pa: c.pa, source: `blend(${c.pa}PA)` };
      new Set([...Object.keys(c), ...Object.keys(p)].filter(k => !['name','pa','source'].includes(k))).forEach(f => { merged[f] = bv(c[f] ?? null, p[f] ?? null); });
      out[k] = merged;
    });
    return out;
  };

  try {
    const [tCur, tPri, tPit, tRHP, tLHP, tR7] = await Promise.all([
      fetchCsv(urlCurrent), fetchCsv(urlPrior), fetchCsv(urlPitcher),
      fetchCsv(urlRHP), fetchCsv(urlLHP), fetchCsv(urlRoll7),
    ]);

    const battersOverall = blend(parseCsv(tCur), parseCsv(tPri), 100);
    const battersVsRHP   = blend(parseCsv(tRHP), parseCsv(tPri), 80);
    const battersVsLHP   = blend(parseCsv(tLHP), parseCsv(tPri), 60);
    const pitchers       = blend(parseCsv(tPit, 'pitcher'), {}, 80);

    const streak7 = {};
    Object.entries(parseCsv(tR7)).forEach(([key, p]) => {
      if (!p || p.pa < 5 || p.xba == null) return;
      let sc = 0;
      if (p.xba >= .320) sc = 2; else if (p.xba >= .290) sc = 1;
      else if (p.xba <= .180) sc = -2; else if (p.xba <= .220) sc = -1;
      streak7[key] = { xba: p.xba, ba: p.ba, pa: p.pa, kpct: p.kpct, hardhitpct: p.hardhitpct,
        streakScore: sc, label: sc >= 2 ? '🔥 Hot' : sc === 1 ? '↑ Warm' : sc <= -2 ? '🧊 Cold' : sc === -1 ? '↓ Cool' : '' };
    });

    return new Response(JSON.stringify({
      battersOverall, battersVsRHP, battersVsLHP, pitchers, streak7, streak14: streak7,
      meta: { year, batterCount: Object.keys(battersOverall).length, pitcherCount: Object.keys(pitchers).length }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=14400' }
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
