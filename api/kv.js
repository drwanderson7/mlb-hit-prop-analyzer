export const config = { runtime: 'edge' };

// Works with either:
// - KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV)
// - MLB_REDIS_URL (raw Redis URL — parsed to build REST calls via Upstash)

function getConfig() {
  // Prefer explicit KV REST vars
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return {
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    };
  }
  // Fall back to MLB_REDIS_URL — parse Upstash Redis URL format:
  // redis://default:<token>@<host>:<port>
  const redisUrl = process.env.MLB_REDIS_URL;
  if (redisUrl) {
    try {
      const parsed = new URL(redisUrl);
      const token = parsed.password; // the auth token
      const host  = parsed.hostname;
      // Upstash REST API is at https://<host> with Bearer token
      return {
        url: `https://${host}`,
        token,
      };
    } catch(e) {
      return null;
    }
  }
  return null;
}

async function kvGet(key) {
  const cfg = getConfig();
  if (!cfg) throw new Error('KV store not configured');
  const res = await fetch(`${cfg.url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${cfg.token}` },
  });
  if (!res.ok) throw new Error(`KV GET failed: ${res.status}`);
  const data = await res.json();
  return data.result ?? null;
}

async function kvSet(key, value) {
  const cfg = getConfig();
  if (!cfg) throw new Error('KV store not configured');
  // Upstash REST: POST /set/<key>/<value>  OR  POST /set/<key> with body
  // Use pipeline-style: POST / with JSON body [["SET", key, value, "EX", seconds]]
  const ex = 60 * 60 * 24 * 180; // 180 days
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([['SET', key, value, 'EX', ex]]),
  });
  if (!res.ok) throw new Error(`KV SET failed: ${res.status}`);
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
