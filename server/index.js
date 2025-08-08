import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { Server } from 'socket.io';
import { urlencoded, json } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loginRoute,
  callbackRoute,
  hostAccessTokenRoute,
  refreshIfNeeded
} from './spotifyAuth.js';
import {
  createRoom,
  publicState,
  startRound,
  hostLockPlacement,
  reserveGap,
  revealRound,
  setHostDevice
} from './gameState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(urlencoded({ extended: true }));
app.use(json());
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: true }));

// --- Auth routes ---
app.get('/auth/login', loginRoute);
app.get('/auth/callback', callbackRoute);
app.get('/auth/host-token', hostAccessTokenRoute);

// --- Static files (host.html, player.html) ---
app.use(express.static(path.join(__dirname, '..', 'client')));

// --- Debug helpers: transfer / play / now / search ---
app.post('/debug/transfer', async (req, res) => {
  const roomCode = req.query.room || 'ABCD';
  const room = createRoom(roomCode);
  await refreshIfNeeded(room);
  const deviceId = room.hostSpotify?.deviceId;
  const token = room.hostSpotify?.accessToken;
  if (!deviceId || !token) return res.status(400).json({ error: 'No host device/token' });

  const r = await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play: false })
  });
  res.status(r.status).end();
});

app.post('/debug/play', async (req, res) => {
  const roomCode = req.query.room || 'ABCD';
  const room = createRoom(roomCode);
  await refreshIfNeeded(room);
  const deviceId = room.hostSpotify?.deviceId;
  const token = room.hostSpotify?.accessToken;
  if (!deviceId || !token) return res.status(400).json({ error: 'No host device/token' });

  const uri = (req.query.uri || '').startsWith('spotify:track:')
    ? req.query.uri
    : 'spotify:track:0eGsygTp906u18L0Oimnem'; // Mr. Brightside (known-good)

  // transfer first (prevents queue resume)
  await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play: false })
  });

  const r = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [uri], position_ms: 0 })
  });
  res.status(r.status).end();
});

app.get('/debug/now', async (req, res) => {
  const roomCode = req.query.room || 'ABCD';
  const room = createRoom(roomCode);
  await refreshIfNeeded(room);
  const token = room.hostSpotify?.accessToken;
  if (!token) return res.status(400).json({ error: 'No token' });

  const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const text = await r.text();
  res.status(r.status).send(text);
});

app.get('/debug/search', async (req, res) => {
  const roomCode = req.query.room || 'ABCD';
  const q = req.query.q || '';
  const market = req.query.market || 'SE';

  const room = createRoom(roomCode);
  await refreshIfNeeded(room);
  const token = room.hostSpotify?.accessToken;
  if (!token) return res.status(400).json({ error: 'No token' });
  if (!q.trim()) return res.json({ items: [] });

  const r = await fetch(
    `https://api.spotify.com/v1/search?type=track&limit=8&market=${encodeURIComponent(market)}&q=${encodeURIComponent(q)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await r.json();
  const items = (data.tracks?.items || []).map(t => ({
    uri: t.uri,
    name: t.name,
    artists: t.artists.map(a => a.name).join(', '),
    album: t.album.name,
    year: t.album.release_date?.slice(0,4) ?? null,
    duration_ms: t.duration_ms
  }));
  res.json({ items });
});

// --- Import a Spotify playlist into the deck ---
app.post('/import/playlist', async (req, res) => {
  const roomCode = (req.body?.room || 'ABCD').toString();
  const market = (req.body?.market || 'SE').toString();
  const input = (req.body?.url || '').toString().trim();

  const room = createRoom(roomCode);
  await refreshIfNeeded(room);
  const token = room.hostSpotify?.accessToken;
  if (!token) return res.status(400).json({ error: 'Host not authed with Spotify yet' });

  const playlistId = extractPlaylistId(input);
  if (!playlistId) return res.status(400).json({ error: 'Could not parse playlist id from input' });

  // page through the playlist
  let offset = 0, got = [], total = Infinity;
  while (offset < total) {
    const r = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&offset=${offset}&market=${market}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: 'Spotify error', detail: text });
    }
    const data = await r.json();
    total = data.total ?? (offset + (data.items?.length || 0));
    got.push(...(data.items || []));
    offset += 100;
    if ((data.items?.length || 0) === 0) break;
  }

  // map to Track shape; filter unplayable/non-tracks; dedupe by uri
  const seen = new Set();
  const tracks = [];
  for (const it of got) {
    const t = it?.track;
    if (!t || t.type !== 'track') continue;
    if (t.is_playable === false) continue;
    if (!t.uri) continue;
    if (seen.has(t.uri)) continue;
    seen.add(t.uri);
    const year = (t.album?.release_date || '').slice(0, 4);
    const artist = (t.artists || []).map(a => a.name).join(', ');
    tracks.push({
      id: t.id,                // reuse Spotify id as our id
      uri: t.uri,
      title: t.name,
      artist,
      year: Number(year) || 0
    });
  }

  if (!tracks.length) return res.status(400).json({ error: 'No playable tracks found for this market' });

  room.tracks = Object.fromEntries(tracks.map(t => [t.id, t]));
  room.deck = shuffle(tracks.map(t => t.id));

  res.json({ ok: true, count: tracks.length, sample: tracks.slice(0, 5) });
});

function extractPlaylistId(input) {
  if (!input) return null;
  if (input.startsWith('spotify:playlist:')) return input.split(':')[2];
  try {
    const u = new URL(input);
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('playlist');
    if (i !== -1 && parts[i+1]) return parts[i+1];
  } catch {}
  return /^[A-Za-z0-9]{22}$/.test(input) ? input : null; // bare ID
}

function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }

// --- Sockets (game flow) ---
io.on('connection', (socket) => {
  socket.on('joinGame', ({ roomCode, name }) => {
    const room = createRoom(roomCode);
    room.players[socket.id] = { id: socket.id, name, score: 0, tokens: 0, timeline: [] };
    socket.join(roomCode);
    io.to(roomCode).emit('state', publicState(room));
  });

  socket.on('declareHost', ({ roomCode }) => {
    const room = createRoom(roomCode);
    room.hostSocketId = socket.id;
    io.to(socket.id).emit('hostReady');
  });

  socket.on('setHostDevice', async ({ roomCode, deviceId }) => {
    const room = createRoom(roomCode);
    setHostDevice(room, deviceId);
  });

  socket.on('startRound', async ({ roomCode }) => {
    const room = createRoom(roomCode);
    await refreshIfNeeded(room);
    const { track, deviceId, accessToken } = startRound(room);
    if (!deviceId) {
      console.warn('No host device registered yet');
      return;
    }

    // Transfer first (avoid queue resume), then play the chosen track
    await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [deviceId], play: false })
    });

    const r = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [track.uri], position_ms: 0 })
    });
    if (r.status !== 204) console.warn('Start round play status:', r.status);
    io.to(roomCode).emit('roundStarted', { trackId: track.id });
  });

  socket.on('hostLockedPlacement', ({ roomCode, insertIndex, titleGuess, artistGuess }) => {
    const room = createRoom(roomCode);
    hostLockPlacement(room, socket.id, { insertIndex, titleGuess, artistGuess });
    io.to(roomCode).emit('interjectionWindowOpen');
  });

  socket.on('reserveGap', ({ roomCode, gapIndex }) => {
    const room = createRoom(roomCode);
    const ok = reserveGap(room, socket.id, gapIndex);
    if (ok) io.to(roomCode).emit('gapReservationUpdate', { gapIndex, by: socket.id });
  });

  socket.on('reveal', ({ roomCode }) => {
    const room = createRoom(roomCode);
    const result = revealRound(room);
    io.to(roomCode).emit('roundReveal', result);
    io.to(roomCode).emit('state', publicState(room));
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Game running on http://localhost:${PORT}`);
});
