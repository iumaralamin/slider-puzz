# slider-puzz

A Telegram Mini App for a sliding image puzzle game with backend, frontend, and admin support.

## Contents

- `bot/` — Telegram bot + Express API + PostgreSQL backend
- `web/` — Static frontend and admin panel served from `web/public`
- `render.yaml` — Render deployment manifest

## Local setup

1. Copy `.env.example` to `.env` and fill in values.
2. Install dependencies:
   ```bash
   npm run install:all
   ```
3. Start the bot backend:
   ```bash
   npm run start:bot
   ```
4. Start the web frontend separately (optional):
   ```bash
   npm run start:web
   ```

> The bot backend serves the frontend from `bot/index.js` using the static files in `web/public`.

## Environment variables

Required environment variables for Render or local run:

- `BOT_TOKEN` — Telegram bot token
- `JWT_SECRET` — secret for admin JWT tokens
- `ADMIN_USERNAMES` — comma-separated Telegram usernames allowed to access admin features
- `WEB_APP_URL` — public URL for the web app (e.g. `https://<your-render-service>.onrender.com`)
- `DATABASE_URL` — PostgreSQL connection URL

## Render deployment

The app is configured to run with a single Render web service.

### Recommended Render service

- `Build Command`: `npm run install:all`
- `Start Command`: `cd bot && npm start`
- Link a PostgreSQL database service and set `DATABASE_URL`
- Set environment variables above in Render

### Access URLs

- Main game: `https://<your-render-service>.onrender.com/`
- Admin panel: `https://<your-render-service>.onrender.com/admin.html`

## Notes

- The Telegram bot and frontend integrate using Telegram Web App `initData`.
- Admin routes require Telegram username membership in `ADMIN_USERNAMES`.
