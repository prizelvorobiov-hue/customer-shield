# Customer Shield — Minimal Shopify App (Node + Express)

Готовый минимальный стартовый проект для деплоя на Render и установки в dev‑store.

## Установка

```bash
npm ci
cp .env.example .env
# отредактируй .env: ключи/секрет из Shopify, HOST = твой onrender URL
npm start
```

## Переменные окружения

- `SHOPIFY_API_KEY` — Client ID из Shopify → Settings → Credentials
- `SHOPIFY_API_SECRET` — Secret из тех же Credentials
- `SCOPES` — например: `read_customers,write_customers`
- `HOST` — публичный URL (например, `https://customer-shield.onrender.com`)
- `SESSION_SECRET` — любая случайная строка (32+ символов)
- `NODE_ENV` — `production`

## Render

`render.yaml` уже настроен. В консоли Render добавь переменные окружения и запусти деплой:
- Build Command: `npm ci && npm run build`
- Start Command: `npm run start`

## Shopify Partner Dashboard

Укажи:
- App URL: `https://<твой>.onrender.com`
- Allowed redirection URLs:
  - `https://<твой>.onrender.com/api/auth`
  - `https://<твой>.onrender.com/api/auth/callback`

После этого установи в dev‑store.

---

Это самый минимальный каркас: авторизация OAuth, корневая страница, health‑endpoint, GDPR‑заглушки.
Дальше можно добавить Polaris UI и функции анти‑бот фильтра.
