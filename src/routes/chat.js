import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { validate } from '../middleware/validate.js';
import { badRequest, conflict, notFound } from '../utils/httpError.js';
import { id as idSchema } from '../utils/schemas.js';
import { nowDateTime } from '../utils/time.js';

const sendSchema = z.object({ body: z.string().trim().min(1).max(2000) });
const fileQuery = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.string().trim().max(100).regex(/^[\w.+-]+\/[\w.+-]+$/).default('application/octet-stream'),
});
const SIGNALS = ['offer', 'answer', 'ice', 'hangup', 'reject', 'busy'];
const signalSchema = z.object({
  to: idSchema,
  callId: z.string().min(8).max(64),
  type: z.enum(SIGNALS),
  media: z.enum(['audio', 'video']).optional(),
  data: z.any().optional(),
});
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/;
const AUDIO = /^audio\/(webm|ogg|mp4|mpeg|wav|aac|x-m4a)(;.*)?$/;
const kindOf = (mime) => (IMAGE.test(mime) ? 'image' : AUDIO.test(mime) ? 'audio' : 'file');
const readSchema = z.object({ upTo: z.number().int().min(0) });
const peerParams = z.object({ userId: idSchema });
const listQuery = z.object({
  after: z.coerce.number().int().min(0).optional(), // only messages newer than this id (polling)
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * Two kinds of conversation, both open to every signed-in user:
 *  - the global room (recipientId IS NULL), visible to everyone
 *  - private one-to-one messages, visible only to the two people involved
 */
export function chatRouter(db) {
  const router = Router();

  const uploadDir =
    config.uploadDir ||
    (db.name && db.name !== ':memory:' && !db.memory ? path.join(path.dirname(path.resolve(db.name)), 'uploads') : path.join(os.tmpdir(), 'newcrm-uploads'));
  fs.mkdirSync(uploadDir, { recursive: true });

  const present = (m) => ({
    id: m.id,
    senderId: m.senderId,
    senderName: m.senderName,
    recipientId: m.recipientId,
    body: m.body,
    createdAt: m.createdAt,
    file: m.fileKey ? { name: m.fileName, mime: m.fileMime, size: m.fileSize, kind: kindOf(m.fileMime) } : null,
  });

  const getRead = db.prepare('SELECT lastReadId FROM chat_reads WHERE userId = ? AND peer = ?');
  const setRead = db.prepare(
    `INSERT INTO chat_reads (userId, peer, lastReadId) VALUES (?,?,?)
     ON CONFLICT(userId, peer) DO UPDATE SET lastReadId = MAX(lastReadId, excluded.lastReadId)`,
  );
  const maxGlobal = db.prepare('SELECT COALESCE(MAX(id), 0) v FROM messages WHERE recipientId IS NULL');

  /** A user's first look at the global room starts "caught up", not with the whole history unread. */
  const globalLastRead = (userId) => {
    const row = getRead.get(userId, 'g');
    if (row) return row.lastReadId;
    const v = maxGlobal.get().v;
    setRead.run(userId, 'g', v);
    return v;
  };

  const page = (rows, { after, limit }) => (after === undefined ? rows.slice(-limit) : rows);

  // People you can write to, with unread counts and the latest private message for each.
  router.get('/users', (req, res) => {
    const me = req.user.id;
    const users = db.prepare('SELECT id, fullName, role FROM users WHERE isActive = 1 AND clientId IS NULL AND id != ? ORDER BY fullName').all(me);
    const roleName = db.prepare('SELECT name FROM roles WHERE key = ?');
    const last = db.prepare(
      `SELECT id, senderId, body, createdAt, fileName, fileMime FROM messages
       WHERE (senderId = @me AND recipientId = @p) OR (senderId = @p AND recipientId = @me) ORDER BY id DESC LIMIT 1`,
    );
    const unread = db.prepare(
      'SELECT COUNT(*) c FROM messages WHERE senderId = ? AND recipientId = ? AND id > ?',
    );
    res.json({
      data: users.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        roleName: roleName.get(u.role)?.name ?? u.role,
        unread: unread.get(u.id, me, getRead.get(me, String(u.id))?.lastReadId ?? 0).c,
        last: last.get({ me, p: u.id }) ?? null,
      })),
    });
  });

  // Unread counters for the menu badge.
  router.get('/unread', (req, res) => {
    const me = req.user.id;
    const global = db
      .prepare('SELECT COUNT(*) c FROM messages WHERE recipientId IS NULL AND senderId != ? AND id > ?')
      .get(me, globalLastRead(me)).c;
    const rows = db
      .prepare(
        `SELECT m.senderId peer, COUNT(*) c FROM messages m
         LEFT JOIN chat_reads r ON r.userId = @me AND r.peer = CAST(m.senderId AS TEXT)
         WHERE m.recipientId = @me AND m.id > COALESCE(r.lastReadId, 0) GROUP BY m.senderId`,
      )
      .all({ me });
    const direct = Object.fromEntries(rows.map((r) => [r.peer, r.c]));
    res.json({ global, direct, total: global + rows.reduce((s, r) => s + r.c, 0) });
  });

  // ----- global room -----
  router.get('/global', validate(listQuery, 'query'), (req, res) => {
    const q = req.valid.query;
    const rows = db
      .prepare('SELECT * FROM messages WHERE recipientId IS NULL AND id > ? ORDER BY id')
      .all(q.after ?? 0);
    res.json({ data: page(rows, q).map(present) });
  });

  router.post('/global', validate(sendSchema), (req, res) => {
    const info = db
      .prepare('INSERT INTO messages (senderId, senderName, recipientId, body, createdAt) VALUES (?,?,NULL,?,?)')
      .run(req.user.id, req.user.fullName, req.valid.body.body, nowDateTime());
    setRead.run(req.user.id, 'g', info.lastInsertRowid);
    res.status(201).json(present(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)));
  });

  // ----- private conversations -----
  const peerOf = (req) => {
    const { userId } = req.valid.params;
    if (userId === req.user.id) throw badRequest('You cannot message yourself');
    const peer = db.prepare('SELECT id, fullName, isActive FROM users WHERE id = ?').get(userId);
    if (!peer) throw notFound('User not found');
    return peer;
  };

  router.get('/with/:userId', validate(peerParams, 'params'), validate(listQuery, 'query'), (req, res) => {
    const peer = peerOf(req);
    const q = req.valid.query;
    const rows = db
      .prepare(
        `SELECT * FROM messages WHERE id > @after AND
         ((senderId = @me AND recipientId = @p) OR (senderId = @p AND recipientId = @me)) ORDER BY id`,
      )
      .all({ me: req.user.id, p: peer.id, after: q.after ?? 0 });
    res.json({ data: page(rows, q).map(present) });
  });

  router.post('/with/:userId', validate(peerParams, 'params'), validate(sendSchema), (req, res) => {
    const peer = peerOf(req);
    if (!peer.isActive) throw badRequest('This user is disabled');
    const info = db
      .prepare('INSERT INTO messages (senderId, senderName, recipientId, body, createdAt) VALUES (?,?,?,?,?)')
      .run(req.user.id, req.user.fullName, peer.id, req.valid.body.body, nowDateTime());
    res.status(201).json(present(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)));
  });

  // ----- attachments: files, images and voice messages (raw body, name/type in the query string) -----
  const rawBody = express.raw({ type: () => true, limit: config.maxUploadBytes });

  const saveFile = (req, recipientId) => {
    const q = fileQuery.safeParse(req.query);
    if (!q.success) throw badRequest('Invalid file name or type');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('Empty file');
    const key = crypto.randomUUID();
    fs.writeFileSync(path.join(uploadDir, key), req.body);
    const name = q.data.name.replace(/[\\/\u0000-\u001f]/g, '_');
    const info = db
      .prepare(
        `INSERT INTO messages (senderId, senderName, recipientId, body, createdAt, fileKey, fileName, fileMime, fileSize)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(req.user.id, req.user.fullName, recipientId, '', nowDateTime(), key, name, q.data.type, req.body.length);
    return present(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  };

  router.post('/global/file', rawBody, (req, res) => {
    const m = saveFile(req, null);
    setRead.run(req.user.id, 'g', m.id);
    res.status(201).json(m);
  });

  router.post('/with/:userId/file', validate(peerParams, 'params'), rawBody, (req, res) => {
    const peer = peerOf(req);
    if (!peer.isActive) throw badRequest('This user is disabled');
    res.status(201).json(saveFile(req, peer.id));
  });

  // Only people who can see the message can fetch its file. The app fetches it with the Bearer token.
  router.get('/files/:id', validate(z.object({ id: idSchema }), 'params'), (req, res) => {
    const m = db.prepare('SELECT * FROM messages WHERE id = ? AND fileKey != \'\'').get(req.valid.params.id);
    const me = req.user.id;
    if (!m || (m.recipientId !== null && m.senderId !== me && m.recipientId !== me)) throw notFound('File not found');
    const file = path.join(uploadDir, m.fileKey);
    if (!fs.existsSync(file)) throw notFound('File not found');
    const kind = kindOf(m.fileMime);
    res.setHeader('Content-Type', kind === 'file' ? 'application/octet-stream' : m.fileMime);
    res.setHeader('Content-Disposition', `${kind === 'file' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(m.fileName)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(path.resolve(file));
  });

  // ----- calls: WebRTC signaling over server-sent events (media itself flows peer to peer) -----
  const online = new Map(); // userId -> Set of open responses (several tabs / devices)

  const push = (userId, event, data) => {
    for (const r of online.get(userId) ?? []) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  router.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const me = req.user.id;
    if (!online.has(me)) online.set(me, new Set());
    online.get(me).add(res);
    const beat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(beat);
      online.get(me)?.delete(res);
      if (!online.get(me)?.size) online.delete(me);
    });
  });

  router.get('/ice', (_req, res) => res.json({ iceServers: config.iceServers }));

  router.post('/call/signal', validate(signalSchema), (req, res) => {
    const b = req.valid.body;
    if (b.to === req.user.id) throw badRequest('You cannot call yourself');
    if (!online.has(b.to)) {
      if (b.type === 'offer') throw conflict('User is offline');
      return res.json({ delivered: false });
    }
    push(b.to, 'signal', {
      from: { id: req.user.id, fullName: req.user.fullName },
      callId: b.callId,
      type: b.type,
      media: b.media,
      data: b.data,
    });
    res.json({ delivered: true });
  });

  // Mark a conversation as read up to a message id. peer = "global" or a user id.
  router.put('/read/:peer', validate(readSchema), (req, res) => {
    const peer = req.params.peer === 'global' ? 'g' : String(idSchema.parse(req.params.peer));
    setRead.run(req.user.id, peer, req.valid.body.upTo);
    res.json({ ok: true });
  });

  return router;
}
