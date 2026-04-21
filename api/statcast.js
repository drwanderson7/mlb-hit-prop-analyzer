export const config = { runtime: ‘edge’ };

// Baseball Savant fetch proxy
// Attempts to fetch live data from Savant with aggressive timeouts
// Falls back to empty maps if Savant is unreachable (frontend uses embedded STATCAST dict)

function parseCSVLine(line) {
const result = [];
let cur = ‘’, inQ = false;
for (let i = 0; i < line.length; i++) {
const ch = line[i];
if (ch === ‘”’) {
if (inQ && line[i+1] === ‘”’) { cur += ‘”’; i++; }
else inQ = !inQ;
} else if (ch === ‘,’ && !inQ) { result.push(cur.trim()); cur = ‘’; }
else cur += ch;
}
result.push(cur.trim());
return result;
}

function parseCsv(csv, type = ‘batter’) {
if (!csv || csv.trim().startsWith(’{’) || csv.length < 50) return {};
const lines = csv.trim().split(’\n’).filter(l => l.trim());
if (lines.length < 2) return {};
const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/”/g, ‘’));
const col = (…names) => { for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; } return -1; };

const iName   = col(‘last_name, first_name’, ‘player_name’);
const iXBA    = col(‘xba’, ‘est_ba’);
const iK      = col(‘k_percent’);
const iHH     = col(‘hard_hit_percent’);
const iBarrel = col(‘barrel_batted_rate’, ‘brl_percent’);
const iWhiff  = col(‘whiff_percent’);
const iBA     = col(‘ba’, ‘batting_average’, ‘avg’);
const iPA     = col(‘pa’);

if (iName < 0 || iXBA < 0) return {};

const result = {};
lines.slice(1).forEach(line => {
if (!line.trim()) return;
const cols = parseCSVLine(line);
let name = (cols[iName] || ‘’).replace(/”/g, ‘’).trim();
if (!name) return;
if (name.includes(’,’)) { const p = name.split(’,’); name = p[1].trim() + ’ ’ + p[0].trim(); }
const safe = (idx, scale = 1) => {
if (idx < 0 || idx >= cols.length) return null;
const v = parseFloat((cols[idx] || ‘’).replace(/”/g, ‘’));
return isFinite(v) ? v / scale : null;
};
const xba = safe(iXBA);
if (xba === null || xba < 0 || xba > 0.500) return;
const pa = iPA >= 0 ? (parseInt(cols[iPA]) || 0) : 0;
const key = name.toLowerCase();
if (type === ‘batter’) {
result[key] = { name, pa, xba,
kpct:       safe(iK)  !== null ? safe(iK) / 100  : null,
hardhitpct: safe(iHH) !== null ? safe(iHH) / 100 : null,
barrelpct:  safe(iBarrel) !== null ? safe(iBarrel) / 100 : null,
ba:         safe(iBA) !== null ? safe(iBA) : null,
};
} else {
result[key] = { name, pa, xbaAllowed: xba,
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
const allKeys = new Set([…Object.keys(current), …Object.keys(prior)]);
allKeys.forEach(key => {
const c = current[key], p = prior[key];
if (!c && !p) return;
if (!p) { blended[key] = { …c, source: ‘current’ }; return; }
if (!c || (c.pa || 0) < 10) { blended[key] = { …p, source: ‘prior’ }; return; }
const wC = Math.min(1, (c.pa || 0) / paThreshold);
const wP = 1 - wC;
const blendVal = (cv, pv) => {
if (cv === null && pv === null) return null;
if (cv === null) return pv;
if (pv === null) return cv;
return parseFloat((cv * wC + pv * wP).toFixed(4));
};
const merged = { name: c.name || p.name, pa: c.pa || 0, source: `blend(${c.pa}PA)` };
const numKeys = new Set([…Object.keys(c), …Object.keys(p)].filter(k => ![‘name’,‘pa’,‘source’].includes(k)));
numKeys.forEach(k => { merged[k] = blendVal(c[k] ?? null, p[k] ?? null); });
blended[key] = merged;
});
return blended;
}

const EMPTY = { battersOverall: {}, battersVsRHP: {}, battersVsLHP: {}, pitchers: {}, streak7: {}, streak14: {}, meta: { source: ‘embedded’ } };

export default async function handler(req) {
const year = parseInt(new URL(req.url).searchParams.get(‘year’)) || new Date().getFullYear();
const prev = year - 1;
const hdrs = {
‘User-Agent’: ‘Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36’,
‘Accept’: ‘text/html,application/xhtml+xml,*/*;q=0.9’,
‘Accept-Language’: ‘en-US,en;q=0.9’,
‘Referer’: ‘https://baseballsavant.mlb.com/’,
‘Cache-Control’: ‘no-cache’,
};

const base = ‘https://baseballsavant.mlb.com/leaderboard/expected_statistics’;

// Fetch with tight timeout - return empty string on any failure
const fetchSafe = async (url) => {
try {
const ctrl = new AbortController();
const tid = setTimeout(() => ctrl.abort(), 5000);
const r = await fetch(url, { headers: hdrs, signal: ctrl.signal });
clearTimeout(tid);
if (!r.ok) return ‘’;
const text = await r.text();
return text;
} catch(e) {
return ‘’;
}
};

try {
// Fetch only the 4 most essential URLs in two sequential pairs
// This limits total time to ~10s max even if Savant is slow
const [t0, t1] = await Promise.all([
fetchSafe(`${base}?type=batter&year=${year}&position=&team=&min=1&csv=true`),
fetchSafe(`${base}?type=pitcher&year=${year}&position=&team=&min=1&csv=true`),
]);
const [t2, t3] = await Promise.all([
fetchSafe(`${base}?type=batter&year=${year}&position=&team=&handedness=R&min=1&csv=true`),
fetchSafe(`${base}?type=batter&year=${year}&position=&team=&handedness=L&min=1&csv=true`),
]);
const [t4, t5] = await Promise.all([
fetchSafe(`${base}?type=batter&year=${prev}&position=&team=&min=100&csv=true`),
fetchSafe(`${base}?type=batter&year=${year}&position=&team=&min=1&rolling_days=7&csv=true`),
]);

```
const batterCur   = parseCsv(t0, 'batter');
const pitcherCur  = parseCsv(t1, 'pitcher');
const vsRHPCur    = parseCsv(t2, 'batter');
const vsLHPCur    = parseCsv(t3, 'batter');
const batterPrior = parseCsv(t4, 'batter');
const rolling7Raw = parseCsv(t5, 'batter');

// If we got nothing from Savant, return empty so frontend uses embedded dict
if (Object.keys(batterCur).length === 0) {
  return new Response(JSON.stringify(EMPTY), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' }
  });
}

const battersOverall = blend(batterCur,  batterPrior, 100);
const battersVsRHP   = blend(vsRHPCur,   batterPrior, 80);
const battersVsLHP   = blend(vsLHPCur,   batterPrior, 60);
const pitchers       = blend(pitcherCur, pitcherCur,  80);

const streak7 = {};
Object.keys(rolling7Raw).forEach(key => {
  const p = rolling7Raw[key];
  if (!p || p.pa < 5) return;
  let streakScore = 0;
  if (p.xba !== null) {
    if (p.xba >= .320) streakScore = 2;
    else if (p.xba >= .290) streakScore = 1;
    else if (p.xba <= .180) streakScore = -2;
    else if (p.xba <= .220) streakScore = -1;
  }
  streak7[key] = { xba: p.xba, ba: p.ba, pa: p.pa, kpct: p.kpct, hardhitpct: p.hardhitpct,
    streakScore, label: streakScore >= 2 ? '🔥 Hot' : streakScore === 1 ? '↑ Warm' :
      streakScore <= -2 ? '🧊 Cold' : streakScore === -1 ? '↓ Cool' : '' };
});

return new Response(JSON.stringify({
  battersOverall, battersVsRHP, battersVsLHP, pitchers,
  streak7, streak14: streak7,
  meta: { year, batterCount: Object.keys(battersOverall).length, pitcherCount: Object.keys(pitchers).length, streak7Count: Object.keys(streak7).length }
}), {
  status: 200,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=14400' }
});
```

} catch(e) {
return new Response(JSON.stringify(EMPTY), {
status: 200,
headers: { ‘Content-Type’: ‘application/json’, ‘Access-Control-Allow-Origin’: ‘*’, ‘Cache-Control’: ‘public, max-age=300’ }
});
}
}