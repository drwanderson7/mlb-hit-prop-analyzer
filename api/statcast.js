export const config = { runtime: 'edge' };

export default async function handler(req) {
  const params = new URL(req.url).searchParams;
  const year = params.get('year') || new Date().getFullYear();
  const type = params.get('type') || 'batter';
  const hand = params.get('hand') || '';

  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://baseballsavant.mlb.com/',
  };

  const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

  // ── URL 1: expected_statistics — provides xBA, xSLG, xwOBA ──────────────────
  let url1 = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=${type}&year=${year}&position=&team=&min=1&csv=true`;
  if (hand) url1 += `&pitcher_hand=${hand}`;

  // ── URL 2: statcast leaderboard — provides K%, HH%, Barrel%, Whiff% ─────────
  // Only fetch for overall (no hand split) — splits don't have these columns reliably
  // For pitchers we still get whiff% and barrel allowed from here
  let url2 = null;
  if (!hand) {
    if (type === 'batter') {
      url2 = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${year}&position=&team=&min=1&csv=true`;
    } else if (type === 'pitcher') {
      url2 = `https://baseballsavant.mlb.com/leaderboard/statcast?type=pitcher&year=${year}&position=&team=&min=1&csv=true`;
    }
  }

  try {
    // Fetch both in parallel — url2 may be null (hand splits)
    const [res1, res2] = await Promise.all([
      fetch(url1, { headers: commonHeaders }),
      url2 ? fetch(url2, { headers: commonHeaders }) : Promise.resolve(null),
    ]);

    const statusHdr = {
      ...corsHeaders,
      'X-Savant-Status': String(res1.status),
    };

    if (!res1.ok) {
      return new Response(JSON.stringify({ error: `Savant returned ${res1.status}`, url: url1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...statusHdr },
      });
    }

    const csv1 = await res1.text();
    const csv2 = res2 && res2.ok ? await res2.text() : '';

    // If no second fetch needed (hand splits), just return csv1 as-is
    if (!url2 || !csv2 || csv2.trim().startsWith('<') || csv2.length < 100) {
      return new Response(csv1, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Cache-Control': 'public, max-age=21600',
          'X-Savant-Rows': String(csv1.split('\n').length),
          ...statusHdr,
        },
      });
    }

    // ── Merge csv1 (xBA etc) with csv2 (K%, HH%, Barrel%) by player_id ────────
    const parseCSV = (csv) => {
      const lines = csv.trim().split('\n').filter(l => l.trim());
      if (lines.length < 2) return { headers: [], rows: [] };
      // Handle quoted fields like "last_name, first_name"
      const parseRow = (line) => {
        const result = [];
        let cur = '', inQ = false;
        for (const ch of line) {
          if (ch === '"') { inQ = !inQ; }
          else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
          else { cur += ch; }
        }
        result.push(cur.trim());
        return result;
      };
      const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/"/g,''));
      const rows = lines.slice(1).map(l => {
        const vals = parseRow(l);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
        return obj;
      });
      return { headers, rows };
    };

    const { headers: h1, rows: rows1 } = parseCSV(csv1);
    const { headers: h2, rows: rows2 } = parseCSV(csv2);

    // Build lookup from csv2 by player_id
    const csv2ByPlayerId = {};
    rows2.forEach(row => {
      const pid = row['player_id'] || row['batter'] || row['pitcher'] || '';
      if (pid) csv2ByPlayerId[pid] = row;
    });

    // Columns we want to pull from csv2 if not already in csv1
    const wantFromCsv2 = ['k_percent', 'hard_hit_percent', 'barrel_batted_rate', 'brl_percent', 'whiff_percent', 'launch_speed_avg'];

    // Determine which columns csv1 is already missing
    const csv1HasCol = (col) => h1.includes(col);

    // Merge: for each row in csv1, add missing columns from csv2
    const mergedRows = rows1.map(row => {
      const pid = row['player_id'] || row['batter'] || row['pitcher'] || '';
      const csv2Row = csv2ByPlayerId[pid] || {};
      const merged = { ...row };
      wantFromCsv2.forEach(col => {
        if (!csv1HasCol(col) || !merged[col]) {
          if (csv2Row[col] != null && csv2Row[col] !== '') {
            merged[col] = csv2Row[col];
          }
        }
      });
      return merged;
    });

    // Also add any players in csv2 NOT in csv1 (rookies missing from expected_statistics)
    const csv1PlayerIds = new Set(rows1.map(r => r['player_id'] || r['batter'] || r['pitcher'] || ''));
    rows2.forEach(row => {
      const pid = row['player_id'] || row['batter'] || row['pitcher'] || '';
      if (pid && !csv1PlayerIds.has(pid)) {
        // Ensure xba/est_ba column exists (empty) so frontend parser doesn't skip the row
        // Frontend now accepts null xBA as long as k%/hh%/barrel% are present
        const enriched = { ...row, est_ba: row['est_ba'] || '', xba: row['xba'] || '' };
        mergedRows.push(enriched);
      }
    });

    // Rebuild all headers (union)
    const allHeaders = [...new Set([...h1, ...wantFromCsv2.filter(c => !csv1HasCol(c))])];

    // Serialize back to CSV
    const escapeField = (val) => {
      if (val == null) return '';
      const s = String(val);
      return s.includes(',') ? `"${s}"` : s;
    };
    const csvOut = [
      allHeaders.join(','),
      ...mergedRows.map(row => allHeaders.map(h => escapeField(row[h] ?? '')).join(',')),
    ].join('\n');

    return new Response(csvOut, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Cache-Control': 'public, max-age=21600',
        'X-Savant-Rows': String(mergedRows.length),
        'X-Savant-Merged': 'true',
        ...statusHdr,
      },
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message, url: url1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
