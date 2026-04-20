export const config = { runtime: 'edge' };

// Supports MLB_REDIS_URL (Upstash Redis URL format)
// Format: redis://default:<token>@<host>:<port>
// Upstash REST API: https://<host>/pipeline with Bearer <token>

function getConfig() {
  // Option 1: explicit REST vars (ideal)
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
  }
  // Option 2: parse MLB_REDIS_URL
  const raw = process.env.MLB_REDIS_URL || '';
  if (!raw) return null;
  try {
    // Handle rediss:// or redis:// 
    const normalized = raw.replace(/^rediss?:\/\//, 'https://');
    const u = new URL(normalized);
    const token = decodeURIComponent(u.password);
    const host  = u.hostname;
    return { url: `https://${host}`, token };
  } catch(e) {
    return null;
  }
}

async function kvCommand(commands) {
  const cfg = getConfig();
  if (!cfg) throw new Error('KV store not configured');
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function kvGet(key) {
  const results = await kvCommand([['GET', key]]);
  return results[0]?.result ?? null;
}

async function kvSet(key, value) {
  const ex = 60 * 60 * 24 * 180; // 180 days
  await kvCommand([['SET', key, value, 'EX', ex]]);
  return true;
}

export default async function handler(req) {
  const url    = new URL(req.url);
  const method = req.method;
  const pinRaw = url.searchParams.get('pin') || '';
  const pin    = pinRaw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!pin || pin.length < 3 || pin.length > 12) {
    return respond(400, { error: 'Pin must be 3-12 alphanumeric characters' });
  }

  if (!getConfig()) {
    return respond(500, { error: 'KV store not configured. Add KV_REST_API_URL and KV_REST_API_TOKEN in Vercel dashboard.' });
  }

  const kvKey = `mlb_pools_${pin}`;

  try {
    if (method === 'GET') {
      const stored = await kvGet(kvKey);
      if (!stored) return respond(404, { error: 'No data found for PIN: ' + pin, pin });
      const data = typeof stored === 'string' ? JSON.parse(stored) : stored;
      return respond(200, { pin, data, savedAt: data.savedAt });

    } else if (method === 'POST') {
      const body = await req.json();
      if (!body?.pools) return respond(400, { error: 'Request body must include pools array' });
      const toStore = {
        pools:   body.pools,
        tracker: body.tracker || { picks: [] },
        savedAt: new Date().toISOString(),
        pin,
      };
      await kvSet(kvKey, JSON.stringify(toStore));
      return respond(200, { success: true, pin, savedAt: toStore.savedAt });

    } else {
      return respond(405, { error: 'Method not allowed' });
    }
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
    }
  });
}
