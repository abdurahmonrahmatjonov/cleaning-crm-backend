import { config } from './src/config.js';
import { openDb, seed } from './src/db.js';
import { createApp } from './src/app.js';
import { nowDateTime } from './src/utils/time.js';

const db = openDb();
seed(db, { now: nowDateTime() });

const server = createApp(db).listen(config.port, () => {
  console.log(`NewCRM API listening on http://localhost:${config.port}`);
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
