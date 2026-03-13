#!/bin/bash
# Quick test setup - copies env template and prints instructions

set -e
cd "$(dirname "$0")/.."

echo "=== Test Setup ==="

# Copy env if missing
if [ ! -f .env ]; then
  echo "Creating .env from env.test.example..."
  cp env.test.example .env
  echo "→ Edit .env with your Stripe and mer credentials"
else
  echo "✓ .env exists"
fi

echo ""
echo "Required in .env:"
echo "  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (run npm run stripe:webhook)"
echo "  MER_USERNAME, MER_PASSWORD, MER_SOFTWARE_ID"
echo "  COMPANY_OIB, COMPANY_NAME"
echo ""
echo "Start test:"
echo "  Terminal 1: npm start (from server/)"
echo "  Terminal 2: npm run dev (from colorforge-prints/)"
echo "  Terminal 3: npm run stripe:webhook (from server/)"
echo ""
echo "Then open http://localhost:8080 and complete a test payment"
