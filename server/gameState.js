import fs from 'fs';

const rooms = new Map();
const tracks = JSON.parse(fs.readFileSync(new URL('./tracks.se.json', import.meta.url)));

export function createRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostSocketId: null,
      hostSpotify: null, // { accessToken, refreshToken, deviceId }
      deck: shuffle(tracks.map(t => t.id)),
      tracks: Object.fromEntries(tracks.map(t => [t.id, t])),
      players: {},
      round: undefined,
    });
  }
  return rooms.get(code);
}

export function getRoom(code) {
  return createRoom(code);
}

export function publicState(room) {
  const players = Object.fromEntries(Object.entries(room.players).map(([id, p]) => [
    id,
    { name: p.name, score: p.score, tokens: p.tokens, timeline: p.timeline.map(tid => ({ id: tid, year: room.tracks[tid].year })) }
  ]));
  return { players };
}

export function setHostDevice(room, deviceId) {
  if (!room.hostSpotify) room.hostSpotify = {};
  room.hostSpotify.deviceId = deviceId;
}

export function startRound(room) {
  if (!room.deck.length) {
    // reshuffle if empty
    room.deck = shuffle(Object.keys(room.tracks));
  }
  const trackId = room.deck.pop();
  const playerIds = Object.keys(room.players);
  const turnPlayerId = playerIds[0]; // simple rotate later
  room.round = {
    trackId,
    turnPlayerId,
    interjectionWindow: false,
    gapReservations: {},
    guesses: {}
  };
  const track = room.tracks[trackId];
  return { track, deviceId: room.hostSpotify?.deviceId, accessToken: room.hostSpotify?.accessToken };
}

export function hostLockPlacement(room, playerId, { insertIndex, titleGuess, artistGuess }) {
  if (!room.round || playerId !== room.round.turnPlayerId) return;
  room.round.lockedIndex = insertIndex;
  const track = room.tracks[room.round.trackId];
  const titleOK = norm(titleGuess) === norm(track.title);
  const artistOK = norm(artistGuess) === norm(track.artist);
  room.round.guesses[playerId] = { insertIndex, titleOK, artistOK };
  room.round.interjectionWindow = true;
}

export function reserveGap(room, playerId, gapIndex) {
  if (!room.round?.interjectionWindow) return false;
  if (room.round.gapReservations[gapIndex]) return false;
  const p = room.players[playerId];
  if (!p || p.tokens <= 0) return false;
  p.tokens -= 1;
  room.round.gapReservations[gapIndex] = playerId;
  return true;
}

export function revealRound(room) {
  const tPlayer = room.players[room.round.turnPlayerId];
  const track = room.tracks[room.round.trackId];
  const correctGap = computeCorrectGap(tPlayer.timeline, track, room.tracks);

  const p1Guess = room.round.guesses[tPlayer.id];
  const p1Correct = p1Guess?.insertIndex === correctGap;
  let awardedTokens = [];

  if (p1Correct) {
    tPlayer.timeline.splice(correctGap, 0, track.id);
    tPlayer.score += 1;
  }
  if (p1Guess?.titleOK) tPlayer.score += 1;
  if (p1Guess?.artistOK) tPlayer.score += 1;
  if (p1Guess?.titleOK && p1Guess?.artistOK) {
    tPlayer.tokens = (tPlayer.tokens || 0) + 1;
    awardedTokens.push(tPlayer.id);
  }

  let interjectWinner = null;
  const winnerEntry = Object.entries(room.round.gapReservations).find(([gapIdx]) => Number(gapIdx) === correctGap);
  if (winnerEntry) {
    const [, winnerId] = winnerEntry;
    interjectWinner = winnerId;
    const w = room.players[winnerId];
    w.timeline.splice(computeCorrectGap(w.timeline, track, room.tracks), 0, track.id);
  }

  const result = {
    correctGapIndex: correctGap,
    p1Correct,
    awardedTokens,
    interjectWinner
  };
  room.round = undefined;
  return result;
}

function computeCorrectGap(timeline, track, all) {
  const years = timeline.map(id => all[id].year);
  let idx = 0;
  while (idx < years.length && years[idx] <= track.year) idx++;
  return idx; // 0..N
}

function norm(s) { return (s || '').trim().toLowerCase(); }
function shuffle(a) { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
