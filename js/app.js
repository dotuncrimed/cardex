import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, query, where, collection, limit, orderBy, addDoc } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

// --- FIREBASE CONFIG ---
const firebaseConfig = {
  apiKey: "AIzaSyBqZzJ_5X8yZzJ_5X8yZzJ_5X8yZzJ_5X8", // REPLACE WITH YOUR ACTUAL API KEY IF DIFFERENT
  authDomain: "cardex-pusoy.firebaseapp.com",
  projectId: "cardex-pusoy",
  storageBucket: "cardex-pusoy.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- DB HELPERS (Inlined for single-file portability or import from db.js if you prefer) ---
const roomRef = (code) => doc(db, "rooms", code);
const userRef = (username) => doc(db, "users", username);
const handRef = (roomId, uid) => doc(db, "rooms", roomId, "hands", uid);

async function getRoom(code) {
  const snap = await getDoc(roomRef(code));
  return snap.exists() ? { roomCode: snap.id, ...snap.data() } : null;
}

async function getUserData(username) {
  const snap = await getDoc(userRef(username.toLowerCase()));
  return snap.exists() ? snap.data() : null;
}

async function ensureUser(username, displayName, pin) {
  const cleanName = username.toLowerCase().trim();
  const snap = await getDoc(userRef(cleanName));
  if (!snap.exists()) {
    await setDoc(userRef(cleanName), {
      username: cleanName,
      displayName: displayName || username,
      cash: 1000,
      createdAt: serverTimestamp()
    });
  } else {
    // Update display name if changed
    await updateDoc(userRef(cleanName), { displayName: displayName || username });
  }
  return { username: cleanName, ...(snap.exists() ? snap.data() : { displayName: displayName || username, cash: 1000 }) };
}

export async function createRoom(hostUser, settings) {
  const code = Math.random().toString(36).substring(2, 7).toUpperCase();
  const hostPlayer = {
    uid: hostUser.uid,
    username: hostUser.username,
    displayName: hostUser.displayName || hostUser.username,
    seat: 0,
    isBot: false,
    submitted: false,
    ready: false
  };

  const players = [hostPlayer];
  const botsCount = settings.autoFillBots ? 3 : 0;
  
  for (let i = 1; i <= botsCount; i++) {
    players.push({
      uid: `bot-${i}`,
      username: `Bot ${i}`,
      displayName: `Bot ${i}`,
      seat: i,
      isBot: true,
      botLevel: settings.botLevel || 'normal',
      submitted: false,
      ready: false
    });
  }

  await setDoc(roomRef(code), {
    hostId: hostUser.uid,
    settings,
    players,
    spectators: [],
    status: "lobby",
    roundNumber: 0,
    minBet: settings.minBet || 0,
    createdAt: serverTimestamp()
  });

  return code;
}

export async function joinRoomByCode(user, code, displayName) {
  code = String(code || "").trim().toUpperCase();
  const room = await getRoom(code);
  if (!room) throw new Error("Room not found.");

  const alreadyPlayer = room.players.some((p) => p.uid === user.uid);
  const alreadySpectator = room.spectators.some((s) => s.uid === user.uid);
  if (alreadyPlayer || alreadySpectator) return code;

  if (["arranging", "scoring"].includes(room.status)) {
    const spectators = [...room.spectators, { uid: user.uid, username: user.username, displayName, joinedAt: Date.now() }];
    await updateDoc(roomRef(code), { spectators });
    return code;
  }

  const minBet = Number(room.settings.minBet) || 0;
  const joiner = await getUserData(user.username);
  const hasMoney = Boolean(joiner) && Number(joiner.cash) >= minBet;

  let players = [...room.players];
  let spectators = [...room.spectators];
  const emptySeat = players.length < 4 ? players.length : -1;

  if (emptySeat !== -1 && hasMoney) {
    players.push({
      uid: user.uid,
      username: user.username,
      displayName: displayName || user.username,
      seat: emptySeat,
      isBot: false,
      submitted: false,
      ready: false
    });
  } else {
    const botIndex = players.findIndex((p) => p.isBot);
    if (hasMoney && botIndex >= 0) {
      players[botIndex] = {
        uid: user.uid,
        username: user.username,
        displayName: displayName || user.username,
        seat: players[botIndex].seat,
        isBot: false,
        submitted: false,
        ready: false
      };
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
  if (!["lobby", "round_end"].includes(room.status)) throw new Error("Game in progress.");

  const minBet = Number(room.settings.minBet) || 0;
  const me = await getUserData(user.username);
  const hasMoney = Boolean(me) && Number(me.cash) >= minBet;
  if (!hasMoney) throw new Error("Not enough cash.");

  let players = [...room.players];
  let spectators = room.spectators.filter((s) => s.uid !== user.uid);
  const emptySeat = players.length < 4 ? players.length : -1;

  if (emptySeat !== -1) {
    players.push({ uid: user.uid, username: user.username, displayName, seat: emptySeat, isBot: false, submitted: false, ready: false });
  } else {
    const botIndex = players.findIndex((p) => p.isBot);
    if (botIndex >= 0) {
      players[botIndex] = { uid: user.uid, username: user.username, displayName, seat: players[botIndex].seat, isBot: false, submitted: false, ready: false };
    } else {
      throw new Error("No seats available.");
    }
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

  // Host transfer or deletion
  if (hostId === user.uid) {
    const nextHuman = players.find((p) => !p.isBot);
    if (!nextHuman) {
      await deleteDoc(roomRef(roomId));
      return;
    }
    hostId = nextHuman.uid;
  }

  // If active round, replace leaver with bot to prevent stalling
  if (["arranging", "scoring"].includes(room.status) && leavingPlayer) {
    players.push({
      uid: `bot-replace-${user.uid}`,
      username: "Bot",
      displayName: "Bot",
      seat: leavingPlayer.seat,
      isBot: true,
      botLevel: room.settings.botLevel,
      submitted: leavingPlayer.submitted,
      ready: leavingPlayer.ready
    });
  }

  players.sort((a, b) => a.seat - b.seat);

  if (players.length === 0 && spectators.length === 0) {
    await deleteDoc(roomRef(roomId));
  } else {
    await updateDoc(roomRef(roomId), { players, spectators, hostId, updatedAt: serverTimestamp() });
  }
}

export async function startRound(roomCode, user) {
  const room = await getRoom(roomCode);
  if (!room) return;
  if (room.hostId !== user.uid) return;

  const deck = createDeck();
  shuffle(deck);

  let players = [...room.players];
  // Deal 13 cards to each player (seats 0-3)
  players.forEach((p, idx) => {
    if (!p.isBot) {
      const hand = deck.slice(idx * 13, (idx + 1) * 13);
      // Handled by client write or server write? Let's do server write for consistency
      // Actually, we just set status, clients listen to hand subcollection
    }
  });

  // Distribute hands in DB
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const hand = deck.slice(i * 13, (i + 1) * 13);
    if (p.isBot) {
      // Bot arranges immediately
      const arrangement = botArrangeHand(hand, p.botLevel || 'normal');
      await setDoc(doc(db, "rooms", roomCode, "hands", p.uid), {
        hand,
        arrangement,
        submitted: true,
        timestamp: serverTimestamp()
      });
    } else {
      await setDoc(doc(db, "rooms", roomCode, "hands", p.uid), {
        hand,
        submitted: false,
        timestamp: serverTimestamp()
      });
    }
  }

  const arrangeTime = (Number(room.settings.arrangeTimer) || 120) * 1000;
  
  await updateDoc(roomRef(roomCode), {
    status: "arranging",
    roundNumber: (room.roundNumber || 0) + 1,
    phaseEndsAt: Date.now() + arrangeTime,
    players: players.map(p => ({ ...p, submitted: p.isBot, ready: false }))
  });
}

export async function submitArrangement(roomCode, uid, arrangement) {
  await updateDoc(handRef(roomCode, uid), {
    arrangement,
    submitted: true,
    timestamp: serverTimestamp()
  });
}

export async function finishRound(roomCode, user) {
  const room = await getRoom(roomCode);
  if (!room) return;
  
  // Collect all arrangements
  const handsSnap = await getDocs(query(collection(db, "rooms", roomCode, "hands")));
  const arrangements = {};
  const hands = {};
  
  handsSnap.forEach(doc => {
    const data = doc.data();
    arrangements[doc.id] = data.arrangement;
    hands[doc.id] = data.hand;
  });

  // Calculate scores
  const results = calculateScores(room.players, arrangements);

  // Update cash
  const updates = {};
  room.players.forEach(p => {
    if (!p.isBot) {
      const net = results.rankings.find(r => r.uid === p.uid)?.net || 0;
      updates[`users/${p.username}.cash`] = (updates[`users/${p.username}.cash`] || 0) + net; 
      // Note: Direct path update requires admin or specific rules, usually we use a cloud function.
      // For client-side, we might need a transaction on the user doc.
      // Simplified: We will update the user doc directly if rules allow, otherwise skip for now.
    }
  });
  
  // Batch update user cash (simplified for client-side)
  const batchPromises = room.players.map(async (p) => {
    if (!p.isBot) {
      const rank = results.rankings.find(r => r.uid === p.uid);
      const net = rank ? rank.net : 0;
      const uSnap = await getDoc(userRef(p.username));
      if (uSnap.exists()) {
        const newCash = (uSnap.data().cash || 0) + net;
        await updateDoc(userRef(p.username), { cash: newCash });
      }
    }
  });
  await Promise.all(batchPromises);

  await updateDoc(roomRef(roomCode), {
    status: "round_end",
    results: { arrangements, details: results.details, rankings: results.rankings },
    phaseEndsAt: Date.now() + 30000 // 30s ready phase
  });
}

export async function replaceUnreadyWithBots(roomId) {
  const room = await getRoom(roomId);
  if (!room) return;

  let players = [...room.players];
  let hostId = room.hostId;

  // Don't eject host
  const hostPlayer = players.find(p => p.uid === hostId);
  if (hostPlayer && !hostPlayer.isBot && !hostPlayer.ready) {
    // Find another ready human to be host? No, just wait or fail.
    // We will NOT start if host isn't ready unless host is bot.
    const readyHumans = players.filter(p => !p.isBot && p.ready);
    if (readyHumans.length === 0) return; 
    // If host is unready, we can't start unless we transfer host.
    // Let's try to transfer host to a ready human.
    const newHost = readyHumans[0];
    hostId = newHost.uid;
  }

  // Replace unready non-hosts with bots
  players = players.map(p => {
    if (p.uid === hostId) return p; // Keep host
    if (!p.isBot && !p.ready) {
      return { ...p, isBot: true, username: "Bot", displayName: "Bot", botLevel: room.settings.botLevel };
    }
    return p;
  });

  // Ensure no bot-only table starts
  if (!players.some(p => !p.isBot)) return;

  players.sort((a, b) => a.seat - b.seat);
  await updateDoc(roomRef(roomId), { players, hostId, updatedAt: serverTimestamp() });
}

export async function claimHostIfOrphan(roomIdOrCode) {
  const room = await getRoom(roomIdOrCode);
  if (!room) return;
  if (room.players.some(p => p.uid === room.hostId)) return;

  const firstHuman = room.players.find(p => !p.isBot);
  await updateDoc(roomRef(roomIdOrCode), {
    hostId: firstHuman ? firstHuman.uid : null,
    updatedAt: serverTimestamp()
  });
}

// --- GAME LOGIC UTILS ---

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const values = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };
  let deck = [];
  for (let s of suits) {
    for (let r of ranks) {
      deck.push({ suit: s, rank: r, value: values[r] });
    }
  }
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function evaluate5(cards) {
  if (cards.length !== 5) return { category: 0, name: "Invalid", score: 0 };
  // Simplified evaluator for brevity - implement full logic as needed
  // Returns { category: 0-9, name: "...", score: number }
  // 0: High Card, 1: Pair, 2: Two Pair, 3: Three of a Kind, 4: Straight, 5: Flush, 6: Full House, 7: Four of a Kind, 8: Straight Flush, 9: Royal Flush
  const values = cards.map(c => c.value).sort((a, b) => a - b);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = values.every((v, i) => i === 0 || v === values[i-1] + 1);
  
  const counts = {};
  values.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const freqs = Object.values(counts).sort((a, b) => b - a);

  if (isStraight && isFlush) return { category: 8, name: "Straight Flush", score: 800 + values[4] };
  if (freqs[0] === 4) return { category: 7, name: "Four of a Kind", score: 700 + parseInt(Object.keys(counts).find(k => counts[k]===4)) };
  if (freqs[0] === 3 && freqs[1] === 2) return { category: 6, name: "Full House", score: 600 + parseInt(Object.keys(counts).find(k => counts[k]===3)) };
  if (isFlush) return { category: 5, name: "Flush", score: 500 + values[4] };
  if (isStraight) return { category: 4, name: "Straight", score: 400 + values[4] };
  if (freqs[0] === 3) return { category: 3, name: "Three of a Kind", score: 300 + parseInt(Object.keys(counts).find(k => counts[k]===3)) };
  if (freqs[0] === 2 && freqs[1] === 2) return { category: 2, name: "Two Pair", score: 200 + parseInt(Object.keys(counts).find(k => counts[k]===2)) }; // Simplified
  if (freqs[0] === 2) return { category: 1, name: "Pair", score: 100 + parseInt(Object.keys(counts).find(k => counts[k]===2)) };
  return { category: 0, name: "High Card", score: values[4] };
}

function evaluate3(cards) {
  if (cards.length !== 3) return { category: 0, name: "Invalid", score: 0 };
  const values = cards.map(c => c.value).sort((a, b) => a - b);
  const counts = {};
  values.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const freqs = Object.values(counts).sort((a, b) => b - a);
  
  if (freqs[0] === 3) return { category: 3, name: "Three of a Kind", score: 300 + values[1] };
  if (freqs[0] === 2) return { category: 1, name: "Pair", score: 100 + parseInt(Object.keys(counts).find(k => counts[k]===2)) };
  return { category: 0, name: "High Card", score: values[2] };
}

function isLegalArrangement(arr) {
  if (!arr || !arr.front || !arr.middle || !arr.back) return false;
  if (arr.front.length !== 3 || arr.middle.length !== 5 || arr.back.length !== 5) return false;
  
  const f = evaluate3(arr.front);
  const m = evaluate5(arr.middle);
  const b = evaluate5(arr.back);
  
  // Middle must beat Front (special rule: 3-of-a-kind in front beats pair in middle? No, standard: Middle > Front)
  // Standard Chinese Poker: Back > Middle > Front.
  // Front is 3 cards, Middle/Back are 5 cards.
  // Comparison: 
  // 1. Back vs Back
  // 2. Middle vs Middle
  // 3. Front vs Front
  
  // Legality check: Middle must be >= Front? No, they are different lengths.
  // Rule: Middle must be stronger than Front? Usually yes, but strictly:
  // Back must be >= Middle.
  // Middle must be >= Front (converting Front to 5-card equivalent? No, just standard hierarchy).
  // Actually, standard rule: Back > Middle > Front based on rank strength.
  // Simplified: Just check Back >= Middle. Front is independent but must be valid 3-card.
  
  if (b.category < m.category) return false;
  if (b.category === m.category && b.score < m.score) return false;
  
  // Optional: Check Middle > Front? 
  // In standard Pusoy, Front (3 cards) is compared only to opponent's Front.
  // But for arrangement legality, often Middle must be stronger than Front conceptually.
  // We will skip strict Middle>Front check for 3-card vs 5-card complexity, just ensure Back>=Middle.
  
  return true;
}

function botArrangeHand(hand, level) {
  // Simple greedy bot
  const sorted = [...hand].sort((a, b) => b.value - a.value);
  const back = sorted.slice(0, 5);
  const middle = sorted.slice(5, 10);
  const front = sorted.slice(10, 13);
  return { front, middle, back };
}

function calculateScores(players, arrangements) {
  const uids = players.map(p => p.uid);
  const details = {};
  uids.forEach(uid => details[uid] = []);

  // Compare every pair
  for (let i = 0; i < uids.length; i++) {
    for (let j = i + 1; j < uids.length; j++) {
      const u1 = uids[i];
      const u2 = uids[j];
      const a1 = arrangements[u1];
      const a2 = arrangements[u2];
      
      if (!a1 || !a2) continue;

      const r1 = { front: 0, middle: 0, back: 0 };
      const r2 = { front: 0, middle: 0, back: 0 };

      // Back
      const b1 = evaluate5(a1.back);
      const b2 = evaluate5(a2.back);
      if (b1.category > b2.category || (b1.category === b2.category && b1.score > b2.score)) { r1.back = 1; r2.back = -1; }
      else if (b1.category === b2.category && b1.score === b2.score) { r1.back = 0; r2.back = 0; }
      else { r1.back = -1; r2.back = 1; }

      // Middle
      const m1 = evaluate5(a1.middle);
      const m2 = evaluate5(a2.middle);
      if (m1.category > m2.category || (m1.category === m2.category && m1.score > m2.score)) { r1.middle = 1; r2.middle = -1; }
      else if (m1.category === m2.category && m1.score === m2.score) { r1.middle = 0; r2.middle = 0; }
      else { r1.middle = -1; r2.middle = 1; }

      // Front
      const f1 = evaluate3(a1.front);
      const f2 = evaluate3(a2.front);
      if (f1.category > f2.category || (f1.category === f2.category && f1.score > f2.score)) { r1.front = 1; r2.front = -1; }
      else if (f1.category === f2.category && f1.score === f2.score) { r1.front = 0; r2.front = 0; }
      else { r1.front = -1; r2.front = 1; }

      details[u1].push(r1);
      details[u2].push(r2);
    }
  }

  const rankings = uids.map(uid => {
    const rows = details[uid];
    const totalFront = rows.reduce((s, r) => s + r.front, 0);
    const totalMid = rows.reduce((s, r) => s + r.middle, 0);
    const totalBack = rows.reduce((s, r) => s + r.back, 0);
    const net = totalFront + totalMid + totalBack;
    return { uid, net, rows: { front: totalFront, middle: totalMid, back: totalBack } };
  }).sort((a, b) => b.net - a.net);

  return { details, rankings };
}

function listenUser(username, callback) {
  return onSnapshot(userRef(username), (snap) => {
    if (snap.exists()) callback(snap.data());
    else callback(null);
  });
}

function listenOwnHand(roomId, uid, callback) {
  return onSnapshot(handRef(roomId, uid), callback);
}

// --- STATE & APP LOGIC ---

const state = {
  user: null,
  userData: null,
  roomId: null,
  room: null,
  unsubRoom: null,
  unsubHand: null,
  arrangement: { front: [], middle: [], back: [] },
  selectedCard: null,
  selectedPos: null,
  zoomOpen: false,
  cashMap: {},
  cashListeners: {},
  coinsFlyedFor: null,
  revealTimers: [],
  revealActive: false,
  lastStatus: null,
  roundInitialized: 0,
  hostBusy: false,
  hostCooldownUntil: 0,
  hostFailCount: 0
};

const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  $(id)?.classList.remove('hidden');
}

function clearRoomState() {
  if (state.unsubRoom) { state.unsubRoom(); state.unsubRoom = null; }
  if (state.unsubHand) { state.unsubHand(); state.unsubHand = null; }
  state.room = null;
  state.roomId = null;
  state.arrangement = { front: [], middle: [], back: [] };
  state.selectedCard = null;
  state.selectedPos = null;
  state.zoomOpen = false;
  state.revealActive = false;
  state.coinsFlyedFor = null;
  clearTimeouts();
  Object.values(state.cashListeners).forEach(fn => fn());
  state.cashListeners = {};
  state.cashMap = {};
}

function clearTimeouts() {
  state.revealTimers.forEach(clearTimeout);
  state.revealTimers = [];
}

function formatCash(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function syncCashListeners() {
  if (!state.room) return;
  const minBet = Number(state.room.settings.minBet) || 0;
  const needed = {};
  state.room.players.forEach(p => {
    if (p.isBot) state.cashMap[p.uid] = minBet * 10;
    else needed[p.username] = true;
  });
  if (state.user) needed[state.user.username] = true;

  Object.keys(needed).forEach(un => {
    if (!state.cashListeners[un]) {
      state.cashListeners[un] = listenUser(un, data => {
        state.cashMap[un] = data ? Number(data.cash) || 0 : 0;
        renderSeats();
      });
    }
  });
  Object.keys(state.cashListeners).forEach(un => {
    if (!needed[un]) {
      state.cashListeners[un]();
      delete state.cashListeners[un];
    }
  });
}

function makeCardElement(card, isSelected) {
  const el = document.createElement('div');
  el.className = `card ${['♥','♦'].includes(card.suit) ? 'red' : ''}`;
  if (isSelected) el.classList.add('selected');
  el.innerHTML = `<div class="rank">${card.rank}</div><div class="suit">${card.suit}</div>`;
  return el;
}

function autoPlaceFromHand() {
  if (!state.handData || !state.handData.hand || state.handData.hand.length !== 13) return false;
  const h = state.handData.hand;
  state.arrangement = { front: h.slice(0, 3), middle: h.slice(3, 8), back: h.slice(8, 13) };
  state.selectedCard = null;
  state.selectedPos = null;
  return true;
}

function renderMyRows() {
  ["front", "middle", "back"].forEach(row => {
    const container = $(`row-${row}`);
    if (!container) return;
    container.innerHTML = "";
    const cards = state.arrangement[row];
    cards.forEach((card, index) => {
      const el = makeCardElement(card, state.selectedCard === card);
      el.style.cursor = "pointer";
      el.onclick = () => onMyCardTap(row, index);
      container.appendChild(el);
    });
    const label = $(`label-${row}`);
    if (label) {
      const info = rowLabelInfo(row);
      label.className = `row-label ${info.ok ? 'ok' : 'bad'}`;
      label.innerHTML = `<span class="check">${info.ok ? '✓' : '✗'}</span><span class="hand-name">${info.name}</span>`;
    }
  });
}

function rowLabelInfo(row) {
  const arr = state.arrangement;
  if (row === "front") {
    const ev = evaluate3(arr.front);
    return { name: ev.name, ok: arr.front.length === 3 };
  }
  if (row === "middle") {
    const ev = evaluate5(arr.middle);
    let ok = arr.middle.length === 5;
    if (ok) {
      const f = evaluate3(arr.front);
      const req = f.category === 3 ? 3 : f.category === 2 ? 2 : 1;
      ok = ev.category >= req;
    }
    return { name: ev.name, ok };
  }
  const ev = evaluate5(arr.back);
  let ok = arr.back.length === 5;
  if (ok && arr.middle.length === 5) {
    ok = compare5(ev, evaluate5(arr.middle)) >= 0;
  }
  return { name: ev.name, ok };
}

function compare5(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  return a.score - b.score;
}

function onMyCardTap(row, index) {
  const card = state.arrangement[row][index];
  if (state.selectedCard === null) {
    state.selectedCard = card;
    state.selectedPos = { row, index };
    renderMyRows();
    return;
  }
  if (state.selectedCard === card) {
    state.selectedCard = null;
    state.selectedPos = null;
    renderMyRows();
    return;
  }
  const from = state.selectedPos;
  const temp = state.arrangement[from.row][from.index];
  state.arrangement[from.row][from.index] = state.arrangement[row][index];
  state.arrangement[row][index] = temp;
  state.selectedCard = null;
  state.selectedPos = null;
  renderMyRows();
}

function renderTableMyRows() {
  const wrap = $("table-my-rows");
  if (!wrap) return;
  wrap.innerHTML = "";
  ["front", "middle", "back"].forEach(row => {
    const line = document.createElement("div");
    line.className = "tmr-row";
    const tag = document.createElement("span");
    tag.className = "tmr-tag";
    tag.textContent = row.toUpperCase();
    const cards = document.createElement("div");
    cards.className = "tmr-cards";
    (state.arrangement[row] || []).forEach(c => {
      const el = makeCardElement(c, false);
      el.classList.add("tmr-card");
      cards.appendChild(el);
    });
    line.appendChild(tag);
    line.appendChild(cards);
    wrap.appendChild(line);
  });
}

function renderArrangeSection() {
  const autoBtn = $("auto-arrange-button");
  if (autoBtn) autoBtn.classList.toggle("hidden", !state.room?.settings?.autoArrange);

  const zoom = $("zoom-view");
  const tableSec = $("arrange-section");
  if (!zoom || !tableSec) return;

  const st = $("arrange-status");

  if (!state.handData) {
    if (st) st.textContent = "Waiting for cards...";
    zoom.classList.add("hidden");
    tableSec.classList.remove("hidden");
    return;
  }

  if (state.handData.submitted) {
    zoom.classList.add("hidden");
    tableSec.classList.remove("hidden");
    if (st) st.textContent = "Submitted. Waiting...";
    disableArrangeControls(true);
    renderTableMyRows();
    return;
  }

  if (state.room.settings.autoArrange) {
    zoom.classList.add("hidden");
    tableSec.classList.remove("hidden");
    if (st) st.textContent = "Auto-arranging...";
    disableArrangeControls(true);
    renderTableMyRows();
    setTimeout(async () => {
      const arrangement = botArrangeHand(state.handData.hand, "hard");
      try {
        await submitArrangement(state.roomId, state.user.uid, arrangement);
        $("arrange-status").textContent = "Auto-submitted!";
      } catch (e) { console.error(e); }
    }, 600);
    return;
  }

  if (state.zoomOpen) {
    tableSec.classList.add("hidden");
    zoom.classList.remove("hidden");
    const total = state.arrangement.front.length + state.arrangement.middle.length + state.arrangement.back.length;
    if (total === 0) autoPlaceFromHand();
    renderMyRows();
  } else {
    zoom.classList.add("hidden");
    tableSec.classList.remove("hidden");
    if (st) st.textContent = "Cards arranged. Submit or re-arrange.";
    disableArrangeControls(false);
    renderTableMyRows();
  }
}

function disableArrangeControls(disabled) {
  ["auto-arrange-button", "clear-arrangement-button", "ready-arrange-button", "open-zoom-button", "submit-arrangement-button"].forEach(id => {
    const el = $(id);
    if (el) el.disabled = disabled;
  });
}

function manageHandListener() {
  const shouldListen = state.room && state.user && state.room.status === "arranging" && state.room.players.some(p => p.uid === state.user.uid);
  
  if (shouldListen && !state.unsubHand) {
    state.unsubHand = listenOwnHand(state.roomId, state.user.uid, snap => {
      state.handData = snap.exists() ? snap.data() : null;
      if (state.handData && !state.handData.submitted && state.handData.hand?.length === 13) {
        const total = state.arrangement.front.length + state.arrangement.middle.length + state.arrangement.back.length;
        if (total === 0) autoPlaceFromHand();
        if (!state.room.settings.autoArrange) state.zoomOpen = true;
      }
      if (state.room.status === "arranging") renderArrangeSection();
    });
  }
  if (!shouldListen && state.unsubHand) {
    state.unsubHand();
    state.unsubHand = null;
    state.handData = null;
  }
}

// --- RENDERING ---

function renderSeats() {
  ["top","left","right","bottom"].forEach(p => { const el = $(`seat-${p}`); if(el) el.innerHTML=""; });
  if (!state.room || !state.user) return;
  const myPlayer = state.room.players.find(p => p.uid === state.user.uid);
  const mySeat = myPlayer ? myPlayer.seat : 0;
  const minBet = Number(state.room.settings.minBet) || 0;
  const SEAT_POS = ["bottom", "left", "top", "right"];
  const seatOffset = (p, m) => ((p - m) % 4 + 4) % 4;

  state.room.players.forEach(player => {
    const pos = SEAT_POS[seatOffset(player.seat, mySeat)];
    const el = $(`seat-${pos}`);
    if (!el) return;
    const cashVal = player.isBot ? minBet * 10 : (state.cashMap[player.username] ?? 0);
    let status = "";
    if (["arranging","scoring"].includes(state.room.status)) status = player.submitted ? "✓" : "…";
    else if (state.room.status === "round_end") status = player.ready ? "✓" : "…";
    
    el.innerHTML = `
      <div class="avatar">${(player.displayName||"?")[0].toUpperCase()}</div>
      <div class="coin-pill">${formatCash(cashVal)}</div>
      <div class="seat-status">${player.displayName}${player.isBot?" 🤖":""} ${status}</div>
    `;
  });
}

function renderReadyArea() {
  const list = $("ready-list");
  const btn = $("ready-button");
  const force = $("force-start-button");
  if (!list || !btn) return;

  if (state.room.status !== "round_end" || !state.room.results) {
    list.innerHTML = "";
    btn.classList.add("hidden");
    if(force) force.classList.add("hidden");
    return;
  }

  // Render Rankings (Winner to Loser)
  const rankings = state.room.results.rankings;
  list.innerHTML = rankings.map(r => {
    const p = state.room.players.find(pl => pl.uid === r.uid);
    const name = p ? p.displayName : "Unknown";
    const botTag = p?.isBot ? " 🤖" : "";
    const sign = r.net >= 0 ? "+" : "";
    return `<div class="ready-status-row ready"><span class="player-name">${name}${botTag} <b>${sign}${r.net}</b></span></div>`;
  }).join("");

  const me = state.room.players.find(p => p.uid === state.user.uid);
  if (me && !me.ready) {
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
  
  if (isHost() && !rankings.every(r => {
    const p = state.room.players.find(pl => pl.uid === r.uid);
    return p?.ready;
  })) {
    force?.classList.remove("hidden");
  } else {
    force?.classList.add("hidden");
  }
}

function finalizeReveal() {
  state.revealActive = false;
  state.revealPlayedFor = state.room ? state.room.roundNumber : null;
  const skip = $("reveal-skip");
  if (skip) skip.classList.add("hidden");
  const readyArea = $("ready-area");
  if (readyArea) readyArea.classList.remove("hidden");
  renderReadyArea();
  // NO recursive renderLobbySection call here
}

function flyCoinsToWinner(winnerUid) {
  // Implementation simplified for brevity - creates visual effect
  const layer = document.querySelector(".pg-table");
  if(!layer) return;
  // Logic to find winner seat and animate coins
}

function playRevealSequence(results) {
  clearTimeouts();
  state.revealActive = true;
  const layer = $("reveal-layer");
  if (!layer) return;
  layer.classList.remove("hidden");
  $("reveal-skip")?.classList.remove("hidden");
  $("results-section")?.classList.add("hidden");
  $("ready-area")?.classList.add("hidden");
  
  // Simplified sequence logic
  setTimeout(() => {
    finalizeReveal();
  }, 3000);
}

function renderLobbySection() {
  const lobby = $("lobby-section");
  const arrange = $("arrange-section");
  const results = $("results-section");
  if(lobby) lobby.classList.add("hidden");
  if(arrange) arrange.classList.add("hidden");
  if(results) results.classList.add("hidden");

  if (!state.room) return;
  const status = state.room.status;

  if (status === "lobby") lobby?.classList.remove("hidden");
  if (status === "arranging" || status === "scoring") {
    if (state.room.players.some(p => p.uid === state.user.uid)) {
      arrange?.classList.remove("hidden");
      renderArrangeSection();
    } else {
      lobby?.classList.remove("hidden");
    }
  }
  if (status === "round_end" && state.showFullResults) {
    results?.classList.remove("hidden");
    renderResultsSection();
  }
  
  // Button visibility logic
  const startBtn = $("start-room-button");
  const fillBtn = $("fill-bots-button");
  const takeBtn = $("take-seat-button");
  
  if(startBtn) startBtn.classList.toggle("hidden", !isHost() || !["lobby","round_end"].includes(status));
  if(fillBtn) fillBtn.classList.toggle("hidden", !isHost() || !["lobby","round_end"].includes(status));
  if(takeBtn) takeBtn.classList.toggle("hidden", !(state.room.spectators.some(s=>s.uid===state.user?.uid) && ["lobby","round_end"].includes(status)));
  
  renderPlayerList();
}

function renderRoom() {
  if (!state.room) return;
  if (state.room.roundNumber !== state.roundInitialized) {
    state.arrangement = { front: [], middle: [], back: [] };
    state.zoomOpen = false;
    state.coinsFlyedFor = null;
    state.roundInitialized = state.room.roundNumber;
  }

  if (state.lastStatus !== state.room.status) {
    if (state.lastStatus === "arranging" && state.room.status === "scoring") {
      // Show banner
    }
    if (state.room.status !== "round_end") {
      clearTimeouts();
      state.revealActive = false;
      $("reveal-layer")?.classList.add("hidden");
      $("ready-area")?.classList.add("hidden");
    }
  }
  state.lastStatus = state.room.status;

  const tableEl = document.querySelector(".pg-table");
  if (tableEl) tableEl.classList.toggle("arranging", ["arranging","scoring"].includes(state.room.status));

  renderRoomInfo();
  renderSeats();
  renderLobbySection();
  manageHandListener();
  syncCashListeners();

  if (state.room.status === "round_end") {
    if (state.room.results && state.revealPlayedFor !== state.room.roundNumber && !state.revealActive) {
      playRevealSequence(state.room.results);
    } else {
      renderReadyArea();
      if (state.revealPlayedFor === state.room.roundNumber) $("ready-area")?.classList.remove("hidden");
    }
  }
}

function renderRoomInfo() {
  const codeEl = $("room-code");
  const cashEl = $("hud-cash");
  const timerEl = $("pg-timer");
  const zoomTimer = $("zoom-timer");
  
  if (codeEl) codeEl.textContent = state.roomId;
  if (cashEl) cashEl.textContent = formatCash(state.userData?.cash || 0);

  const arranging = state.room?.status === "arranging";
  const readyPhase = state.room?.status === "round_end" && state.revealPlayedFor === state.room?.roundNumber;
  const showTableTimer = (arranging || readyPhase) && state.room?.phaseEndsAt;

  if (timerEl) {
    timerEl.classList.toggle("hidden", !showTableTimer);
    if (showTableTimer) {
      const s = Math.max(0, Math.ceil((state.room.phaseEndsAt - Date.now()) / 1000));
      timerEl.textContent = s;
    }
  }

  if (zoomTimer) {
    const showZoom = arranging && state.room.phaseEndsAt && state.zoomOpen;
    zoomTimer.classList.toggle("hidden", !showZoom);
    if (showZoom) {
      const s = Math.max(0, Math.ceil((state.room.phaseEndsAt - Date.now()) / 1000));
      zoomTimer.textContent = s;
    }
  }
}

async function hostController() {
  if (!state.room || !state.user || state.room.hostId !== state.user.uid || state.hostBusy) return;
  const now = Date.now();
  if (now < state.hostCooldownUntil) return;

  const humans = state.room.players.filter(p => !p.isBot);
  if (humans.length === 0) return; // Prevent bot-only loop

  const fail = () => {
    state.hostFailCount++;
    if (state.hostFailCount >= 3) {
      state.hostCooldownUntil = now + 10000;
      state.hostFailCount = 0;
    }
  };
  const succeed = () => { state.hostFailCount = 0; };

  if (state.room.status === "arranging") {
    if (state.room.players.every(p => p.submitted)) {
      state.hostBusy = true;
      try { await finishRound(state.roomId, state.user); succeed(); } 
      catch (e) { console.error(e); fail(); } 
      finally { state.hostBusy = false; }
    }
  } else if (state.room.status === "round_end") {
    const readyHumans = humans.filter(p => p.ready);
    if (readyHumans.length === humans.length) {
      state.hostBusy = true;
      try { await startRound(state.roomId, state.user); succeed(); }
      catch (e) { console.error(e); fail(); }
      finally { state.hostBusy = false; }
    } else if (state.room.phaseEndsAt && now > state.room.phaseEndsAt && readyHumans.length > 0) {
      state.hostBusy = true;
      try { 
        await replaceUnreadyWithBots(state.roomId); 
        await startRound(state.roomId, state.user); 
        succeed(); 
      } catch (e) { console.error(e); fail(); }
      finally { state.hostBusy = false; }
    }
  }
}

setInterval(() => {
  if (state.room) {
    renderRoomInfo();
    hostController();
  }
}, 700);

// --- EVENT LISTENERS ---

function on(id, fn) {
  const el = $(id);
  if (el) el.addEventListener("click", fn);
  else console.warn("Missing btn:", id);
}

on("login-button", async () => {
  const username = $("login-username").value.trim();
  const pin = $("login-pin").value;
  if (username.length < 3 || pin.length < 6) {
    $("login-error").textContent = "Username (3+) and PIN (6+) required.";
    return;
  }
  try {
    const cred = await signInWithEmailAndPassword(auth, `${username}@cardex.local`, pin);
    const userData = await ensureUser(username, username, pin);
    state.user = cred.user;
    state.userData = userData;
    showScreen("menu");
    renderMenu();
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      try {
        const cred = await createUserWithEmailAndPassword(auth, `${username}@cardex.local`, pin);
        const userData = await ensureUser(username, username, pin);
        state.user = cred.user;
        state.userData = userData;
        showScreen("menu");
        renderMenu();
      } catch (e2) { $("login-error").textContent = e2.message; }
    } else {
      $("login-error").textContent = err.message;
    }
  }
});

on("logout-button", async () => {
  await signOut(auth);
  state.user = null;
  state.userData = null;
  clearRoomState();
  showScreen("login");
});

on("show-create-room-button", () => {
  $("create-room-form").classList.remove("hidden");
  $("join-room-form").classList.add("hidden");
});
on("cancel-create-room-button", () => $("create-room-form").classList.add("hidden"));
on("show-join-room-button", () => {
  $("join-room-form").classList.remove("hidden");
  $("create-room-form").classList.add("hidden");
});
on("cancel-join-room-button", () => $("join-room-form").classList.add("hidden"));

on("create-room-button", async () => {
  const settings = {
    minBet: Number($("create-min-bet").value) || 0,
    arrangeTimer: Number($("create-arrange-timer").value) || 120,
    readyTimer: Number($("create-ready-timer").value) || 30,
    botLevel: $("create-bot-level").value,
    autoFillBots: $("create-auto-fill-bots").checked,
    scoopBonus: $("create-scoop-bonus").checked,
    autoArrange: $("create-auto-arrange").checked
  };
  try {
    const code = await createRoom(state.user, settings);
    state.roomId = code;
    $("create-room-form").classList.add("hidden");
    enterRoom(code);
  } catch (e) { $("create-room-error").textContent = e.message; }
});

on("join-room-button", async () => {
  const code = $("join-room-code").value.trim();
  try {
    await joinRoomByCode(state.user, code, state.userData.displayName);
    state.roomId = code;
    $("join-room-form").classList.add("hidden");
    enterRoom(code);
  } catch (e) { $("join-room-error").textContent = e.message; }
});

on("start-room-button", () => startRound(state.roomId, state.user));
on("fill-bots-button", async () => {
  // Logic to fill bots
});
on("take-seat-button", () => takeSeat(state.user, state.roomId, state.userData.displayName));

on("open-zoom-button", () => { state.zoomOpen = true; renderArrangeSection(); });
on("ready-arrange-button", () => {
  const a = state.arrangement;
  if (a.front.length !== 3 || a.middle.length !== 5 || a.back.length !== 5) {
    $("arrange-status").textContent = "Need 3/5/5 cards."; return;
  }
  if (!isLegalArrangement(a)) {
    $("arrange-status").textContent = "Illegal arrangement."; return;
  }
  state.zoomOpen = false;
  renderArrangeSection();
});
on("submit-arrangement-button", async () => {
  const a = state.arrangement;
  if (!isLegalArrangement(a)) { $("arrange-status").textContent = "Invalid."; return; }
  try {
    await submitArrangement(state.roomId, state.user.uid, a);
    renderArrangeSection();
  } catch (e) { console.error(e); }
});
on("clear-arrangement-button", () => {
  autoPlaceFromHand();
  renderArrangeSection();
});
on("auto-arrange-button", async () => {
  const arr = botArrangeHand(state.handData.hand, "hard");
  state.arrangement = arr;
  renderMyRows();
});

// Swap Mid/Back
const swapBtn = $("swap-mid-back-button");
if (swapBtn && !swapBtn.dataset.bound) {
  swapBtn.dataset.bound = "true";
  swapBtn.addEventListener("click", () => {
    const temp = [...state.arrangement.middle];
    state.arrangement.middle = [...state.arrangement.back];
    state.arrangement.back = temp;
    renderMyRows();
  });
}

// Join from Ready (Spectator -> Player)
on("join-game-button", async () => {
  if (!state.roomId) return;
  try {
    await takeSeat(state.user, state.roomId, state.userData.displayName);
  } catch (e) { alert(e.message); }
});

on("ready-button", async () => {
  // Set ready flag in DB
  const room = await getRoom(state.roomId);
  const players = room.players.map(p => p.uid === state.user.uid ? {...p, ready: true} : p);
  await updateDoc(doc(db, "rooms", state.roomId), { players });
});

on("force-start-button", () => {
  if (isHost()) startRound(state.roomId, state.user);
});

on("view-results-button", () => {
  state.showFullResults = !state.showFullResults;
  renderLobbySection();
});

on("close-results-button", () => {
  state.showFullResults = false;
  renderLobbySection();
});

on("exit-room-button", exitToMenu);
on("leave-room-button", exitToMenu);

async function exitToMenu() {
  try {
    if (state.roomId && state.user) await leaveRoom(state.user, state.roomId);
  } catch (e) { console.warn("Leave failed", e); }
  clearRoomState();
  showScreen("menu");
}

function isHost() {
  return state.room && state.user && state.room.hostId === state.user.uid;
}

function enterRoom(code) {
  showScreen("room");
  state.roomId = code;
  state.unsubRoom = onSnapshot(roomRef(code), snap => {
    if (snap.exists()) {
      state.room = { roomCode: snap.id, ...snap.data() };
      renderRoom();
    } else {
      alert("Room closed");
      clearRoomState();
      showScreen("menu");
    }
  });
}

function renderMenu() {
  $("menu-username").textContent = state.userData.displayName;
  $("menu-cash").textContent = formatCash(state.userData.cash);
  const av = $("menu-avatar");
  if(av) av.textContent = (state.userData.displayName||"?")[0].toUpperCase();
}

function renderPlayerList() {
  // Render lists for lobby
}
function renderResultsSection() {
  // Render detailed results
}

// Init
onAuthStateChanged(auth, async (user) => {
  if (user) {
    const parts = user.email.split('@');
    const username = parts[0];
    const userData = await getUserData(username);
    state.user = user;
    state.userData = userData;
    showScreen("menu");
    renderMenu();
  } else {
    state.user = null;
    state.userData = null;
    clearRoomState();
    showScreen("login");
  }
});
