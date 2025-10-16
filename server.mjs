import express from 'express';
import 'dotenv/config';
import { shopifyApp, LATEST_API_VERSION } from '@shopify/shopify-app-express';
import { MemorySessionStorage } from '@shopify/shopify-app-session-storage-memory';

const required = ['SHOPIFY_API_KEY','SHOPIFY_API_SECRET','SCOPES','HOST','SESSION_SECRET'];
for (const k of required) {
  if (!process.env[k] || process.env[k].includes('replace_with')) {
    console.warn(`[WARN] Missing or placeholder env var: ${k}`);
  }
}

const PORT = process.env.PORT || 3000;

const shopify = shopifyApp({
  api: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: (process.env.SCOPES || '').split(',').map(s => s.trim()).filter(Boolean),
    hostName: (process.env.HOST || '').replace(/^https?:\/\//, ''),
    apiVersion: LATEST_API_VERSION,
    isEmbeddedApp: true,
  },
  auth: {
    path: '/api/auth',
    callbackPath: '/api/auth/callback',
  },
  sessionStorage: new MemorySessionStorage(),
});

const app = express();

// Basic hardening + JSON
app.use(shopify.cspHeaders());
app.use(express.json());

// --- Auth routes ---
app.use('/api/auth', shopify.auth.begin());
app.use('/api/auth/callback', shopify.auth.callback(), shopify.redirectToShopifyOrAppRoot());

// --- Health check ---
app.get('/api/health', (_req, res) => res.status(200).json({ok: true}));

// --- GDPR endpoints (required for App Store; no-op for dev) ---
app.post('/api/gdpr/customers/data_request', (_req, res) => res.sendStatus(200));
app.post('/api/gdpr/customers/redact', (_req, res) => res.sendStatus(200));
app.post('/api/gdpr/shop/redact', (_req, res) => res.sendStatus(200));

// --- Example protected endpoint (requires session) ---
app.get('/api/me', shopify.validateAuthenticatedSession(), async (req, res) => {
  const session = res.locals.shopify.session;
  res.json({ shop: session.shop, isOnline: session.isOnline });
});

// --- Root: simple embedded page ---
app.get('/', (_req, res) => {
  const apiKey = process.env.SHOPIFY_API_KEY || '';
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Customer Shield</title>
  <link rel="stylesheet" href="https://unpkg.com/@shopify/polaris@12.13.0/build/esm/styles.css" />
  <style> body{ font-family:ui-sans-serif,system-ui; padding:24px; } .wrap{ max-width:960px; margin:0 auto; } .muted{color:#637381; font-size:12px} </style>
</head>
<body>
  <div class="wrap">
    <h1>✅ Customer Shield — minimal starter</h1>
    <p>Приложение установлено и открывается в админке Shopify.</p>
    <p>API key (публичный): <code>${apiKey}</code></p>
    <div style="margin-top:20px">
      <a href="/api/health" target="_blank">/api/health</a> &middot;
      <a href="/api/me" target="_blank">/api/me (требует сессию)</a>
    </div>
    <p class="muted">Это минимальная заглушка. Дальше добавим Polaris UI и логику анти-бот фильтра.</p>
  </div>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <script>
    // Инициализация App Bridge (необязательно для отображения, но полезно для действий)
    const AppBridge = window['app-bridge'];
    if (AppBridge) {
      const createApp = AppBridge.createApp;
      const app = createApp({ apiKey: '${apiKey}', host: new URLSearchParams(window.location.search).get('host') });
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Customer Shield listening on port ${PORT}`);
});
