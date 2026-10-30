import 'dotenv/config';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
};

export const config = {
  port: Number(process.env.PORT) || 3000,
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  dbPath: process.env.DB_PATH || './data/crm.db',
  // Chat attachments live next to the database (on Fly that is the persistent /data volume).
  uploadDir: process.env.UPLOAD_DIR || '',
  maxUploadBytes: 15 * 1024 * 1024,
  // WebRTC: STUN works for most networks; add a TURN server (env) for strict NATs / mobile carriers.
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ...(process.env.TURN_URLS
      ? [{ urls: process.env.TURN_URLS.split(',').map((s) => s.trim()), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }]
      : []),
  ],
  timezone: process.env.APP_TIMEZONE || 'Asia/Tashkent',
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD,
    fullName: process.env.ADMIN_FULL_NAME || 'Administrator',
  },
};
