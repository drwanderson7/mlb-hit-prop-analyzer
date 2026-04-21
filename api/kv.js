export const config = { runtime: 'edge' };

function getConfig() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
  }
  return null;
}

async function kvCommand(commands) {
  const cfg = getConfig();
  if (!cfg) throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN not set');
  const res = await fetch(cfg.url + '/pipeline', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Redis error ' + res.status + ': ' + text.slice(0, 200));
  }
  return res.json();
}

async function kvGet(key) {
  const results = await kvCommand([['GET', key]]);
  const first = results && results[0];
  return first ? first.result : null;
}

async function kvSet(key, value) {
  const ex = 60 * 60 * 24 * 180;
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

  const kvKey = 'mlb_pools_' + pin;

  try {
    if (method === 'GET') {
      const stored = await kvGet(kvKey);
      if (!stored) return respond(404, { error: 'No data found for PIN: ' + pin, pin: pin });
      const data = typeof stored === 'string' ? JSON.parse(stored) : stored;
      return respond(200, { pin: pin, data: data, savedAt: data.savedAt });

    } else if (method === 'POST') {
      const body = await req.json();
      if (!body || !body.pools) return respond(400, { error: 'Request body must include pools array' });
      const toStore = {
        pools:   body.pools,
        tracker: body.tracker || { picks: [] },
        savedAt: new Date().toISOString(),
        pin:     pin,
      };
      await kvSet(kvKey, JSON.stringify(toStore));
      return respond(200, { success: true, pin: pin, savedAt: toStore.savedAt });

    } else {
      return respond(405, { error: 'Method not allowed' });
    }
  } catch(e) {
    return respond(500, { error: e.message });
  }
}

function respond(status, body) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}
