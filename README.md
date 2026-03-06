# Air2Json

Convert public Airtable views into a clean JSON feed with no Airtable API key.

This project extracts rows from a **public Airtable URL**, writes a normalized JSON file, keeps snapshots, and supports scheduled daily updates from a web UI.

## What it does

- Extracts data from public Airtable HTML (no Airtable API)
- Writes pretty JSON output (overwrite on each run)
- Maintains per-job snapshots for rollback
- Supports multiple jobs (`config/jobs.json`)
- Built-in scheduler (cron + timezone per job)
- Web UI for settings, jobs, preview, run, rollback

## Requirements

- Node.js 22+
- npm 10+
- Playwright Chromium

## Quick Start (Local)

1. Clone and install dependencies:

```bash
git clone https://github.com/NRoddz/Air2Json.git
cd Air2Json
npm install
npx playwright install chromium
```

2. Create env file:

```bash
cp .env.example .env
```

3. Start app:

```bash
npm start
```

4. Open UI:

- `http://localhost:3000` (or the `PORT` value from `.env`)

5. Configure in UI:

- Workspace settings (default cron/timezone/retention)
- Create job with Airtable public URL + output JSON path
- Preview and Run now
- Leave schedule enabled for automatic daily updates

## Output JSON

The output contains:

- `meta`
  - `schemaVersion`
  - `generatedAt`
  - `source`
  - `job`
  - `counts`
  - `columns` coverage
- `records`
  - stable `id`
  - `slug`
  - normalized top-level fields
  - `fields` (original column names)
  - `normalizedFields` (camelCase keys)

## Scripts

- `npm start` - start server
- `npm run dev` - start with watch mode
- `npm run export:once` - run enabled jobs once from CLI

## API

- `GET /health`
- `GET /api/dashboard`
- `GET /api/jobs`
- `GET /api/settings`
- `PUT /api/settings`
- `POST /api/jobs`
- `PUT /api/jobs/:jobId`
- `DELETE /api/jobs/:jobId`
- `POST /api/jobs/:jobId/preview`
- `POST /api/jobs/:jobId/run`
- `POST /api/jobs/run-all`
- `GET /api/jobs/:jobId/history`
- `POST /api/jobs/:jobId/rollback`

## Deploy on Ubuntu (systemd)

1. Install runtime:

```bash
sudo apt update
sudo apt install -y curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

2. Deploy app:

```bash
sudo mkdir -p /opt/air2json
sudo chown -R $USER:$USER /opt/air2json
cd /opt/air2json
git clone https://github.com/NRoddz/Air2Json.git .
npm ci
sudo npx playwright install-deps chromium
npx playwright install chromium
cp .env.example .env
```

3. Create service:

```ini
# /etc/systemd/system/air2json.service
[Unit]
Description=Air2Json
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/air2json
EnvironmentFile=/opt/air2json/.env
ExecStart=/usr/bin/node /opt/air2json/src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

4. Enable/start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now air2json
sudo systemctl status air2json
```

5. Update later:

```bash
cd /opt/air2json
git pull origin main
npm ci
npx playwright install chromium
sudo systemctl restart air2json
```

## Scheduling (daily updates)

Default schedule is configured per job in UI.

Example for daily 17:00 CET/CEST:

- Cron: `0 17 * * *`
- Timezone: `Europe/Madrid`

The scheduler runs inside the server process and overwrites the same output JSON path each run.

## Public feed endpoint (optional)

If you reverse-proxy the output file, you can expose a stable endpoint such as:

- `https://your-domain.com/cron/feed.json`

In this project setup, that endpoint can be mapped to:

- `/opt/air2json/data/jobs/default/current.json`

## Important Notes

- Airtable public HTML structure can change over time; extractor logic may need updates.
- Keep `data/` and snapshots out of git.
- Use temporary credentials for server access, then rotate/revoke after deployment.
