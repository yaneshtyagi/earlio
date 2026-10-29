#!/usr/bin/env bash
# Starts a clean, seeded Earlio stack for the end-to-end suite: API on :4000 (with the Appendix A scenarios) and the web app on :5173.
set -euo pipefail
cd "$(dirname "$0")/.."
# Uses the Postgres from apps/api/.env (or DATABASE_URL); point it at a throwaway database for a clean run.
LOG="${E2E_LOG_DIR:-/tmp}"
EARLIO_ENV=development EARLIO_SEED_SCENARIOS=1 LOGIN_RATE_LIMIT=10000 RATE_LIMIT_MAX=100000 PORT=4000 CORS_ORIGINS=http://localhost:5173 npm run start -w @earlio/api > "$LOG/earlio-api.log" 2>&1 &
npm run dev -w @earlio/web > "$LOG/earlio-web.log" 2>&1 &
echo "waiting for the API to finish seeding…"
until grep -q "Pilot scenarios ready" "$LOG/earlio-api.log" 2>/dev/null; do sleep 2; done
echo "stack ready: web http://localhost:5173, api http://localhost:4000"
wait
