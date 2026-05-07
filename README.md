# Ring Dashboard

A local Docker-based dashboard for Ring cameras.

This app lets you view Ring camera status, health metrics, snapshots, and local activity history from a simple web dashboard.

It is designed for local/home-lab use.

## What You Need

- Docker Desktop
- Docker Compose
- A Ring account
- A Ring refresh token

You do **not** need to install Node.js to run this with Docker.

## Quick Start

Clone the repo:

```bash
git clone https://github.com/YOUR_USERNAME/ring-dashboard.git
cd ring-dashboard
```

Create your local environment file:

```bash
cp .env.example .env
```

Generate a Ring refresh token:

```bash
npx -y ring-auth-cli
```

Copy the refresh token into `.env`:

```env
PORT=3000
DATA_DIR=./data
RING_REFRESH_TOKEN=your_ring_refresh_token_here
```

Create the local data directory:

```bash
mkdir -p data
touch data/.gitkeep
```

Start the dashboard:

```bash
docker compose up --build
```

Open the dashboard:

```text
http://localhost:3000
```

Stop the dashboard:

```bash
docker compose down
```

## Ring Authentication

This project uses a Ring refresh token.

Generate one with:

```bash
npx -y ring-auth-cli
```

After logging in, paste the token into your `.env` file:

```env
RING_REFRESH_TOKEN=your_ring_refresh_token_here
```

The app may rotate the Ring token automatically. When that happens, the latest token is saved locally in:

```text
data/.ring-refresh-token
```

Do not commit this file.

## Docker Files

The app runs through Docker Compose.

Important files:

```text
Dockerfile
docker-compose.yml
.env.example
data/
```

Start:

```bash
docker compose up --build
```

Stop:

```bash
docker compose down
```

View logs:

```bash
docker compose logs -f ring-dashboard
```

## Persistent Data

The `data/` folder stores local runtime data.

```text
data/.ring-refresh-token
data/.ring-activity-history.json
```

These files keep your Ring auth session and local activity history across container restarts.

Only this file should be committed:

```text
data/.gitkeep
```

## Dashboard Features

The dashboard includes:

- Camera status
- Battery levels
- Wi-Fi signal
- Network health
- Firmware status
- Light status
- Siren status
- Snapshot viewer
- Local activity history
- Synthetic test event button

Synthetic test events are fake local events used to test the dashboard UI. They are not Ring source-of-truth data.

## API Endpoints

Health check:

```http
GET /api/health
```

Camera inventory:

```http
GET /api/cameras
```

Camera status summary:

```http
GET /api/status
```

Camera snapshot:

```http
GET /api/cameras/:cameraId/snapshot
```

Activity history:

```http
GET /api/activity
```

Create a synthetic test activity:

```http
POST /api/activity/test
```

Debug camera payload:

```http
GET /api/debug/cameras
```

The debug endpoint is for local troubleshooting only.

## Example Health Check

```bash
curl http://localhost:3000/api/health
```

Example response:

```json
{
  "ok": true,
  "app": "ring-dashboard",
  "cameras": 1,
  "locations": 1
}
```

## Files You Should Never Commit

```text
.env
data/.ring-refresh-token
data/.ring-activity-history.json
node_modules/
dist/
```

## Troubleshooting

### Docker is not running

Start Docker Desktop, then run:

```bash
docker compose up --build
```

### Ring auth fails

Generate a new token:

```bash
npx -y ring-auth-cli
```

Update `.env`:

```env
RING_REFRESH_TOKEN=your_new_ring_refresh_token
```

Remove the old saved token:

```bash
rm -f data/.ring-refresh-token
```

Restart:

```bash
docker compose up --build
```

### Snapshot does not load

Try refreshing the dashboard, then click **View Snapshot** again.

Check logs:

```bash
docker compose logs -f ring-dashboard
```

## Security Notes

This dashboard is meant to run locally.

Do not expose it directly to the public internet without adding authentication, HTTPS, and proper secret management.

## Roadmap

Possible future features:

- Live feed button
- Saved snapshot history
- Real Ring event history backfill
- SQLite or Postgres storage
- Dashboard authentication
- GitHub Actions CI
- Kubernetes deployment
