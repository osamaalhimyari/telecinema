#!/bin/bash
set -e
#cd ~/app/html/taxi-api-backend
#git pull
node ace build
cd build
mkdir -p tmp
npm ci --omit=dev
ln -sf ../.env .env
# Apply any pending database migrations (creates the rooms/users tables on a
# fresh database). --force is required because NODE_ENV is production.
node ace migration:run --force
 pm2 restart watch-party

pm2 restart watch-party || pm2 start bin/server.js --name watch-party
echo "✅ Deployed"
