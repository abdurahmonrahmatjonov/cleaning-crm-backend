#!/bin/sh
set -e
# Free hosts wipe the disk on restart: pull the latest DB copy from object storage first.
if [ -n "$LITESTREAM_BUCKET" ]; then
  litestream restore -config /app/litestream.yml -if-db-not-exists -if-replica-exists "$DB_PATH"
  exec litestream replicate -config /app/litestream.yml -exec "node index.js"
fi
exec node index.js
