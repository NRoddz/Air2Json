# Airtable -> JSON Ops Console

Production-oriented exporter that pulls public Airtable views (no Airtable API keys), builds clean JSON feeds, and keeps run history/snapshots for rollback.

- Multi-job support (`config/jobs.json`)
- Per-job schedules (cron + timezone)
- Run history with diff stats (`added/updated/removed`)
- Snapshot per successful run + rollback endpoint
- Atomic overwrite of output files
- Dashboard UI for create/run/preview/rollback/delete
- CLI batch runner for cron/systemd

## Output format

Each job output is pretty JSON with:

- `meta`:
  - `schemaVersion`
  - `generatedAt`
  - `source`
  - `job`
  - `counts`
  - `columns` coverage
- `records`: normalized objects with:
  - stable `id`
  - `slug`
  - normalized top-level fields
  - `fields` (original Airtable column names)
  - `normalizedFields` (camelCase keys)

## Local run

1. Install
   - `npm install`
   - `npx playwright install chromium`
2. Configure
   - `cp .env.example .env`
3. Start web app
   - `npm start`
4. Open
   - `http://localhost:3000`

## CLI run

Run all enabled jobs:

- `npm run export:once`

Run one job:

- `EXPORT_JOB_ID=default npm run export:once`

## API

- `GET /health`
- `GET /api/dashboard`
- `GET /api/jobs`
- `POST /api/jobs`
- `PUT /api/jobs/:jobId`
- `DELETE /api/jobs/:jobId`
- `POST /api/jobs/:jobId/preview`
- `POST /api/jobs/:jobId/run`
- `POST /api/jobs/run-all`
- `GET /api/jobs/:jobId/history`
- `POST /api/jobs/:jobId/rollback`

## Ubuntu VPS deployment

### 1. Install Node 22

```bash
sudo apt update
sudo apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Deploy app

```bash
sudo mkdir -p /opt/airtable-json-ops
sudo chown -R $USER:$USER /opt/airtable-json-ops
cd /opt/airtable-json-ops
# clone repository here
npm ci
npx playwright install --with-deps chromium
cp .env.example .env
```

### 3. Configure

Edit `.env` (or directly `config/jobs.json` after first startup):

- `AIRTABLE_PUBLIC_URL=...`
- `OUTPUT_JSON_PATH=/var/www/your-site/data/jobs.json`
- `EXPORT_SCHEDULE_ENABLED=true`
- `EXPORT_SCHEDULE_CRON=0 17 * * *`
- `EXPORT_SCHEDULE_TZ=Europe/Madrid`

### 4. Start as service

Use `deploy/systemd/airtable-json-ops.service` as template, or create `/etc/systemd/system/airtable-json-ops.service`:

```ini
[Unit]
Description=Airtable JSON Ops Console
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/airtable-json-ops
EnvironmentFile=/opt/airtable-json-ops/.env
ExecStart=/usr/bin/node /opt/airtable-json-ops/src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now airtable-json-ops
sudo systemctl status airtable-json-ops
```

### 5. Daily overwrite recommendation

Two safe options:

- Use built-in scheduler in each job (`schedule.enabled=true`)
- Or force with cron (recommended for explicit ops control):

Use `deploy/cron/airtable-json-ops.cron` as template:

```cron
CRON_TZ=Europe/Madrid
0 17 * * * cd /opt/airtable-json-ops && /usr/bin/npm run export:once >> /var/log/airtable-json-ops.log 2>&1
```

## Notes

- Public Airtable HTML extraction can change if Airtable updates frontend internals.
- Snapshots are stored at `data/snapshots/<jobId>/`.
- Run history is stored at `data/state/runs.json`.
# Air2Json
