#!/usr/bin/env bash
# Pulls the latest code, builds, applies migrations and restarts the API.
# Run on the server from the backend folder: bash deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
npm ci
npx prisma generate
npm run build
npx prisma migrate deploy

if pm2 describe qimam-api > /dev/null 2>&1; then
  pm2 reload deploy/ecosystem.config.cjs --update-env
else
  pm2 start deploy/ecosystem.config.cjs
  pm2 save
fi

pm2 status qimam-api
