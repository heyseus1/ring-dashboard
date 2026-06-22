#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/pi/apps/ring-dashboard"

cd "$APP_DIR"

echo "Pulling latest code..."
git fetch origin main
git reset --hard origin/main

echo "Building Docker image locally on Raspberry Pi..."
docker compose -f docker-compose.rpi.yml build

echo "Starting Ring Dashboard with Raspberry Pi host networking..."
docker compose -f docker-compose.rpi.yml up -d

echo "Waiting for health check..."
sleep 8

curl -fsS http://localhost:3000/api/health

echo
echo "Deploy complete."
