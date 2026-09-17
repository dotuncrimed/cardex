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
  deleteDoc,
  query,
  orderBy,
  limit,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { buildDeck, shuffle, sortCards } from "./cards.js";
import { botArrangeHand } from "./bot.js";
import { calculateResults } from "./scoring.js";
import { detectSpecial } from "./evaluator.js";

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
  await claimHostIfOrphan(code);
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
  await claimHostIfOrphan(roomId);
}

export async function leaveRoom(user, roomId) {
  const room = await getRoom(roomId);

  if (!room) return;

  const leavingPlayer = room.players.find((p) => p.uid === user.uid);
  let players = room.players.filter((p) => p.uid !== user.uid);
  let spectators = room.spectators.filter((s) => s.uid !== user.uid);
  let hostId = room.hostId;

  const activeRound = ["arranging", "scoring"].includes(room.status);

  if (hostId === user.uid) {
    const nextHost = players.find((p) => !p.isBot);
    if (!nextHost) {
      await deleteDoc(roomRef(roomId));
      return;
    }
    hostId = nextHost.uid;
  }

  if (activeRound && leavingPlayer && players.some((p) => !p.isBot)) {
    players.push(makeBot(leavingPlayer.seat, room.settings.botLevel));
  }

  players.sort((a, b) => a.seat - b.seat);

  if (players.length === 0 && spectators.length === 0) {
    await deleteDoc(roomRef(roomId));
    return;
  }

  await updateDoc(roomRef(roomId), {
    players,
    spectators,
    hostId,
    updatedAt: Date.now()
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

export async function submitArrangement(roomId, uid, arrangement, isFouled = false) {
  await setDoc(
    handRef(roomId, uid),
    {
      arrangement,
      fouled: isFouled,
      submitted: true,
      updatedAt: Date.now()
    },
    { merge: true }
  );

  await updatePlayerField(roomId, uid, "submitted", true);
}

export async function declareSpecial(roomId, uid, hand) {
  const spec = detectSpecial(hand);
  if (!spec) throw new Error("No special hand.");
  const sorted = sortCards(hand);
  const arrangement = {
    front: sorted.slice(0, 3),
    middle: sorted.slice(3, 8),
    back: sorted.slice(8, 13)
  };
  await setDoc(
    handRef(roomId, uid),
    { arrangement, special: spec, fouled: false, submitted: true, updatedAt: Date.now() },
    { merge: true }
  );
  await updatePlayerField(roomId, uid, "submitted", true);
  return spec;
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
    pot: 0,
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
      fouled: false,
      submitted: false,
      roundNumber,
      updatedAt: Date.now()
    });

    if (player.isBot) {
      const spec = detectSpecial(hand);
      if (spec) {
        const sorted = sortCards(hand);
        await setDoc(
          handRef(roomId, player.uid),
          {
            arrangement: {
              front: sorted.slice(0, 3),
              middle: sorted.slice(3, 8),
              back: sorted.slice(8, 13)
            },
            special: spec,
            fouled: false,
            submitted: true,
            updatedAt: Date.now()
          },
          { merge: true }
        );
        await updatePlayerField(roomId, player.uid, "submitted", true);
      } else {
        const arrangement = botArrangeHand(
          hand,
          player.botLevel || room.settings.botLevel || "normal"
        );
        await submitArrangement(roomId, player.uid, arrangement, false);
      }
    }
  }
}

export async function replaceUnreadyWithBots(roomId) {
  const room = await getRoom(roomId);

  if (!room) return;

  let players = [...room.players];
  let hostId = room.hostId;

  const hostPlayer = players.find((p) => p.uid === hostId);
  if (hostPlayer && !hostPlayer.isBot && !hostPlayer.ready) {
    const successor = players.find(
      (p) => !p.isBot && p.ready && p.uid !== hostId
    );
    if (successor) {
      hostId = successor.uid;
    } else {
      return; // pause instead of ejecting the host
    }
  }

  players = players.filter((p) => p.isBot || p.ready);

  if (!players.some((p) => !p.isBot)) return; // never run a bot-only table

  players = ensureBots(players, room.settings.botLevel);
  players.sort((a, b) => a.seat - b.seat);

  await updateDoc(roomRef(roomId), {
    players,
    hostId,
    updatedAt: Date.now()
  });
}

export async function claimHostIfOrphan(roomId) {
  const room = await getRoom(roomId);
  if (!room) return;

  const hostInPlayers = room.players.some((p) => p.uid === room.hostId);
  if (hostInPlayers) return;

  const firstHuman = room.players.find((p) => !p.isBot);

  await updateDoc(roomRef(roomId), {
    hostId: firstHuman ? firstHuman.uid : null,
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

  if (room.status !== "arranging" && room.status !== "scoring") return;

  if ((room.roundNumber || 0) > 0 && room.settledRound === room.roundNumber) return;

  if (room.status === "arranging") {
    await updateDoc(roomRef(roomId), { status: "scoring", updatedAt: Date.now() });
  }

  try {
    const handsMap = {};

    for (const player of room.players) {
      const snap = await getDoc(handRef(roomId, player.uid));
      let data = snap.exists() ? snap.data() : null;
      if (!data) continue;

      if (!data.special && data.hand && data.hand.length === 13) {
        const spec = detectSpecial(data.hand);
        if (spec) {
          const sorted = sortCards(data.hand);
          data.special = spec;
          data.arrangement = {
            front: sorted.slice(0, 3),
            middle: sorted.slice(3, 8),
            back: sorted.slice(8, 13)
          };
          data.submitted = true;
          await setDoc(
            handRef(roomId, player.uid),
            { arrangement: data.arrangement, special: spec, submitted: true, updatedAt: Date.now() },
            { merge: true }
          );
        }
      }

      if (!data.arrangement && data.hand && data.hand.length === 13) {
        const arrangement = botArrangeHand(
          data.hand,
          player.botLevel || room.settings.botLevel || "normal"
        );
        await submitArrangement(roomId, player.uid, arrangement, false);
        data.arrangement = arrangement;
        data.submitted = true;
      }

      handsMap[player.uid] = data;
    }

    const results = calculateResults(room, handsMap);

    const fresh = await getRoom(roomId);
    const alreadySettled =
      fresh && fresh.settledRound === results.roundNumber;

    if (!alreadySettled) {
      for (const ranking of results.rankings) {
        if (ranking.isBot) continue;

        const delta = Number(ranking.netCoins) || 0;

        // MONEY-LAYER GUARD: fouled players can never receive coins
        if (ranking.fouled && delta > 0) {
          console.error("BLOCKED positive settlement for fouled player:", ranking.uid);
          continue;
        }

        if (delta !== 0) {
          await adjustCash(
            ranking.username,
            delta,
            "game_settle",
            `Room ${roomId} round ${results.roundNumber}`,
            user.username
          );
        }

        await updateUserStats(
          ranking.username,
          ranking.scorePoints,
          ranking.overallRank === 1 && ranking.scorePoints > 0
        );
      }
    }

    const readyTimerSeconds = Number(room.settings.readyTimerSeconds) || 0;
    const phaseEndsAt = readyTimerSeconds > 0 ? Date.now() + readyTimerSeconds * 1000 : null;
    const players = room.players.map((p) => ({ ...p, submitted: true, ready: Boolean(p.isBot) }));

    await updateDoc(roomRef(roomId), {
      results,
      players,
      status: "round_end",
      phaseEndsAt,
      settledRound: results.roundNumber,
      updatedAt: Date.now()
    });
  } catch (error) {
    console.error("finishRound failed:", error);
    // Emergency: force progress to round_end so room doesn't get stuck
    try {
      const players = room.players.map((p) => ({ ...p, submitted: true, ready: Boolean(p.isBot) }));
      await updateDoc(roomRef(roomId), {
        results: null,
        players,
        status: "round_end",
        phaseEndsAt: null,
        updatedAt: Date.now()
      });
    } catch (e2) {
      console.error("emergency progress failed:", e2);
    }
  }
}

export function listenAllUsers(callback) {
  return onSnapshot(collection(db, "users"), (snapshot) => {
    const users = [];
    snapshot.forEach((docSnap) => {
      users.push({ username: docSnap.id, ...docSnap.data() });
    });
    callback(users);
  });
}

export function listenAllRooms(callback) {
  const q = query(
    collection(db, "rooms"),
    orderBy("createdAt", "desc"),
    limit(30)
  );
  return onSnapshot(q, (snapshot) => {
    const rooms = [];
    snapshot.forEach((d) => rooms.push({ id: d.id, ...d.data() }));
    callback(rooms);
  });
}

export async function spectateRoom(user, code, displayName) {
  code = String(code || "").trim().toUpperCase();
  const room = await getRoom(code);
  if (!room) throw new Error("Room not found.");
  if (room.players.some((p) => p.uid === user.uid)) return code;
  if (room.spectators.some((s) => s.uid === user.uid)) return code;
  const spectators = [
    ...room.spectators,
    { uid: user.uid, username: user.username, displayName, joinedAt: Date.now() }
  ];
  await updateDoc(roomRef(code), { spectators });
  return code;
}

const STALE_MS = 15 * 60 * 1000; // 15 minutes
const sweptRoomIds = new Set();

export async function sweepStaleRooms(rooms, excludeUid) {
  const now = Date.now();

  for (const room of rooms) {
    const roomId = room.id || room.roomCode;
    if (!roomId) continue;
    if (sweptRoomIds.has(roomId)) continue;

    const lastActivity = room.updatedAt || room.createdAt || 0;
    if (now - lastActivity < STALE_MS) continue;

    // don't sweep a room with a live timer (active arrange/ready phase)
    if (room.phaseEndsAt && now < room.phaseEndsAt) continue;

    // don't sweep rooms the current user is inside
    if (excludeUid) {
      const inPlayers = (room.players || []).some((p) => p.uid === excludeUid);
      const inSpectators = (room.spectators || []).some((s) => s.uid === excludeUid);
      if (inPlayers || inSpectators) continue;
    }

    sweptRoomIds.add(roomId);

    try {
      await deleteDoc(roomRef(roomId));
      console.log("Swept stale room:", room.roomCode);
    } catch (error) {
      console.warn("Sweep failed for room:", room.roomCode, error);
    }
  }
}

export const DAILY_BONUS = 10000;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function claimDailyBonus(username) {
  const userRef = doc(db, "users", username);
  const today = todayKey();

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists()) throw new Error("User not found.");

    const data = snap.data();
    if (data.lastClaimDate === today) {
      throw new Error("Already claimed today. Come back tomorrow!");
    }

    const currentCash = Number(data.cash) || 0;
    const newCash = currentCash + DAILY_BONUS;

    tx.update(userRef, {
      cash: newCash,
      lastClaimDate: today,
      updatedAt: Date.now()
    });

    tx.set(doc(db, "users", username, "transactions", today + "_daily"), {
      type: "daily_bonus",
      amount: DAILY_BONUS,
      balanceAfter: newCash,
      note: "Daily login bonus",
      admin: null,
      createdAt: Date.now()
    });

    return newCash;
  });
}

export async function transferCash(fromUsername, toUsername, amount, note) {
  amount = Math.floor(Number(amount));
  if (!amount || amount <= 0) throw new Error("Enter a positive amount.");
  if (fromUsername === toUsername) throw new Error("Cannot send to yourself.");

  const fromRef = doc(db, "users", fromUsername);
  const toRef = doc(db, "users", toUsername);

  return runTransaction(db, async (tx) => {
    const fromSnap = await tx.get(fromRef);
    const toSnap = await tx.get(toRef);
    if (!fromSnap.exists()) throw new Error("Sender not found.");
    if (!toSnap.exists()) throw new Error("Recipient not found.");

    const fromCash = Number(fromSnap.data().cash) || 0;
    if (fromCash < amount) throw new Error("Not enough cash.");

    const newFrom = fromCash - amount;
    const newTo = (Number(toSnap.data().cash) || 0) + amount;

    tx.update(fromRef, { cash: newFrom, updatedAt: Date.now() });
    tx.update(toRef, { cash: newTo, updatedAt: Date.now() });

    const ts = Date.now();
    tx.set(doc(db, "users", fromUsername, "transactions", "out_" + ts), {
      type: "transfer_out",
      amount: -amount,
      balanceAfter: newFrom,
      note: note || "",
      to: toUsername,
      createdAt: ts
    });
    tx.set(doc(db, "users", toUsername, "transactions", "in_" + ts), {
      type: "transfer_in",
      amount: amount,
      balanceAfter: newTo,
      note: note || "",
      from: fromUsername,
      createdAt: ts
    });

    return newFrom;
  });
}

export function listenUserTransactions(username, callback) {
  const q = query(collection(db, "users", username, "transactions"), orderBy("createdAt", "desc"), limit(30));
  return onSnapshot(q, (snapshot) => {
    const txs = [];
    snapshot.forEach((docSnap) => { txs.push({ id: docSnap.id, ...docSnap.data() }); });
    callback(txs);
  });
}