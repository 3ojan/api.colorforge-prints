#!/bin/bash
# Creates a backend deployment bundle for cPanel/Passenger
# Run from server/: bash scripts/create-backend-deploy.sh

set -e
cd "$(dirname "$0")/.."
DEPLOY_DIR="backend-deploy"
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"/data
mkdir -p "$DEPLOY_DIR"/uploads

# Copy server files
cp index.js "$DEPLOY_DIR/"
cp env.example "$DEPLOY_DIR/"
cp data/orders.json "$DEPLOY_DIR/data/" 2>/dev/null || touch "$DEPLOY_DIR/data/orders.json"

# Copy package files
cp package.json "$DEPLOY_DIR/"
cp package-lock.json "$DEPLOY_DIR/" 2>/dev/null || true

echo "Created $DEPLOY_DIR/"
echo ""
echo "Next steps:"
echo "1. cd $DEPLOY_DIR && npm install --production"
echo "2. cp env.example .env && edit .env with your values"
echo "3. Upload $DEPLOY_DIR/ contents to cPanel (or zip and upload)"
echo "4. In Application Manager: startup: node index.js"
