import crypto from 'crypto';
import { getRoom } from './gameState.js';

export function loginRoute(req, res) {
  const { room } = req.query; // ?room=ABCD
  const state = crypto.randomBytes(8).toString('hex');
  req.session.oauthState = { state, room };
  const scope = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative'
].join(' ');
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    scope,
    state
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
}

export async function callbackRoute(req, res) {
  const { code, state } = req.query;
  if (!req.session.oauthState || state !== req.session.oauthState.state) {
    return res.status(400).send('Bad state');
  }
  const roomCode = req.session.oauthState.room;
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI
    })
  });
  const tokens = await tokenRes.json();
  if (tokens.error) {
    return res.status(400).send('Token exchange failed: ' + JSON.stringify(tokens));
  }
  const room = getRoom(roomCode);
  room.hostSpotify = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };
  res.redirect('/host.html');
}

export async function refreshIfNeeded(room) {
  if (!room?.hostSpotify?.refreshToken) return;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: room.hostSpotify.refreshToken
    })
  });
  const data = await res.json();
  if (data.access_token) {
    room.hostSpotify.accessToken = data.access_token;
  }
}

export async function hostAccessTokenRoute(req, res) {
  const { room: roomCode } = req.query;
  const room = getRoom(roomCode);
  if (!room?.hostSpotify?.refreshToken) {
    return res.status(400).json({ error: 'Host not authenticated yet' });
  }
  await refreshIfNeeded(room);
  return res.json({ accessToken: room.hostSpotify.accessToken });
}
