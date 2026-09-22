// js/emoji.js
// Feature 2: In-game emoji splash
// - Click a player seat/avatar ANY time, even through overlays (lobby/results/reveal/zoom)
// - Picker modal lists emojis; clicking one sends it to that player
// - Flight path is ALWAYS sender -> receiver for every viewer
//   (seated player = their seat dock; spectator = their avatar in the gallery strip)
// - No sender name shown on the splash
import { db } from "./firebase.js";
import {
  doc, collection, addDoc, deleteDoc, onSnapshot, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { watchAuth } from "./auth.js";

const EMOJIS = [
  "\u{1F41F}", // fish
  "\u{1F5D1}\u{FE0F}", // trash
  "\u{1F921}", // clown
  "\u{1F4A9}", // poop
  "\u{1F44F}", // clap
  "\u{1F525}", // fire
  "\u{1F62D}", // crying
  "\u{1F34C}", // banana
  "\u{1F480}", // skull
  "\u{1F389}"  // party
];
const SEAT_POS = ["bottom", "left", "top", "right"];
const SEND_COOLDOWN_MS = 1500;
const PRUNE_AFTER_MS = 60000;

const emState = {
  user: null,
  roomId: null,
  room: null,
  unsubRoom: null,
  unsubEmojis: null,
  subscribeTs: 0,
  seen: new Set(),
  lastSentAt: 0
};

function seatOffset(playerSeat, mySeat) {
  return ((playerSeat - mySeat) % 4 + 4) % 4;
}

/* Stable DOM id shared with app.js spectator bar so both ends resolve the same element */
function safeDomId(prefix, raw) {
  return prefix + String(raw == null ? "" : raw).replace(/[^a-zA-Z0-9_-]/g, "");
}

function injectEmojiStyles() {
  if (document.getElementById("emoji-styles-v3")) return;
  const style = document.createElement("style");
  style.id = "emoji-styles-v3";
  style.textContent = `
/* Seats are tappable everywhere */
.seat { cursor: pointer; }
.seat:hover .avatar { transform: scale(1.08); filter: brightness(1.15); }
.seat .avatar { transition: transform 0.15s ease, filter 0.15s ease; }

#emoji-picker-modal {
  position: fixed; z-index: 1300;
  background: rgba(7, 24, 15, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 16px; padding: 12px;
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.6);
  animation: pickerPop 0.2s ease-out;
}
@keyframes pickerPop {
  from { transform: scale(0.8); opacity: 0; }
  to   { transform: scale(1); opacity: 1; }
}
.emoji-pick-btn {
  width: 44px; height: 44px;
  border: none; border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 24px; cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.1s, background 0.1s;
}
.emoji-pick-btn:hover { background: rgba(255, 213, 79, 0.3); transform: scale(1.15); }

.emoji-fly {
  position: absolute; z-index: 62; font-size: 36px;
  pointer-events: none;
  animation: emojiFly 0.8s cubic-bezier(0.25, 0.8, 0.25, 1) forwards;
}
.emoji-splash {
  position: absolute; z-index: 63; transform: translate(-50%,-50%);
  pointer-events: none;
  display: flex; align-items: center; justify-content: center;
}
.emoji-burst { font-size: 56px; animation: emojiSplash 1.2s ease-out forwards; }
.emoji-ring {
  position: absolute; width: 80px; height: 80px; border-radius: 50%;
  border: 4px solid rgba(255,213,79,.85);
  animation: emojiRing 0.8s ease-out forwards;
}
@keyframes emojiFly {
  0%   { transform: translate(0,0) scale(0.6); opacity: 0; }
  15%  { opacity: 1; }
  100% { transform: translate(var(--tx),var(--ty)) scale(1.2); opacity: 1; }
}
@keyframes emojiSplash {
  0%   { transform: scale(0.3); opacity: 0; }
  30%  { transform: scale(1.5); opacity: 1; }
  100% { transform: scale(1.8); opacity: 0; }
}
@keyframes emojiRing {
  0%   { transform: scale(0.3); opacity: .9; }
  100% { transform: scale(2.1); opacity: 0; }
}
`;
  document.head.appendChild(style);
}

function roomVisible() {
  const rs = document.getElementById("room-screen");
  return Boolean(emState.roomId && rs && !rs.classList.contains("hidden"));
}

function myPlayerSeat() {
  if (!emState.room || !emState.user) return null;
  const me = emState.room.players.find((p) => p.uid === emState.user.uid);
  return me ? me.seat : null;
}

/* Exact center of a logical seat in table coordinates (with hidden-seat fallbacks) */
function getSeatCenter(seat) {
  const table = document.querySelector(".pg-table");
  if (!table) return null;
  const lR = table.getBoundingClientRect();
  const mySeat = myPlayerSeat() ?? 0;
  const pos = SEAT_POS[seatOffset(seat, mySeat)];
  const el = document.getElementById("seat-" + pos);
  if (el && el.offsetParent !== null) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return { x: r.left - lR.left + r.width / 2, y: r.top - lR.top + r.height / 2 };
    }
  }
  if (pos === "top") return { x: lR.width / 2, y: lR.height * 0.08 };
  if (pos === "left") return { x: lR.width * 0.12, y: lR.height * 0.46 };
  if (pos === "right") return { x: lR.width * 0.88, y: lR.height * 0.46 };
  return { x: lR.width / 2, y: lR.height / 2 };
}

/* Center of an arbitrary element (spectator avatar / hidden anchor) in table coords */
function elementCenterInTable(table, el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const lR = table.getBoundingClientRect();
  return { x: r.left - lR.left + r.width / 2, y: r.top - lR.top + r.height / 2 };
}

/* Resolve where an emoji came from: gallery station (spectator) or seat dock (player) */
function getOriginCenter(table, ev) {
  if (ev.fromSpectatorUid) {
    const el = document.getElementById(safeDomId("spec-av-", ev.fromSpectatorUid));
    const c = elementCenterInTable(table, el);
    if (c) return c;
    // Spectator bar not rendered yet on this screen -> launch from table center
    const lR = table.getBoundingClientRect();
    return { x: lR.width / 2, y: lR.height / 2 };
  }
  return getSeatCenter(ev.fromSeat);
}

function spawnBurst(table, x, y, ev) {
  const wrap = document.createElement("div");
  wrap.className = "emoji-splash";
  wrap.style.left = x + "px";
  wrap.style.top = y + "px";
  const burst = document.createElement("div");
  burst.className = "emoji-burst";
  burst.textContent = ev.emoji || "\u{1F600}";
  const ring = document.createElement("div");
  ring.className = "emoji-ring";
  wrap.appendChild(ring);
  wrap.appendChild(burst);
  table.appendChild(wrap);
  setTimeout(() => wrap.remove(), 1600);
}

function playSplash(ev) {
  const table = document.querySelector(".pg-table");
  if (!table) return;
  const start = getOriginCenter(table, ev);
  const end = getSeatCenter(ev.toSeat);
  if (!start || !end) return;
  const fly = document.createElement("div");
  fly.className = "emoji-fly";
  fly.textContent = ev.emoji || "\u{1F600}";
  fly.style.left = start.x + "px";
  fly.style.top = start.y + "px";
  fly.style.setProperty("--tx", (end.x - start.x) + "px");
  fly.style.setProperty("--ty", (end.y - start.y) + "px");
  table.appendChild(fly);
  let done = false;
  const land = () => {
    if (done) return;
    done = true;
    fly.remove();
    spawnBurst(table, end.x, end.y, ev);
  };
  fly.addEventListener("animationend", land, { once: true });
  setTimeout(land, 1400);
}

function showEmojiPicker(targetPlayer, anchorEl) {
  let modal = document.getElementById("emoji-picker-modal");
  if (modal) modal.remove();
  modal = document.createElement("div");
  modal.id = "emoji-picker-modal";
  EMOJIS.forEach((emoji) => {
    if (!emoji || !emoji.trim()) return; // never render empty tiles
    const btn = document.createElement("button");
    btn.className = "emoji-pick-btn";
    btn.textContent = emoji;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      sendEmoji(targetPlayer, emoji);
      modal.remove();
    });
    modal.appendChild(btn);
  });
  document.body.appendChild(modal);
  const rect = anchorEl.getBoundingClientRect();
  const modalWidth = 244;
  let left = rect.left + rect.width / 2 - modalWidth / 2;
  let top = rect.bottom + 12;
  if (left < 10) left = 10;
  if (left + modalWidth > window.innerWidth - 10) left = window.innerWidth - modalWidth - 10;
  if (top + 120 > window.innerHeight) top = Math.max(10, rect.top - 120);
  modal.style.left = left + "px";
  modal.style.top = top + "px";
}

async function sendEmoji(target, emoji) {
  const now = Date.now();
  if (now - emState.lastSentAt < SEND_COOLDOWN_MS) return;
  if (!db || !emState.roomId || !emState.user) return;
  emState.lastSentAt = now;
  try {
    const mySeat = myPlayerSeat();
    const isSpectator = mySeat === null;
    await addDoc(collection(db, "rooms", emState.roomId, "emojis"), {
      fromUid: emState.user.uid,
      fromSeat: isSpectator ? -1 : mySeat,
      fromSpectatorUid: isSpectator ? emState.user.uid : null,
      toUid: target.uid,
      toSeat: target.seat,
      emoji: emoji,
      createdAt: Date.now()
    });
  } catch (error) {
    console.error("Failed to send emoji:", error);
  }
}

/* ---- CLICK-THROUGH-OVERLAY SUPPORT ---- */
function isInteractive(el) {
  return el.closest("button, input, select, textarea, a, label, summary, details, .card, #emoji-picker-modal, .spectator-bar");
}

/* Geometry hit-test: which seat zone contains this screen point? */
function seatPosAtPoint(x, y) {
  const pad = 10;
  for (const pos of SEAT_POS) {
    const el = document.getElementById("seat-" + pos);
    if (!el || el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) {
      return pos;
    }
  }
  return null;
}

document.addEventListener("click", (e) => {
  // Close open picker when clicking anywhere else
  const picker = document.getElementById("emoji-picker-modal");
  if (picker && !picker.contains(e.target)) picker.remove();

  if (!roomVisible() || !emState.user || !emState.room) return;
  if (isInteractive(e.target)) return; // never hijack real controls (incl. spectator bar)
  if (!e.target.closest(".pg-table")) return; // only inside the table

  // 1) Direct avatar/seat click (when not covered)
  let pos = null;
  const avatar = e.target.closest(".avatar");
  const seatEl = avatar ? avatar.closest(".seat") : null;
  if (seatEl) {
    pos = seatEl.id.replace("seat-", "");
  } else {
    // 2) Geometry hit-test so taps work THROUGH overlays
    pos = seatPosAtPoint(e.clientX, e.clientY);
  }
  if (!pos || SEAT_POS.indexOf(pos) === -1) return;

  const mySeat = myPlayerSeat() ?? 0;
  const targetSeat = (SEAT_POS.indexOf(pos) + mySeat) % 4;
  const targetPlayer = emState.room.players.find((p) => p.seat === targetSeat);
  if (!targetPlayer) return;

  const anchor = document.getElementById("seat-" + pos) || e.target;
  showEmojiPicker(targetPlayer, anchor);
});

/* ---- FIRESTORE SYNC ---- */
function resubscribe() {
  if (emState.unsubRoom) { emState.unsubRoom(); emState.unsubRoom = null; }
  if (emState.unsubEmojis) { emState.unsubEmojis(); emState.unsubEmojis = null; }
  emState.room = null;
  emState.seen.clear();
  if (!db || !emState.roomId || !emState.user) return;

  emState.unsubRoom = onSnapshot(doc(db, "rooms", emState.roomId),
    (snap) => { emState.room = snap.exists() ? snap.data() : null; },
    () => { emState.room = null; });

  emState.subscribeTs = Date.now();
  const q = query(collection(db, "rooms", emState.roomId, "emojis"),
    orderBy("createdAt", "desc"), limit(15));
  emState.unsubEmojis = onSnapshot(q, (snap) => {
    const now = Date.now();
    snap.forEach((d) => {
      if (emState.seen.has(d.id)) return;
      emState.seen.add(d.id);
      if (emState.seen.size > 200) emState.seen.clear();
      const data = d.data();
      if (!data || !data.createdAt) return;
      if (data.createdAt < now - PRUNE_AFTER_MS) {
        deleteDoc(d.ref).catch(() => {});
        return;
      }
      if (data.createdAt < emState.subscribeTs - 3000) return;
      playSplash(data);
    });
  }, () => {});
}

watchAuth((user) => {
  emState.user = user;
  resubscribe();
});

setInterval(() => {
  const rid = localStorage.getItem("currentRoomId") || null;
  if (rid !== emState.roomId) {
    emState.roomId = rid;
    resubscribe();
  }
}, 800);

injectEmojiStyles();
