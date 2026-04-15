export const config = { runtime: 'edge' };

// Vercel KV REST API wrapper
// Env vars needed: KV_REST_API_URL, KV_REST_API_TOKEN
// These are auto-set when you connect a KV store in Vercel dashboard

const getKVHeaders = () => ({
  'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}`,
  'Content-Type': 'application/json',
});

async function kvGet(key) {
  const url = `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: getKVHeaders() });
  if (!res.ok) throw new Error(`KV GET failed: ${res.status}`);
  const data = await res.json();
  return data.result; // null if not found
}

async function kvSet(key, value, exSeconds) {
  // Store with 180-day expiry by default (one full season)
  const ex = exSeconds || 60 * 60 * 24 * 180;
  const url = `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: getKVHeaders(),
    body: JSON.stringify({ value, ex }),
  });
  if (!res.ok) throw new Error(`KV SET failed: ${res.status}`);
  return true;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const method = req.method;
  const pinRaw = url.searchParams.get('pin') || '';
  const pin = pinRaw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!pin || pin.length < 3 || pin.length > 12) {
    return respond(400, { error: 'Pin must be 3-12 alphanumeric characters' });
  }

  // Check env vars
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return respond(500, { error: 'KV store not configured. Add KV_REST_API_URL and KV_REST_API_TOKEN in Vercel dashboard.' });
  }

  const kvKey = `mlb_pools_${pin}`;

  try {
    if (method === 'GET') {
      // Load pools by PIN
      const stored = await kvGet(kvKey);
      if (!stored) {
        return respond(404, { error: 'No data found for PIN: ' + pin, pin });
      }
      const data = typeof stored === 'string' ? JSON.parse(stored) : stored;
      return respond(200, { pin, data, savedAt: data.savedAt });

    } else if (method === 'POST') {
      // Save pools by PIN
      const body = await req.json();
      if (!body || !body.pools) {
        return respond(400, { error: 'Request body must include pools array' });
      }
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
