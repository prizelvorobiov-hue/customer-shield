import express from 'express';
import 'dotenv/config';

// @shopify/shopify-app-express у тебя идёт как CJS → берём default
import appExpress from '@shopify/shopify-app-express';
const { shopifyApp, LATEST_API_VERSION } = appExpress;

import { MemorySessionStorage } from '@shopify/shopify-app-session-storage-memory';

// --- sanity-check env ---
const required = ['SHOPIFY_API_KEY','SHOPIFY_API_SECRET','SCOPES','HOST','SESSION_SECRET'];
for (const k of required) {
  if (!process.env[k] || process.env[k].includes('replace_with')) {
    console.warn(`[WARN] Missing or placeholder env var: ${k}`);
  }
}

const PORT = process.env.PORT || 3000;

// --- Shopify app bootstrap ---
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
app.use(shopify.cspHeaders());
app.use(express.json());

// --- Auth routes ---
app.use('/api/auth', shopify.auth.begin());
app.use('/api/auth/callback', shopify.auth.callback(), shopify.redirectToShopifyOrAppRoot());

// --- Health ---
app.get('/api/health', (_req, res) => res.status(200).json({ ok: true }));

// --- GDPR (обязательные заглушки для App Store) ---
app.post('/api/gdpr/customers/data_request', (_req, res) => res.sendStatus(200));
app.post('/api/gdpr/customers/redact', (_req, res) => res.sendStatus(200));
app.post('/api/gdpr/shop/redact', (_req, res) => res.sendStatus(200));

// --- Пример защищённого эндпойнта ---
app.get('/api/me', shopify.validateAuthenticatedSession(), async (_req, res) => {
  const session = res.locals.shopify.session;
  res.json({ shop: session.shop, isOnline: session.isOnline });
});

// ====== НИЖЕ — логика сканирования и тегирования ======
const gql = String.raw;

const CUSTOMERS_QUERY = gql`
  query Customers($first: Int!, $after: String) {
    customers(first: $first, after: $after, sortKey: ID) {
      edges {
        cursor
        node {
          id
          displayName
          email
          firstName
          lastName
          tags
          addresses { city country }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

const TAGS_ADD_MUTATION = gql`
  mutation tagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

// Простые эвристики «подозрительности»
function reasonsForSuspect(c) {
  const reasons = [];
  const fn = (c.firstName || '').trim();
  const ln = (c.lastName || '').trim();
  const display = (c.displayName || '').trim();
  const email = (c.email || '').trim().toLowerCase();
  const hasAddr = Array.isArray(c.addresses) && c.addresses.length > 0;

  if (!fn && !ln) reasons.push('empty first/last name');
  if (!hasAddr) reasons.push('no addresses');
  const displayLooksLikeEmail = display.includes('@') || display.endsWith('.com');
  if (displayLooksLikeEmail) reasons.push('display name looks like email');
  if (email.endsWith('.com') && displayLooksLikeEmail) reasons.push('email .com + display=email');

  return reasons;
}

// GET /api/customers/scan — собрать «подозрительных»
app.get('/api/customers/scan', shopify.validateAuthenticatedSession(), async (_req, res) => {
  const session = res.locals.shopify.session;
  const client = new shopify.api.clients.Graphql({ session });

  const batch = Number(_req.query.batch || 250);
  const max = Math.min(Number(_req.query.max || 1000), 5000);
  let after = undefined, collected = 0;

  const suspects = [];

  while (collected < max) {
    const data = await client.request(CUSTOMERS_QUERY, {
      variables: { first: Math.min(batch, max - collected), after },
    });
    const edges = data.customers.edges || [];
    for (const { cursor, node } of edges) {
      const reasons = reasonsForSuspect(node);
      if (reasons.length) {
        suspects.push({
          id: node.id,
          displayName: node.displayName,
          email: node.email,
          firstName: node.firstName,
          lastName: node.lastName,
          reasons
        });
      }
      after = cursor;
      collected++;
    }
    if (!data.customers.pageInfo.hasNextPage) break;
  }

  res.json({ totalChecked: collected, suspects });
});

// POST /api/customers/tag — массово поставить тег (по умолчанию suspect_bot)
app.post('/api/customers/tag', shopify.validateAuthenticatedSession(), async (req, res) => {
  const { ids = [], tag = 'suspect_bot' } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });

  const session = res.locals.shopify.session;
  const client = new shopify.api.clients.Graphql({ session });

  const results = [];
  for (const id of ids) {
    const out = await client.request(TAGS_ADD_MUTATION, { variables: { id, tags: [tag] } });
    results.push({ id, errors: out?.tagsAdd?.userErrors || [] });
  }
  res.json({ ok: true, results });
});
// ====== /логика сканирования ======

// --- Встроенная страница админки с кнопками ---
app.get('/', (_req, res) => {
  const apiKey = process.env.SHOPIFY_API_KEY || '';
  res.type('html').send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Customer Shield</title>
  <link rel="stylesheet" href="https://unpkg.com/@shopify/polaris@12.13.0/build/esm/styles.css" />
  <style>
    body{font-family:ui-sans-serif,system-ui;background:#f6f6f7}
    .wrap{max-width:1000px;margin:24px auto;padding:16px}
    .card{background:#fff;border:1px solid #e1e3e5;border-radius:12px;padding:16px}
    table{width:100%;border-collapse:collapse}
    th,td{padding:8px;border-bottom:1px solid #eee;font-size:14px}
    th{text-align:left}
    .muted{color:#637381;font-size:12px}
    .btn{padding:8px 12px;border-radius:8px;border:1px solid #d0d3d6;background:#f1f2f4;cursor:pointer}
    .btn.primary{background:#111213;color:#fff;border-color:#111213}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h2>✅ Customer Shield</h2>
      <p class="muted">API key: <code>${apiKey}</code></p>

      <div style="display:flex; gap:8px; margin:12px 0">
        <button id="scanBtn" class="btn primary">Сканировать клиентов</button>
        <button id="tagBtn" class="btn" disabled>Поставить тег <code>suspect_bot</code></button>
      </div>

      <div id="stats" class="muted"></div>

      <table id="tbl" style="margin-top:10px; display:none">
        <thead>
          <tr>
            <th><input type="checkbox" id="checkAll" /></th>
            <th>Customer</th>
            <th>Email</th>
            <th>Reasons</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>

      <p class="muted" style="margin-top:8px"><a href="/api/health" target="_blank">/api/health</a> · <a href="/api/me" target="_blank">/api/me</a></p>
    </div>
  </div>

  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <script>
    const scanBtn = document.getElementById('scanBtn');
    const tagBtn  = document.getElementById('tagBtn');
    const stats   = document.getElementById('stats');
    const tbl     = document.getElementById('tbl');
    const tbody   = tbl.querySelector('tbody');
    const checkAll= document.getElementById('checkAll');

    function rowHtml(c){
      return \`<tr>
        <td><input type="checkbox" data-id="\${c.id}"></td>
        <td>\${c.displayName || ''}</td>
        <td>\${c.email || ''}</td>
        <td>\${c.reasons.join(', ')}</td>
      </tr>\`;
    }

    scanBtn.onclick = async () => {
      scanBtn.disabled = true; tagBtn.disabled = true; stats.textContent = 'Сканирую…';
      tbody.innerHTML = '';
      try{
        const r = await fetch('/api/customers/scan?max=1000&batch=250');
        const data = await r.json();
        const suspects = data.suspects || [];
        stats.textContent = \`Проверено: \${data.totalChecked}. Найдено подозрительных: \${suspects.length}.\`;
        if (suspects.length){
          tbl.style.display = '';
          tbody.innerHTML = suspects.map(rowHtml).join('');
          tagBtn.disabled = false;
        } else {
          tbl.style.display = 'none';
        }
      } catch(e){ stats.textContent = 'Ошибка: ' + e; }
      finally { scanBtn.disabled = false; }
    };

    tagBtn.onclick = async () => {
      const ids = Array.from(tbody.querySelectorAll('input[type="checkbox"]:checked')).map(i => i.dataset.id);
      if (!ids.length) { alert('Отметь хотя бы одного клиента'); return; }
      tagBtn.disabled = true;
      try{
        const r = await fetch('/api/customers/tag', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ ids, tag: 'suspect_bot' }) });
        const data = await r.json();
        alert('Готово. Ошибок: ' + (data.results || []).filter(x => (x.errors||[]).length).length);
      } catch(e){ alert('Ошибка: ' + e); }
      finally { tagBtn.disabled = false; }
    };

    checkAll.onchange = () => {
      const on = checkAll.checked;
      document.querySelectorAll('tbody input[type="checkbox"]').forEach(cb => cb.checked = on);
    };
  </script>
</body>
</html>`);
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Customer Shield listening on port ${PORT}`);
});
