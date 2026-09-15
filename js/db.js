import { db } from "./firebase.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  addDoc,
  increment,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { buildDeck, shuffle, sortCards } from "./cards.js";
import { botArrangeHand } from "./bot.js";
import { calculateResults } from "./scoring.js";

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function roomRef(roomId) {
  return doc(db, "rooms", roomId);
}

function handRef(roomId, uid) {
  return doc(db, "rooms", roomId, "hands", uid);
}

function generateRoomCode(length = 5) {
  let code = "";

  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }

  return code;
}

function firstEmptySeat(players) {
  for (let seat = 0; seat < 4; seat++) {
    if (!players.some((player) => player.seat === seat)) {
      return seat;
    }
  }

  return null;
}

function makeBot(seat, botLevel) {
  return {
    uid: `bot_${seat}`,
    username: `bot_${seat}`,
    displayName: `Bot ${seat + 1}`,
    isBot: true,
    botLevel,
    seat,
    ready: true,
    submitted: false,
    connected: true
  };
}

function makeHumanSeat(user, seat) {
  return {
    uid: user.uid,
    username: user.username,
    displayName: user.displayName || user.username,
    isBot: false,
    seat,
    ready: false,
    submitted: false,
    connected: true
  };
}

function ensureBots(players, botLevel) {
  const updated = [...players];

  for (let seat = 0; seat < 4; seat++) {
    if (!updated.some((player) => player.seat === seat)) {
      updated.push(makeBot(seat, botLevel));
    }
  }

  updated.sort((a, b) => a.seat - b.seat);
  return updated;
}

export async function getUserData(username) {
  const snap = await getDoc(doc(db, "users", username));

  if (!snap.exists()) {
    return null;
  }

  return snap.data();
}

export function listenUser(username, callback) {
  return onSnapshot(doc(db, "users", username), (snapshot) => {
    callback(snapshot.exists() ? snapshot.data() : null);
  });
}

export async function createRoom(user, settings) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateRoomCode();
    const ref = roomRef(code);
    const snap = await getDoc(ref);

    if (snap.exists()) {
      continue;
    }

    const room = {
      roomCode: code,
      hostId: user.uid,
      status: "lobby",
      roundNumber: 0,
      pot: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phaseEndsAt: null,
      results: null,
      settings: {
        minBet: Number(settings.minBet) || 0,
        arrangeTimerSeconds: Number(settings.arrangeTimerSeconds) || 0,
        readyTimerSeconds: Number(settings.readyTimerSeconds) || 0,
        botLevel: settings.botLevel || "normal",
        autoFillBots: Boolean(settings.autoFillBots),
        scoopBonus: Boolean(settings.scoopBonus),
        autoArrange: Boolean(settings.autoArrange)
      },
      players: [makeHumanSeat(user, 0)],
      spectators: []
    };

    await setDoc(ref, room);
    return code;
  }

  throw new Error("Could not create room code.");
}

export async function getRoom(roomId) {
  const snap = await getDoc(roomRef(roomId));

  if (!snap.exists()) {
    return null;
  }

  return snap.data();
}

export function listenRoom(roomId, callback) {
  return onSnapshot(roomRef(roomId), (snapshot) => {
    callback(snapshot);
  });
}

export function listenOwnHand(roomId, uid, callback) {
  return onSnapshot(handRef(roomId, uid), (snapshot) => {
    callback(snapshot);
  });
}

export async function joinRoomByCode(user, code, displayName) {
  code = String(code || "").trim().toUpperCase();

  const room = await getRoom(code);

  if (!room) {
    throw new Error("Room not found.");
  }

  const alreadyPlayer = room.players.some((player) => player.uid === user.uid);
  const alreadySpectator = room.spectators.some((spectator) => spectator.uid === user.uid);

  if (alreadyPlayer || alreadySpectator) {
    return code;
  }

  if (["arranging", "scoring"].includes(room.status)) {
    const spectators = [
      ...room.spectators,
      { uid: user.uid, username: user.username, displayName, joinedAt: Date.now() }
    ];
    await updateDoc(roomRef(code), { spectators });
    return code;
  }

  const minBet = Number(room.settings.minBet) || 0;
  const joiner = await getUserData(user.username);
  const hasMoney = Boolean(joiner) && Number(joiner.cash) >= minBet;

  let players = [...room.players];
  let spectators = [...room.spectators];
  const emptySeat = firstEmptySeat(players);

  if (emptySeat !== null && hasMoney) {
    players.push(makeHumanSeat({ ...user, displayName }, emptySeat));
  } else {
    const botIndex = players.findIndex((p) => p.isBot);
    if (hasMoney && botIndex >= 0) {
      players[botIndex] = makeHumanSeat({ ...user, displayName }, players[botIndex].seat);
    } else {
      spectators.push({ uid: user.uid, username: user.username, displayName, joinedAt: Date.now() });
    }
  }

  players.sort((a, b) => a.seat - b.seat);
  await updateDoc(roomRef(code), { players, spectators });
  return code;
}

export async function takeSeat(user, roomId, displayName) {
  const room = await getRoom(roomId);
  if (!room) return;
  if (room.players.some((p) => p.uid === user.uid)) return;
  if (!["lobby", "round_end"].includes(room.status)) {
    throw new Error("You can only take a seat between rounds.");
  }

  const minBet = Number(room.settings.minBet) || 0;
  const me = await getUserData(user.username);
  const hasMoney = Boolean(me) && Number(me.cash) >= minBet;
  if (!hasMoney) throw new Error("Not enough cash to take a seat.");

  let players = [...room.players];
  let spectators = room.spectators.filter((s) => s.uid !== user.uid);
  const emptySeat = firstEmptySeat(players);

  if (emptySeat !== null) {
    players.push(makeHumanSeat({ ...user, displayName }, emptySeat));
  } else {
    const botIndex = players.findIndex((p) => p.isBot);
    if (botIndex < 0) throw new Error("No seat available.");
    players[botIndex] = makeHumanSeat({ ...user, displayName }, players[botIndex].seat);
  }

  players.sort((a, b) => a.seat - b.seat);
  await updateDoc(roomRef(roomId), { players, spectators });
}

export async function leaveRoom(user, roomId) {
  const room = await getRoom(roomId);

  if (!room) return;

  if (["arranging", "scoring"].includes(room.status)) {
    throw new Error("Cannot leave during an active round.");
  }

  let players = room.players.filter((player) => player.uid !== user.uid);
  let spectators = room.spectators.filter((spectator) => spectator.uid !== user.uid);

  if (players.length === 0 && spectators.length === 0) {
    await deleteDoc(roomRef(roomId));
    return;
  }

  let hostId = room.hostId;

  if (hostId === user.uid) {
    const nextHost = players.find((player) => !player.isBot);

    if (!nextHost) {
      await deleteDoc(roomRef(roomId));
      return;
    }

    hostId = nextHost.uid;
  }

  players.sort((a, b) => a.seat - b.seat);

  await updateDoc(roomRef(roomId), {
    players,
    spectators,
    hostId
  });
}

export async function fillBotsInRoom(roomId) {
  const room = await getRoom(roomId);

  if (!room) return;

  const players = ensureBots(room.players, room.settings.botLevel);

  await updateDoc(roomRef(roomId), {
    players
  });
}

export async function updateRoomSettings(roomId, settings) {
  const room = await getRoom(roomId);

  if (!room) return;

  const updatedSettings = {
    ...room.settings,
    ...settings
  };

  await updateDoc(roomRef(roomId), {
    settings: updatedSettings,
    updatedAt: Date.now()
  });
}

export async function adjustCash(username, delta, type, note, adminUsername) {
  const userRef = doc(db, "users", username);
  const snap = await getDoc(userRef);

  if (!snap.exists()) {
    throw new Error("User not found.");
  }

  const currentCash = Number(snap.data().cash) || 0;
  const newCash = Math.max(0, Math.floor(currentCash + delta));

  await updateDoc(userRef, {
    cash: newCash,
    updatedAt: Date.now()
  });

  await addDoc(collection(db, "users", username, "transactions"), {
    type,
    amount: delta,
    balanceAfter: newCash,
    note: note || "",
    admin: adminUsername || null,
    createdAt: Date.now()
  });

  return newCash;
}

export async function setCash(username, amount, reason, adminUsername) {
  const userRef = doc(db, "users", username);
  const snap = await getDoc(userRef);

  if (!snap.exists()) {
    throw new Error("User not found.");
  }

  const currentCash = Number(snap.data().cash) || 0;
  const newCash = Math.max(0, Math.floor(Number(amount)));
  const delta = newCash - currentCash;

  await updateDoc(userRef, {
    cash: newCash,
    updatedAt: Date.now()
  });

  await addDoc(collection(db, "users", username, "transactions"), {
    type: "admin_set",
    amount: delta,
    balanceAfter: newCash,
    note: reason || "",
    admin: adminUsername || "",
    createdAt: Date.now()
  });

  return newCash;
}

export async function updateDisplayName(username, displayName, adminUsername) {
  await updateDoc(doc(db, "users", username), {
    displayName,
    updatedAt: Date.now()
  });

  await addAdminLog(adminUsername, "update_display_name", username, {
    displayName
  });
}

export async function addAdminLog(adminUsername, action, target, details) {
  await addDoc(collection(db, "adminLogs"), {
    adminUsername,
    action,
    target,
    details,
    createdAt: Date.now()
  });
}

async function updatePlayerField(roomId, uid, field, value) {
  const room = await getRoom(roomId);

  if (!room) return;

  const players = room.players.map((player) => {
    if (player.uid === uid) {
      return {
        ...player,
        [field]: value
      };
    }

    return player;
  });

  await updateDoc(roomRef(roomId), {
    players,
    updatedAt: Date.now()
  });
}

export async function submitArrangement(roomId, uid, arrangement) {
  await setDoc(
    handRef(roomId, uid),
    {
      arrangement,
      submitted: true,
      updatedAt: Date.now()
    },
    { merge: true }
  );

  await updatePlayerField(roomId, uid, "submitted", true);
}

export async function setReady(roomId, uid, ready) {
  await updatePlayerField(roomId, uid, "ready", ready);
}

export async function startRound(roomId, user) {
  const room = await getRoom(roomId);

  if (!room) {
    throw new Error("Room not found.");
  }

  if (room.hostId !== user.uid) {
    throw new Error("Only the host can start the round.");
  }

  if (!["lobby", "round_end"].includes(room.status)) {
    throw new Error("Room cannot start right now.");
  }

  let players = room.players.map((player) => ({
    ...player,
    submitted: false,
    ready: Boolean(player.isBot)
  }));

  if (room.settings.autoFillBots !== false) {
    players = ensureBots(players, room.settings.botLevel);
  }

  const humans = players.filter((player) => !player.isBot);

  if (humans.length === 0) {
    throw new Error("At least one human player is required.");
  }

  const minBet = Number(room.settings.minBet) || 0;

  for (const human of humans) {
    const userData = await getUserData(human.username);

    if (!userData || Number(userData.cash) < minBet) {
      throw new Error(`${human.displayName} does not have enough cash.`);
    }
  }

  const roundNumber = (Number(room.roundNumber) || 0) + 1;

  for (const human of humans) {
    if (minBet > 0) {
      await adjustCash(
        human.username,
        -minBet,
        "room_entry",
        `Room ${roomId} round ${roundNumber}`,
        user.username
      );
    }
  }

  const arrangeTimerSeconds = Number(room.settings.arrangeTimerSeconds) || 0;

  const phaseEndsAt =
    arrangeTimerSeconds > 0
      ? Date.now() + arrangeTimerSeconds * 1000
      : null;

  players.sort((a, b) => a.seat - b.seat);

  await updateDoc(roomRef(roomId), {
    players,
    status: "arranging",
    roundNumber,
    pot: minBet * 4,
    results: null,
    phaseEndsAt,
    updatedAt: Date.now()
  });

  const deck = shuffle(buildDeck());

  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    const hand = sortCards(deck.slice(i * 13, (i + 1) * 13));

    await setDoc(handRef(roomId, player.uid), {
      uid: player.uid,
      username: player.username,
      displayName: player.displayName,
      isBot: Boolean(player.isBot),
      hand,
      arrangement: null,
      submitted: false,
      roundNumber,
      updatedAt: Date.now()
    });

    if (player.isBot) {
      const arrangement = botArrangeHand(
        hand,
        player.botLevel || room.settings.botLevel || "normal"
      );

      await submitArrangement(roomId, player.uid, arrangement);
    }
  }
}

export async function replaceUnreadyWithBots(roomId) {
  const room = await getRoom(roomId);

  if (!room) return;

  let players = room.players.filter((player) => {
    return player.isBot || player.ready;
  });

  players = ensureBots(players, room.settings.botLevel);

  await updateDoc(roomRef(roomId), {
    players,
    updatedAt: Date.now()
  });
}

async function updateUserStats(username, points, isWinner) {
  await updateDoc(doc(db, "users", username), {
    games: increment(1),
    points: increment(points || 0),
    wins: increment(isWinner ? 1 : 0),
    updatedAt: Date.now()
  });
}

export async function finishRound(roomId, user) {
  const room = await getRoom(roomId);

  if (!room) return;

  if (room.hostId !== user.uid) return;

  if (room.status !== "arranging") return;

  await updateDoc(roomRef(roomId), {
    status: "scoring",
    updatedAt: Date.now()
  });

  const handsMap = {};

  for (const player of room.players) {
    const snap = await getDoc(handRef(roomId, player.uid));
    let data = snap.exists() ? snap.data() : null;

    if (!data) {
      continue;
    }

    if (!data.arrangement && data.hand && data.hand.length === 13) {
      const arrangement = botArrangeHand(
        data.hand,
        player.botLevel || room.settings.botLevel || "normal"
      );

      await submitArrangement(roomId, player.uid, arrangement);

      data.arrangement = arrangement;
      data.submitted = true;
    }

    handsMap[player.uid] = data;
  }

  const results = calculateResults(room, handsMap);

  for (const ranking of results.rankings) {
    if (ranking.isBot) continue;

    if (ranking.prize > 0) {
      await adjustCash(
        ranking.username,
        ranking.prize,
        "game_win",
        `Room ${roomId} round ${results.roundNumber}`,
        user.username
      );
    }

    await updateUserStats(
      ranking.username,
      ranking.points,
      ranking.prize > 0
    );
  }

  const readyTimerSeconds = Number(room.settings.readyTimerSeconds) || 0;

  const phaseEndsAt =
    readyTimerSeconds > 0
      ? Date.now() + readyTimerSeconds * 1000
      : null;

  const players = room.players.map((player) => ({
    ...player,
    submitted: true,
    ready: Boolean(player.isBot)
  }));

  await updateDoc(roomRef(roomId), {
    results,
    players,
    status: "round_end",
    phaseEndsAt,
    updatedAt: Date.now()
  });
}
