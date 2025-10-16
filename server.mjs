import express from 'express';
import 'dotenv/config';

// В твоём окружении @shopify/shopify-app-express идёт как CJS -> берём default
import appExpress from '@shopify/shopify-app-express';
const { shopifyApp, LATEST_API_VERSION } = appExpress;

import { MemorySessionStorage } from '@shopify/shopify-app-session-storage-memory';

/* ===== sanity-check env ===== */
const required = ['SHOPIFY_API_KEY','SHOPIFY_API_SECRET','SCOPES','HOST','SESSION_SECRET'];
for (const k of required) {
  if (!process.env[k] || process.env[k].includes('replace_with')) {
    console.warn(`[WARN] Missing or placeholder env var: ${k}`);
  }
}

const PORT = process.env.PORT || 3000;

/* ===== Shopify bootstrap ===== */
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

/* ===== Auth ===== */
app.use('/api/auth', shopify.auth.begin());
app.use('/api/auth/callback', shopify.auth.callback(), shopify.redirectToShopifyOrAppRoot());

/* ===== Health & GDPR ===== */
app.get('/api/health', (_req, res) => res.status(200).json({ ok: true }));
app.post('/api/gdpr/customers/data_request', (_req, res) => res.sendStatus(200));
app.post('/api/gdpr/customers/redact', (_req, res) => res.sendStatus(200));
app.post('/api/gdpr/shop/redact', (_req, res) => res.sendStatus(200));

/* ===== Protected example ===== */
app.get('/api/me', shopify.validateAuthenticatedSession(), async (_req, res) => {
  const session = res.locals.shopify.session;
  res.json({ shop: session.shop, isOnline: session.isOnline });
});

/* ===== Анти-бот логика ===== */
const gql = String.raw;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CUSTOMERS_QUERY = gql`
  query Customers($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, sortKey: ID, query: $query) {
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

// Простые правила подозрительности
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

/* --- GET /api/customers/scan ---
   Быстрый скан: по умолчанию проверяем до 50 клиентов батчами по 25.
   Можно переопределить: /api/customers/scan?max=200&batch=100
*/
app.get('/api/customers/scan', shopify.validateAuthenticatedSession(), async (req, res) => {
  const session = res.locals.shopify.session;
  const client = new shopify.api.clients.Graphql({ session });

  const batch = Number(req.query.batch ?? 25);
  const max   = Math.min(Number(req.query.max ?? 50), 2000);

  let after = undefined;
  let checked = 0;
  const suspects = [];

  try {
    while (checked < max) {
      const resp = await client.request(CUSTOMERS_QUERY, {
        variables: { first: Math.min(batch, max - checked), after }
      });

      const data = resp?.data ?? resp;
      const customers = data?.customers;
      const edges = customers?.edges || [];
      if (!edges.length) break;

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
      }

      checked += edges.length;
      if (!customers?.pageInfo?.hasNextPage) break;
      await sleep(150);
    }

    res.json({ totalChecked: checked, suspects });
  } catch (e) {
    console.error('SCAN ERROR:', e);
    res.status(500).json({ error: String(e) });
  }
});

/* --- НОВОЕ: GET /api/customers/list ---
   Возвращает просто список клиентов (без фильтров) для проверки полей.
   Параметры: ?limit=50 (по умолчанию 50, максимум 500; при необходимости пагинирует).
*/
app.get('/api/customers/list', shopify.validateAuthenticatedSession(), async (req, res) => {
  const session = res.locals.shopify.session;
  const client = new shopify.api.clients.Graphql({ session });

  const limit = Math.min(Number(req.query.limit ?? 50), 500);
  const batch = Math.min(100, limit); // размер страницы
  let after = undefined;
  let collected = 0;

  const items = [];

  try {
    while (collected < limit) {
      const first = Math.min(batch, limit - collected);
      const resp = await client.request(CUSTOMERS_QUERY, {
        variables: { first, after }
      });

      const data = resp?.data ?? resp;
      const customers = data?.customers;
      const edges = customers?.edges || [];
      if (!edges.length) break;

      for (const { cursor, node } of edges) {
        items.push({
          id: node.id,
          displayName: node.displayName,
          email: node.email,
          firstName: node.firstName,
          lastName: node.lastName,
          addresses: (node.addresses || []).map(a => ({ city: a.city, country: a.country }))
        });
        after = cursor;
      }
      collected += edges.length;
      if (!customers?.pageInfo?.hasNextPage) break;
      await sleep(120);
    }

    res.json({ count: items.length, customers: items });
  } catch (e) {
    console.error('LIST ERROR:', e);
    res.status(500).json({ error: String(e) });
  }
});

/* --- POST /api/customers/tag ---
   Тело: { ids: [<gid://shopify/Customer/...>], tag: "suspect_bot" }
*/
app.post('/api/customers/tag', shopify.validateAuthenticatedSession(), async (req, res) => {
  const { ids = [], tag = 'suspect_bot' } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });

  const session = res.locals.shopify.session;
  const client = new shopify.api.clients.Graphql({ session });

  const results = [];
  for (const id of ids) {
    const out = await client.request(TAGS_ADD_MUTATION, { variables: { id, tags: [tag] } });
    const errs = out?.data?.tagsAdd?.userErrors || out?.tagsAdd?.userErrors || [];
    results.push({ id, errors: errs });
    await sleep(40);
  }
  res.json({ ok: true, results });
});

/* ===== Встроенная страница (UI) ===== */
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
    .wrap{max-width:980px;margin:24px auto;padding:16px}
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

      <div style="display:flex; gap:8px; margin:12px 0; flex-wrap:wrap">
        <button id="listBtn" class="btn">Показать клиентов</button>
        <button id="scanBtn" class="btn primary">Сканировать клиентов</button>
        <button id="tagBtn" class="btn" disabled>Поставить тег <code>suspect_bot</code></button>
      </div>

      <div id="stats" class="muted"></div>

      <h3 style="margin:12px 0 4px">Список клиентов</h3>
      <table id="listTbl" style="margin-top:6px; display:none">
        <thead>
          <tr>
            <th>#</th>
            <th>Customer</th>
            <th>Email</th>
            <th>City</th>
            <th>Country</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>

      <h3 style="margin:16px 0 4px">Подозрительные</h3>
      <table id="susTbl" style="margin-top:6px; display:none">
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

      <p class="muted" style="margin-top:8px">
        <a href="/api/health" target="_blank">/api/health</a> · <a href="/api/me" target="_blank">/api/me</a>
      </p>
    </div>
  </div>

  <!-- Только cdn.shopify.com — чтобы не упереться в CSP -->
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge-utils.js"></script>
  <script>
  (function () {
    var params = new URLSearchParams(window.location.search);
    var host = params.get('host');
    var shop = params.get('shop');

    function initWhenReady(tries) {
      tries = tries || 0;
      var AB  = window['app-bridge'];
      var ABU = window['app-bridge-utils'];
      if (!AB || !ABU) {
        if (tries < 50) return setTimeout(function(){ initWhenReady(tries + 1); }, 100);
        var stats = document.getElementById('stats');
        if (stats) stats.textContent = 'Не удалось загрузить Shopify App Bridge. Обновите страницу.';
        return;
      }

      var app = AB.createApp({ apiKey: '${apiKey}', host: host });

      function authedFetch(url, options) {
        options = options || {};
        return ABU.getSessionToken(app).then(function(token){
          var headers = options.headers || {};
          headers.Authorization = 'Bearer ' + token;
          options.headers = headers;
          return fetch(url, options);
        });
      }

      // ---------- UI ----------
      var listBtn  = document.getElementById('listBtn');
      var scanBtn  = document.getElementById('scanBtn');
      var tagBtn   = document.getElementById('tagBtn');
      var statsEl  = document.getElementById('stats');

      var listTbl  = document.getElementById('listTbl');
      var listBody = listTbl.querySelector('tbody');

      var susTbl   = document.getElementById('susTbl');
      var susBody  = susTbl.querySelector('tbody');
      var checkAll = document.getElementById('checkAll');

      function customerRow(i, c){
        var addr = (c.addresses && c.addresses[0]) || {};
        return '<tr>'
          + '<td>' + (i+1) + '</td>'
          + '<td>' + (c.displayName || '') + '</td>'
          + '<td>' + (c.email || '') + '</td>'
          + '<td>' + (addr.city || '') + '</td>'
          + '<td>' + (addr.country || '') + '</td>'
          + '</tr>';
      }

      function suspectRow(c){
        return '<tr>'
          + '<td><input type="checkbox" data-id="' + c.id + '"></td>'
          + '<td>' + (c.displayName || '') + '</td>'
          + '<td>' + (c.email || '') + '</td>'
          + '<td>' + c.reasons.join(', ') + '</td>'
          + '</tr>';
      }

      listBtn.onclick = function () {
        listBtn.disabled = true;
        statsEl.textContent = 'Загружаю клиентов…';
        listBody.innerHTML = '';
        authedFetch('/api/customers/list?limit=50')
          .then(function(r){
            if (r.status === 401) { window.location.href = '/api/auth' + (shop ? ('?shop=' + encodeURIComponent(shop)) : ''); return Promise.reject('401'); }
            return r.json();
          })
          .then(function(data){
            var arr = data.customers || [];
            listTbl.style.display = arr.length ? '' : 'none';
            listBody.innerHTML = arr.map(function(c,i){ return customerRow(i,c); }).join('');
            statsEl.textContent = 'Клиентов: ' + (data.count != null ? data.count : arr.length);
          })
          .catch(function(e){
            if (e !== '401') statsEl.textContent = 'Ошибка: ' + e;
          })
          .finally(function(){ listBtn.disabled = false; });
      };

      scanBtn.onclick = function () {
        scanBtn.disabled = true; tagBtn.disabled = true; statsEl.textContent = 'Сканирую…';
        susBody.innerHTML = '';
        authedFetch('/api/customers/scan?max=50&batch=25')
          .then(function(r){
            if (r.status === 401) { window.location.href = '/api/auth' + (shop ? ('?shop=' + encodeURIComponent(shop)) : ''); return Promise.reject('401'); }
            return r.json();
          })
          .then(function(data){
            var suspects = data.suspects || [];
            susTbl.style.display = suspects.length ? '' : 'none';
            susBody.innerHTML = suspects.map(function(c){ return suspectRow(c); }).join('');
            statsEl.textContent = 'Проверено: ' + data.totalChecked + '. Найдено подозрительных: ' + suspects.length + '.';
            tagBtn.disabled = suspects.length === 0;
          })
          .catch(function(e){
            if (e !== '401') statsEl.textContent = 'Ошибка: ' + e;
          })
          .finally(function(){ scanBtn.disabled = false; });
      };

      tagBtn.onclick = function () {
        var ids = Array.prototype.slice.call(susBody.querySelectorAll('input[type="checkbox"]:checked')).map(function(i){ return i.dataset.id; });
        if (!ids.length) { alert('Отметь хотя бы одного клиента'); return; }
        tagBtn.disabled = true;
        authedFetch('/api/customers/tag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids, tag: 'suspect_bot' })
        })
        .then(function(r){
          if (r.status === 401) { window.location.href = '/api/auth' + (shop ? ('?shop=' + encodeURIComponent(shop)) : ''); return Promise.reject('401'); }
          return r.json();
        })
        .then(function(data){
          var errs = (data.results || []).filter(function(x){ return (x.errors||[]).length; }).length;
          alert('Готово. Ошибок: ' + errs);
        })
        .catch(function(e){
          if (e !== '401') alert('Ошибка: ' + e);
        })
        .finally(function(){ tagBtn.disabled = false; });
      };

      if (checkAll) {
        checkAll.addEventListener('change', function(){
          var on = checkAll.checked;
          Array.prototype.forEach.call(susBody.querySelectorAll('input[type="checkbox"]'), function(cb){ cb.checked = on; });
        });
      }
    }

    document.addEventListener('DOMContentLoaded', function(){ initWhenReady(); });
  })();
  </script>
</body>
</html>`);
});

/* ===== Start ===== */
app.listen(PORT, () => {
  console.log(`Customer Shield listening on port ${PORT}`);
});
