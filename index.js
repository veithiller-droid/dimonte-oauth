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

  if (!CLIENT_ID || !CLIENT_SECRET) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('OAuth env vars missing (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)');
    return;
  }

  // Step 1: Redirect to GitHub
  if (parsed.pathname === '/auth') {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'repo,user',
      redirect_uri: CALLBACK_URL,
    });

    res.writeHead(302, {
      Location: `https://github.com/login/oauth/authorize?${params.toString()}`,
    });
    res.end();
    return;
  }

  // Step 2: GitHub callback -> exchange code for token
  if (parsed.pathname === '/callback') {
    const code = parsed.query.code;

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

      const data = JSON.parse(result.body || '{}');

      if (!data.access_token) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`OAuth token exchange failed: ${result.body}`);
        return;
      }

      const token = data.access_token;
      const payload = `authorization:github:success:${JSON.stringify({
        token,
        provider: 'github',
      })}`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <title>OAuth Callback</title>
</head>
<body>
  <script>
    (function () {
  var payload = ${JSON.stringify(payload)};
  var targetOrigin = ${JSON.stringify(SITE_ORIGIN)};
  var tries = 0;
  var maxTries = 10;

  if (!window.opener || window.opener.closed) {
    document.body.innerText = "OAuth erfolgreich, aber kein opener-Fenster gefunden (window.opener = null).";
    return;
  }

  document.body.innerText = "OAuth erfolgreich. Sende Token an Decap...";

  var timer = setInterval(function () {
    tries++;

    try {
      // exakt an deine Domain
      window.opener.postMessage(payload, targetOrigin);

      // Debug-Zeile: zusätzlich wildcard, falls Origin intern anders aufgelöst wird
      window.opener.postMessage(payload, '*');
    } catch (e) {
      document.body.innerText = "postMessage error: " + e.message;
      clearInterval(timer);
      return;
    }

    if (tries >= maxTries) {
      clearInterval(timer);
      document.body.innerText = "Token mehrfach gesendet. Fenster schließt...";
      setTimeout(function () { window.close(); }, 1000);
    }
  }, 300);
})();
  </script>
</body>
</html>`);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OAuth error: ' + e.message);
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('DiMonte OAuth Proxy running');
});

server.listen(PORT, () => {
  console.log(`OAuth proxy running on port ${PORT}`);
});
