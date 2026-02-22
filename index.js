const http = require('http');
const https = require('https');
const url = require('url');

const CLIENT_ID = (process.env.GITHUB_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.GITHUB_CLIENT_SECRET || '').trim();
const PORT = process.env.PORT || 3000;

const SITE_ORIGIN = 'https://dimontehypnose.de';
const OAUTH_BASE_URL = 'https://miraculous-analysis-production-167a.up.railway.app';
const CALLBACK_URL = `${OAUTH_BASE_URL}/callback`;

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          body: data,
          headers: res.headers,
        })
      );
    });

    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  // CORS (Decap -> OAuth proxy)
  res.setHeader('Access-Control-Allow-Origin', SITE_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Basic request log
  console.log(`[REQ] ${req.method} ${parsed.pathname}`, parsed.query || {});

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('[BOOT] Missing OAuth env vars');
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('OAuth env vars missing (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)');
    return;
  }

  // Health / root
  if (parsed.pathname === '/' || parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('DiMonte OAuth Proxy running');
    return;
  }

  // Step 1: Redirect to GitHub (IMPORTANT: forward state)
  if (parsed.pathname === '/auth') {
    const state = (parsed.query.state || '').toString();

    console.log('[AUTH] hit');
    console.log('[AUTH] state present =', !!state);
    console.log('[AUTH] state =', state || '(none)');

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'repo,user',
      redirect_uri: CALLBACK_URL,
    });

    // Forward Decap state if present (critical for handshake)
    if (state) {
      params.set('state', state);
    }

    const ghUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    console.log('[AUTH] redirect ->', ghUrl);

    res.writeHead(302, { Location: ghUrl });
    res.end();
    return;
  }

  // Step 2: GitHub callback -> exchange code for token -> postMessage to opener
  if (parsed.pathname === '/callback') {
    const code = (parsed.query.code || '').toString();
    const state = (parsed.query.state || '').toString();

    console.log('[CALLBACK] hit');
    console.log('[CALLBACK] code present =', !!code);
    console.log('[CALLBACK] state present =', !!state);
    console.log('[CALLBACK] state =', state || '(none)');

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Missing code');
      return;
    }

    try {
      const body = JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: CALLBACK_URL,
      });

      const result = await httpsPost(
        {
          hostname: 'github.com',
          path: '/login/oauth/access_token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        body
      );

      console.log('[CALLBACK] token exchange status =', result.status);

      const data = safeJsonParse(result.body) || {};
      const token = data.access_token;

      console.log('[CALLBACK] token received =', !!token);
      if (!token) {
        console.error('[CALLBACK] token exchange failed body =', result.body);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`OAuth token exchange failed: ${result.body}`);
        return;
      }

      // IMPORTANT: include state in success payload for Decap
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OAuth Callback</title>
</head>
<body style="font-family: system-ui, sans-serif; padding: 16px;">
  <div id="status">OAuth erfolgreich. Bereite Übergabe an Decap vor…</div>

  <script>
    (function () {
      var token = ${JSON.stringify(token)};
      var provider = "github";
      var state = ${JSON.stringify(state)};
      var targetOrigin = ${JSON.stringify(SITE_ORIGIN)};
      var statusEl = document.getElementById("status");

      // Decap classic success string
      var payloadString = "authorization:github:success:" + JSON.stringify({
        token: token,
        provider: provider,
        state: state
      });

      // Fallback object payload
      var payloadObject = {
        type: "authorization:github:success",
        token: token,
        provider: provider,
        state: state
      };

      var tries = 0;
      var maxTries = 12;

      if (!window.opener || window.opener.closed) {
        statusEl.textContent = "OAuth erfolgreich, aber kein opener-Fenster gefunden (window.opener = null).";
        return;
      }

      statusEl.textContent = "OAuth erfolgreich. Sende Token + state an Decap...";

      var timer = setInterval(function () {
        tries++;

        try {
          // Exact origin (preferred)
          window.opener.postMessage(payloadString, targetOrigin);
          window.opener.postMessage(payloadObject, targetOrigin);

          // Fallback for debugging / origin mismatches
          window.opener.postMessage(payloadString, "*");
          window.opener.postMessage(payloadObject, "*");
        } catch (e) {
          clearInterval(timer);
          statusEl.textContent = "postMessage error: " + e.message;
          return;
        }

        if (tries >= maxTries) {
          clearInterval(timer);
          statusEl.textContent = "Token + state mehrfach gesendet. Fenster schließt...";
          setTimeout(function () {
            window.close();
          }, 1200);
        }
      }, 300);
    })();
  </script>
</body>
</html>`);
    } catch (e) {
      console.error('[CALLBACK] OAuth error:', e);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OAuth error: ' + e.message);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`OAuth proxy running on port ${PORT}`);
  console.log('[BOOT] SITE_ORIGIN =', SITE_ORIGIN);
  console.log('[BOOT] CALLBACK_URL =', CALLBACK_URL);
  console.log('[BOOT] CLIENT_ID present =', !!CLIENT_ID);
  console.log('[BOOT] CLIENT_SECRET present =', !!CLIENT_SECRET);
});
