export const config = { runtime: 'edge' };

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; } // escaped quote
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseCsv(csv) {
  if (!csv || csv.trim().startsWith('{')) return {};
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return {};

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g,''));

  const col = (...names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iName   = col('last_name, first_name', 'player_name', 'name');
  const iXBA    = col('xba', 'est_ba');
  const iK      = col('k_percent');
  const iHH     = col('hard_hit_percent');
  const iBarrel = col('barrel_batted_rate', 'brl_percent', 'barrel_batted_rate');
  const iPA     = col('pa');

  if (iName < 0 || iXBA < 0) return {};

  const result = {};
  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const cols = parseCSVLine(line);
    let name = (cols[iName] || '').replace(/"/g,'').trim();
    if (!name) return;
    // Savant uses "Last, First" — convert
    if (name.includes(',')) {
      const p = name.split(',');
      name = p[1].trim() + ' ' + p[0].trim();
    }

    const safeFloat = (idx, scale = 1) => {
      if (idx < 0 || idx >= cols.length) return null;
      const v = parseFloat((cols[idx] || '').replace(/"/g,''));
      return isFinite(v) ? v / scale : null;
    };

    const xba        = safeFloat(iXBA);
    const kpct       = safeFloat(iK, 1);      // already a percent like 22.5
    const hardhitpct = safeFloat(iHH, 1);     // already a percent like 45.2
    const barrelpct  = safeFloat(iBarrel, 1); // already a percent like 8.1
    const pa         = iPA >= 0 ? (parseInt(cols[iPA]) || 0) : 0;

    // Validate — all must be in sane ranges
    if (xba === null || xba < 0 || xba > 0.500) return;
    if (kpct !== null && (kpct < 0 || kpct > 100)) return;
    if (hardhitpct !== null && (hardhitpct < 0 || hardhitpct > 100)) return;
    if (barrelpct !== null && (barrelpct < 0 || barrelpct > 100)) return;

    result[name.toLowerCase()] = {
      name,
      pa,
      xba,
      kpct:        kpct        !== null ? kpct / 100        : null,
      hardhitpct:  hardhitpct  !== null ? hardhitpct / 100  : null,
      barrelpct:   barrelpct   !== null ? barrelpct / 100   : null,
    };
  });
  return result;
}

export default async function handler(req) {
  const year = parseInt(new URL(req.url).searchParams.get('year')) || new Date().getFullYear();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
    'Referer': 'https://baseballsavant.mlb.com/',
  };

  try {
    const [resCurrent, resPrior] = await Promise.all([
      fetch(`https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&min=1&csv=true`, { headers }),
      fetch(`https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year-1}&position=&team=&min=100&csv=true`, { headers }),
    ]);

    const current = parseCsv(resCurrent.ok ? await resCurrent.text() : '');
    const prior   = parseCsv(resPrior.ok   ? await resPrior.text()   : '');

    // Blend by PA: <10 PA → prior only; 10-99 → weighted; 100+ → current only
    const blended = {};
    const allKeys = new Set([...Object.keys(current), ...Object.keys(prior)]);

    allKeys.forEach(key => {
      const c = current[key];
      const p = prior[key];
      if (!p && !c) return;
      if (!p) { blended[key] = { ...c, source: 'current' }; return; }
      if (!c || c.pa < 10) { blended[key] = { ...p, source: 'prior' }; return; }

      const wC = Math.min(1, c.pa / 100);
      const wP = 1 - wC;

      const blendStat = (cs, ps) => {
        if (cs === null && ps === null) return null;
        if (cs === null) return ps;
        if (ps === null) return cs;
        return parseFloat((cs * wC + ps * wP).toFixed(4));
      };

      blended[key] = {
        name: c.name || p.name,
        pa: c.pa,
        source: `blend(${c.pa}PA)`,
        xba:        parseFloat((c.xba * wC + p.xba * wP).toFixed(3)),
        kpct:       blendStat(c.kpct,       p.kpct),
        hardhitpct: blendStat(c.hardhitpct, p.hardhitpct),
        barrelpct:  blendStat(c.barrelpct,  p.barrelpct),
      };
    });

    return new Response(JSON.stringify({
      players: blended,
      meta: {
        currentYear: year,
        currentCount: Object.keys(current).length,
        priorCount: Object.keys(prior).length,
        blendedCount: Object.keys(blended).length,
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
