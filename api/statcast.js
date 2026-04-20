export const config = { runtime: 'edge' };

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

function parseCsv(csv, type = 'batter') {
  if (!csv || csv.trim().startsWith('{')) return {};
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return {};
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, ''));
  const col = (...names) => { for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; } return -1; };

  const iName   = col('last_name, first_name', 'player_name');
  // statcast_leaderboard has separate last_name and first_name columns
  const iLastName  = col('last_name');
  const iFirstName = col('first_name');
  const iXBA    = col('xba', 'est_ba');
  const iK      = col('k_percent');
  const iHH     = col('hard_hit_percent');
  const iBarrel = col('barrel_batted_rate', 'brl_percent');
  const iWhiff  = col('whiff_percent');
  const iBA     = col('ba', 'batting_average', 'avg');
  const iPA     = col('pa');

  if (iName < 0 || iXBA < 0) return {};

  const result = {};
  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const cols = parseCSVLine(line);
    let name = (cols[iName] || '').replace(/"/g, '').trim();
    // Handle separate last_name + first_name columns (statcast_leaderboard format)
    if (!name && iLastName >= 0 && iFirstName >= 0) {
      const last  = (cols[iLastName]  || '').replace(/"/g, '').trim();
      const first = (cols[iFirstName] || '').replace(/"/g, '').trim();
      if (first && last) name = first + ' ' + last;
    }
    if (!name) return;
    if (name.includes(',')) { const p = name.split(','); name = p[1].trim() + ' ' + p[0].trim(); }

    const safe = (idx, scale = 1) => {
      if (idx < 0 || idx >= cols.length) return null;
      const v = parseFloat((cols[idx] || '').replace(/"/g, ''));
      return isFinite(v) ? v / scale : null;
    };

    const xba = safe(iXBA);
    if (xba === null || xba < 0 || xba > 0.500) return;
    const pa = iPA >= 0 ? (parseInt(cols[iPA]) || 0) : 0;
    const key = name.toLowerCase();

    if (type === 'batter') {
      result[key] = {
        name, pa, xba,
        kpct:       safe(iK)      !== null ? safe(iK) / 100      : null,
        hardhitpct: safe(iHH)     !== null ? safe(iHH) / 100     : null,
        barrelpct:  safe(iBarrel) !== null ? safe(iBarrel) / 100 : null,
        ba:         safe(iBA)     !== null ? safe(iBA)           : null,
      };
    } else {
      result[key] = {
        name, pa, xbaAllowed: xba,
        kpct:           safe(iK)      !== null ? safe(iK) / 100      : null,
        hardHitAllowed: safe(iHH)     !== null ? safe(iHH) / 100     : null,
        barrelAllowed:  safe(iBarrel) !== null ? safe(iBarrel) / 100 : null,
        whiffPct:       safe(iWhiff)  !== null ? safe(iWhiff) / 100  : null,
      };
    }
  });
  return result;
}

function blend(current, prior, paThreshold = 100) {
  const blended = {};
  const allKeys = new Set([...Object.keys(current), ...Object.keys(prior)]);
  allKeys.forEach(key => {
    const c = current[key], p = prior[key];
    if (!c && !p) return;
    if (!p) { blended[key] = { ...c, source: 'current' }; return; }
    if (!c || (c.pa || 0) < 10) { blended[key] = { ...p, source: 'prior' }; return; }
    const wC = Math.min(1, (c.pa || 0) / paThreshold);
    const wP = 1 - wC;
    const blendVal = (cv, pv) => {
      if (cv === null && pv === null) return null;
      if (cv === null) return pv;
      if (pv === null) return cv;
      return parseFloat((cv * wC + pv * wP).toFixed(4));
    };
    const merged = { name: c.name || p.name, pa: c.pa || 0, source: `blend(${c.pa}PA)` };
    const numKeys = new Set([...Object.keys(c), ...Object.keys(p)].filter(k => !['name','pa','source'].includes(k)));
    numKeys.forEach(k => { merged[k] = blendVal(c[k] ?? null, p[k] ?? null); });
    blended[key] = merged;
  });
  return blended;
}

export default async function handler(req) {
  const year = parseInt(new URL(req.url).searchParams.get('year')) || new Date().getFullYear();
  const prev = year - 1;
  const hdrs = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
    'Referer': 'https://baseballsavant.mlb.com/',
  };

  const base = 'https://baseballsavant.mlb.com/leaderboard/expected_statistics';
  const rolling = 'https://baseballsavant.mlb.com/leaderboard/rolling';

  // Custom leaderboard URL — includes K%, HH%, Barrel% which expected_statistics lacks
  const custom = 'https://baseballsavant.mlb.com/leaderboard/custom';

  const urls = [
    `${base}?type=batter&year=${year}&position=&team=&min=1&csv=true`,
    `${base}?type=batter&year=${prev}&position=&team=&min=100&csv=true`,
    `${base}?type=batter&year=${year}&position=&team=&handedness=R&min=1&csv=true`,
    `${base}?type=batter&year=${prev}&position=&team=&handedness=R&min=50&csv=true`,
    `${base}?type=batter&year=${year}&position=&team=&handedness=L&min=1&csv=true`,
    `${base}?type=batter&year=${prev}&position=&team=&handedness=L&min=50&csv=true`,
    `${base}?type=pitcher&year=${year}&position=&team=&min=1&csv=true`,
    `${base}?type=pitcher&year=${prev}&position=&team=&min=50&csv=true`,
    // Rolling 7-day and 14-day batter stats
    `${base}?type=batter&year=${year}&position=&team=&min=1&rolling_days=7&csv=true`,
    `${base}?type=batter&year=${year}&position=&team=&min=1&rolling_days=14&csv=true`,
    // statcast_leaderboard: K%, HH%, Barrel%, whiff% — not in expected_statistics endpoint
    `https://baseballsavant.mlb.com/statcast_leaderboard?year=${year}&abs=0&player_type=hitting&min_attempts=0&csv=true`,
    `https://baseballsavant.mlb.com/statcast_leaderboard?year=${prev}&abs=0&player_type=hitting&min_attempts=100&csv=true`,
  ];

  try {
    const responses = await Promise.all(urls.map(u => fetch(u, { headers: hdrs })));
    const texts = await Promise.all(responses.map(r => r.ok ? r.text() : ''));

    const batterCur     = parseCsv(texts[0], 'batter');
    const batterPrior   = parseCsv(texts[1], 'batter');
    const vsRHPCur      = parseCsv(texts[2], 'batter');
    const vsRHPPrior    = parseCsv(texts[3], 'batter');
    const vsLHPCur      = parseCsv(texts[4], 'batter');
    const vsLHPPrior    = parseCsv(texts[5], 'batter');
    const pitcherCur    = parseCsv(texts[6], 'pitcher');
    const pitcherPrior  = parseCsv(texts[7], 'pitcher');
    const rolling7      = parseCsv(texts[8], 'batter');
    const rolling14     = parseCsv(texts[9], 'batter');
    const customCur     = parseCsv(texts[10], 'batter');
    const customPrior   = parseCsv(texts[11], 'batter');

    // Merge K%, HH%, Barrel% from custom leaderboard into batterCur/Prior
    // expected_statistics has xBA but not K% — custom leaderboard has K%/HH%/Barrel% but not xBA
    // Merge by player name key
    const mergeCustomStats = (base, custom) => {
      Object.keys(custom || {}).forEach(key => {
        const c = custom[key];
        if (!c) return;
        if (base[key]) {
          // Fill in missing K%, HH%, Barrel% from custom leaderboard
          if (base[key].kpct === null && c.kpct !== null) base[key].kpct = c.kpct;
          if (base[key].hardhitpct === null && c.hardhitpct !== null) base[key].hardhitpct = c.hardhitpct;
          if (base[key].barrelpct === null && c.barrelpct !== null) base[key].barrelpct = c.barrelpct;
        } else {
          // Player exists in custom but not xBA leaderboard — add them with null xBA
          base[key] = { ...c, xba: null };
        }
      });
    };
    mergeCustomStats(batterCur, customCur);
    mergeCustomStats(batterPrior, customPrior);

    const battersOverall = blend(batterCur,   batterPrior,  100);
    const battersVsRHP   = blend(vsRHPCur,    vsRHPPrior,   80);
    const battersVsLHP   = blend(vsLHPCur,    vsLHPPrior,   60);
    const pitchers       = blend(pitcherCur,  pitcherPrior, 80);

    // Rolling windows — no blending, current season only
    // Compute streak: hot/cold based on xBA and BA over rolling window
    const streak7 = {}, streak14 = {};

    const computeStreak = (rollingData, target) => {
      Object.keys(rollingData).forEach(key => {
        const p = rollingData[key];
        if (!p || p.pa < 5) return; // need at least 5 PA to be meaningful
        const xba = p.xba;
        const ba  = p.ba;
        // Streak score: compare rolling xBA to season average
        // Hot: xBA >= .300 in window, Cold: xBA <= .200
        let streakScore = 0;
        if (xba !== null) {
          if (xba >= .320) streakScore = 2;       // very hot
          else if (xba >= .290) streakScore = 1;  // hot
          else if (xba <= .180) streakScore = -2; // very cold
          else if (xba <= .220) streakScore = -1; // cold
        }
        target[key] = {
          xba, ba, pa: p.pa, kpct: p.kpct, hardhitpct: p.hardhitpct,
          streakScore, // -2 to +2
          label: streakScore >= 2 ? '🔥 Hot' : streakScore === 1 ? '↑ Warm' :
                 streakScore <= -2 ? '🧊 Cold' : streakScore === -1 ? '↓ Cool' : '',
        };
      });
    };

    computeStreak(rolling7, streak7);
    computeStreak(rolling14, streak14);

    return new Response(JSON.stringify({
      battersOverall, battersVsRHP, battersVsLHP, pitchers,
      streak7, streak14,
      meta: {
        year,
        batterCount:  Object.keys(battersOverall).length,
        pitcherCount: Object.keys(pitchers).length,
        streak7Count: Object.keys(streak7).length,
        streak14Count: Object.keys(streak14).length,
      }
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=14400',
      }
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
