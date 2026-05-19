#!/bin/bash
set -e
#cd ~/app/html/taxi-api-backend
#git pull
node ace build
cd build
npm ci --omit=dev
ln -sf ../.env .env
# pm2 restart taxi-api-backend
echo "✅ Deployed"