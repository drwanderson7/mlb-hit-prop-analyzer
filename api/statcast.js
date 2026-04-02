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
  const iXBA    = col('xba', 'est_ba');
  const iK      = col('k_percent');
  const iHH     = col('hard_hit_percent');
  const iBarrel = col('barrel_batted_rate', 'brl_percent');
  const iWhiff  = col('whiff_percent');
  const iPA     = col('pa');

  if (iName < 0 || iXBA < 0) return {};

  const result = {};
  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const cols = parseCSVLine(line);
    let name = (cols[iName] || '').replace(/"/g, '').trim();
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
        name, pa,
        xba,
        kpct:       safe(iK)      !== null ? safe(iK) / 100      : null,
        hardhitpct: safe(iHH)     !== null ? safe(iHH) / 100     : null,
        barrelpct:  safe(iBarrel) !== null ? safe(iBarrel) / 100 : null,
      };
    } else {
      // pitcher — xba here is xBA allowed
      result[key] = {
        name, pa,
        xbaAllowed:     xba,
        kpct:           safe(iK)      !== null ? safe(iK) / 100      : null,
        hardHitAllowed: safe(iHH)     !== null ? safe(iHH) / 100     : null,
        barrelAllowed:  safe(iBarrel) !== null ? safe(iBarrel) / 100 : null,
        whiffPct:       safe(iWhiff)  !== null ? safe(iWhiff) / 100  : null,
      };
    }
  });
  return result;
}

// Blend current year + prior year weighted by PA count
// paThreshold = PA at which current year gets 100% weight
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

  // 8 fetches in parallel:
  // Batters overall (current + prior) — for K%, HH%, Barrel% which don't have split versions
  // Batters vs RHP (current + prior) — split xBA
  // Batters vs LHP (current + prior) — split xBA
  // Pitchers overall (current + prior) — SP contact metrics
  const urls = [
    `${base}?type=batter&year=${year}&position=&team=&min=1&csv=true`,           // [0] batter current overall
    `${base}?type=batter&year=${prev}&position=&team=&min=100&csv=true`,          // [1] batter prior overall
    `${base}?type=batter&year=${year}&position=&team=&handedness=R&min=1&csv=true`,  // [2] batter current vs RHP
    `${base}?type=batter&year=${prev}&position=&team=&handedness=R&min=50&csv=true`, // [3] batter prior vs RHP
    `${base}?type=batter&year=${year}&position=&team=&handedness=L&min=1&csv=true`,  // [4] batter current vs LHP
    `${base}?type=batter&year=${prev}&position=&team=&handedness=L&min=50&csv=true`, // [5] batter prior vs LHP
    `${base}?type=pitcher&year=${year}&position=&team=&min=1&csv=true`,           // [6] pitcher current
    `${base}?type=pitcher&year=${prev}&position=&team=&min=50&csv=true`,          // [7] pitcher prior
  ];

  try {
    const responses = await Promise.all(urls.map(u => fetch(u, { headers: hdrs })));
    const texts     = await Promise.all(responses.map((r, i) => r.ok ? r.text() : ''));

    const batterOverallCur  = parseCsv(texts[0], 'batter');
    const batterOverallPrior = parseCsv(texts[1], 'batter');
    const batterVsRHPCur    = parseCsv(texts[2], 'batter');
    const batterVsRHPPrior  = parseCsv(texts[3], 'batter');
    const batterVsLHPCur    = parseCsv(texts[4], 'batter');
    const batterVsLHPPrior  = parseCsv(texts[5], 'batter');
    const pitcherCur        = parseCsv(texts[6], 'pitcher');
    const pitcherPrior      = parseCsv(texts[7], 'pitcher');

    // Blend each dataset
    const battersOverall = blend(batterOverallCur,  batterOverallPrior, 100);
    const battersVsRHP   = blend(batterVsRHPCur,    batterVsRHPPrior,   80);
    const battersVsLHP   = blend(batterVsLHPCur,    batterVsLHPPrior,   60); // less PA vs LHP so lower threshold
    const pitchers       = blend(pitcherCur,         pitcherPrior,       80);

    return new Response(JSON.stringify({
      battersOverall,
      battersVsRHP,
      battersVsLHP,
      pitchers,
      meta: {
        year,
        overallCount: Object.keys(battersOverall).length,
        vsRHPCount:   Object.keys(battersVsRHP).length,
        vsLHPCount:   Object.keys(battersVsLHP).length,
        pitcherCount: Object.keys(pitchers).length,
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
