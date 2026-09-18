// js/emoji.js
// Feature 2: In-game emoji splash (multiplayer-synced)
// FIXED: Button is now inside the table area, and targeting accurately hits all seats.

import { db } from "./firebase.js";
import {
  doc,
  collection,
  addDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { watchAuth } from "./auth.js";

const EMOJIS = ["🐟", "🗑️", "🤡", "💩", "👏", "🔥", "😭", "🍌", "💀", "🎉"];
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
  trayOpen: false,
  pickedEmoji: null,
  lastSentAt: 0
};

function seatOffset(playerSeat, mySeat) {
  return ((playerSeat - mySeat) % 4 + 4) % 4;
}

function injectEmojiStyles() {
  if (document.getElementById("emoji-styles")) return;

  const style = document.createElement("style");
  style.id = "emoji-styles";

  style.textContent = `
    /* Button is now ABSOLUTE inside .pg-table */
    #emoji-tray-toggle {
      position: absolute; 
      right: 16px; 
      bottom: 80px; 
      z-index: 26;
      width: 52px; height: 52px; border-radius: 50%;
      border: 3px solid rgba(255,255,255,.85);
      background: linear-gradient(145deg,#7c4dff,#536dfe);
      color: #fff; font-size: 26px;
      display: none; align-items: center; justify-content: center;
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
      cursor: pointer; padding: 0;
    }
    #emoji-tray-toggle:active { transform: scale(.92); }

    /* Tray remains FIXED to body so it doesn't get clipped by table overflow */
    .emoji-tray, .emoji-targets {
      position: fixed; right: 14px; bottom: 140px; z-index: 1250;
      width: 250px; max-height: 60vh; overflow: auto;
      background: rgba(7,24,15,.97);
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 16px; padding: 12px;
    }

    .emoji-tray-head, .emoji-targets-head {
      font-weight: 800; font-size: 13px; color: #ffd54f; margin-bottom: 8px;
    }

    .emoji-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }

    .emoji-pick {
      height: 40px; border: none; border-radius: 10px;
      background: rgba(255,255,255,.08); font-size: 22px;
      cursor: pointer; padding: 0;
    }
    .emoji-pick.active { background: rgba(255,213,79,.35); outline: 2px solid #ffd54f; }

    .emoji-close, .emoji-back {
      width: 100%; margin-top: 8px; border: none; border-radius: 10px;
      height: 34px; background: rgba(255,255,255,.12); color: #fff;
      font-weight: 700; cursor: pointer;
    }

    .emoji-target-row {
      display: flex; align-items: center; gap: 10px; width: 100%;
      border: none; border-radius: 12px; background: rgba(255,255,255,.06);
      color: #fff; padding: 8px 10px; margin-bottom: 6px;
      cursor: pointer; font-size: 14px; font-weight: 700;
    }
    .emoji-target-row:hover { background: rgba(255,213,79,.2); }

    .emoji-target-avatar {
      width: 30px; height: 30px; border-radius: 50%;
      background: linear-gradient(145deg,#ffd54f,#ff9800); color: #332000;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; flex: 0 0 auto;
    }

    .emoji-target-name { flex: 1; text-align: left; }

    #emoji-toast {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      z-index: 1300; background: rgba(0,0,0,.8); color: #fff;
      border-radius: 999px; padding: 8px 18px;
      font-weight: 700; font-size: 13px; display: none;
    }

    .emoji-fly {
      position: absolute; z-index: 62; font-size: 30px;
      pointer-events: none; animation: emojiFly .9s ease-in forwards;
    }

    .emoji-splash {
      position: absolute; z-index: 63; transform: translate(-50%,-50%);
      pointer-events: none; display: flex; align-items: center; justify-content: center;
    }

    .emoji-burst { font-size: 48px; animation: emojiSplash 1.4s ease-out forwards; }

    .emoji-ring {
      position: absolute; width: 70px; height: 70px; border-radius: 50%;
      border: 4px solid rgba(255,213,79,.85);
      animation: emojiRing 1s ease-out forwards;
    }

    .emoji-tag {
      position: absolute; top: 44px; white-space: nowrap;
      background: rgba(0,0,0,.75); color: #ffe082;
      border-radius: 999px; padding: 3px 10px; font-size: 11px; font-weight: 800;
    }

    @keyframes emojiFly {
      0%   { transform: translate(0,0) scale(.5); opacity: 0; }
      15%  { opacity: 1; }
      100% { transform: translate(var(--tx),var(--ty)) scale(1.15); opacity: 1; }
    }

    @keyframes emojiSplash {
      0%   { transform: scale(.3); opacity: 0; }
      25%  { transform: scale(1.5); opacity: 1; }
      55%  { transform: scale(1.1); }
      100% { transform: scale(1.8); opacity: 0; }
    }

    @keyframes emojiRing {
      0%   { transform: scale(.3); opacity: .9; }
      100% { transform: scale(2.1); opacity: 0; }
    }
  `;

  document.head.appendChild(style);
}

function toast(message) {
  let el = document.getElementById("emoji-toast");

  if (!el) {
    el = document.createElement("div");
    el.id = "emoji-toast";
    document.body.appendChild(el);
  }

  el.textContent = message;
  el.style.display = "block";

  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => {
    el.style.display = "none";
  }, 1600);
}

function ensureUI() {
  if (document.getElementById("emoji-tray-toggle")) return;

  const table = document.querySelector(".pg-table");
  if (!table) return;

  const toggle = document.createElement("button");
  toggle.id = "emoji-tray-toggle";
  toggle.textContent = "😂";
  toggle.title = "Send an emoji";

  toggle.addEventListener("click", () => {
    emState.trayOpen = !emState.trayOpen;
    emState.pickedEmoji = null;
    renderTray();
  });

  // Append to table so it stays in the lower right of the table area
  table.appendChild(toggle);

  const tray = document.createElement("div");
  tray.id = "emoji-tray";
  tray.className = "emoji-tray hidden";
  document.body.appendChild(tray);

  const targets = document.createElement("div");
  targets.id = "emoji-targets";
  targets.className = "emoji-targets hidden";
  document.body.appendChild(targets);
}

function roomVisible() {
  const rs = document.getElementById("room-screen");
  return Boolean(emState.roomId && rs && !rs.classList.contains("hidden"));
}

function refreshVisibility() {
  const toggle = document.getElementById("emoji-tray-toggle");
  if (!toggle) return;

  const show = roomVisible() && Boolean(emState.user);
  toggle.style.display = show ? "flex" : "none";

  if (!show && emState.trayOpen) {
    emState.trayOpen = false;
    emState.pickedEmoji = null;
    renderTray();
  }
}

function renderTray() {
  const tray = document.getElementById("emoji-tray");
  const targets = document.getElementById("emoji-targets");
  if (!tray || !targets) return;

  if (!emState.trayOpen) {
    tray.classList.add("hidden");
    targets.classList.add("hidden");
    return;
  }

  targets.classList.add("hidden");
  tray.classList.remove("hidden");
  tray.innerHTML = "";

  const head = document.createElement("div");
  head.className = "emoji-tray-head";
  head.textContent = "Pick an emoji, then a player";
  tray.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "emoji-grid";

  EMOJIS.forEach((emoji) => {
    const b = document.createElement("button");
    b.className = "emoji-pick" + (emState.pickedEmoji === emoji ? " active" : "");
    b.textContent = emoji;

    b.addEventListener("click", () => {
      emState.pickedEmoji = emoji;
      renderTargets();
    });

    grid.appendChild(b);
  });

  tray.appendChild(grid);

  const close = document.createElement("button");
  close.className = "emoji-close";
  close.textContent = "Close";
  close.addEventListener("click", () => {
    emState.trayOpen = false;
    renderTray();
  });
  tray.appendChild(close);
}

function renderTargets() {
  const tray = document.getElementById("emoji-tray");
  const targets = document.getElementById("emoji-targets");
  if (!tray || !targets) return;

  if (!emState.pickedEmoji) {
    renderTray();
    return;
  }

  tray.classList.add("hidden");
  targets.classList.remove("hidden");
  targets.innerHTML = "";

  const head = document.createElement("div");
  head.className = "emoji-targets-head";
  head.textContent = "Send " + emState.pickedEmoji + " to...";
  targets.appendChild(head);

  const players = emState.room
    ? [...emState.room.players].sort((a, b) => a.seat - b.seat)
    : [];

  if (players.length === 0) {
    const empty = document.createElement("div");
    empty.className = "emoji-targets-head";
    empty.textContent = "Waiting for players...";
    targets.appendChild(empty);
  }

  players.forEach((player) => {
    const row = document.createElement("button");
    row.className = "emoji-target-row";

    const avatar = document.createElement("span");
    avatar.className = "emoji-target-avatar";
    avatar.textContent = (player.displayName || "?").charAt(0).toUpperCase();

    const name = document.createElement("span");
    name.className = "emoji-target-name";
    name.textContent =
      player.displayName +
      (emState.user && player.uid === emState.user.uid ? " (You)" : "");

    const aim = document.createElement("span");
    aim.textContent = "🎯";

    row.appendChild(avatar);
    row.appendChild(name);
    row.appendChild(aim);

    row.addEventListener("click", () => sendEmoji(player));

    targets.appendChild(row);
  });

  const back = document.createElement("button");
  back.className = "emoji-back";
  back.textContent = "← Back";
  back.addEventListener("click", renderTray);
  targets.appendChild(back);
}

function myPlayerSeat() {
  if (!emState.room || !emState.user) return null;
  const me = emState.room.players.find((p) => p.uid === emState.user.uid);
  return me ? me.seat : null;
}

function playerSeat(uid) {
  if (!emState.room) return null;
  const p = emState.room.players.find((x) => x.uid === uid);
  return p ? p.seat : null;
}

function myDisplayName() {
  if (!emState.room || !emState.user) return emState.user ? emState.user.username : "?";
  const me = emState.room.players.find((p) => p.uid === emState.user.uid);
  return me ? me.displayName : emState.user.username;
}

function spawnBurst(table, x, y, ev) {
  const wrap = document.createElement("div");
  wrap.className = "emoji-splash";
  wrap.style.left = x + "px";
  wrap.style.top = y + "px";

  const burst = document.createElement("div");
  burst.className = "emoji-burst";
  burst.textContent = ev.emoji || "😀";

  const ring = document.createElement("div");
  ring.className = "emoji-ring";

  const tag = document.createElement("div");
  tag.className = "emoji-tag";
  tag.textContent = ev.fromName || "Someone";

  wrap.appendChild(ring);
  wrap.appendChild(burst);
  wrap.appendChild(tag);

  table.appendChild(wrap);

  setTimeout(() => wrap.remove(), 1600);
}

function playSplash(ev) {
  const table = document.querySelector(".pg-table");
  if (!table) return;

  // Use seats directly from the event payload to guarantee accuracy
  const mySeat = ev.fromSeat ?? myPlayerSeat();
  const targetSeat = ev.toSeat ?? playerSeat(ev.toUid);

  let targetEl = null;
  if (targetSeat !== null && mySeat !== null) {
    targetEl = document.querySelector("#seat-" + SEAT_POS[seatOffset(targetSeat, mySeat)]);
  }

  const lR = table.getBoundingClientRect();
  const tR = targetEl ? targetEl.getBoundingClientRect() : null;

  let tx, ty;

  // If the element is hidden (display: none) or missing, fallback to CSS layout percentages
  if (tR && tR.width > 0) {
    tx = tR.left - lR.left + tR.width / 2;
    ty = tR.top - lR.top + tR.height / 2;
  } else {
    if (targetSeat === 0) { // bottom
      tx = lR.width / 2;
      ty = lR.height - 60;
    } else if (targetSeat === 1) { // left
      tx = lR.width * 0.12;
      ty = lR.height * 0.46;
    } else if (targetSeat === 2) { // top
      tx = lR.width / 2;
      ty = lR.height * 0.08;
    } else if (targetSeat === 3) { // right
      tx = lR.width * 0.88;
      ty = lR.height * 0.46;
    } else {
      tx = lR.width / 2;
      ty = lR.height / 2;
    }
  }

  const sx = lR.width / 2;
  const sy = lR.height - 60;

  const fly = document.createElement("div");
  fly.className = "emoji-fly";
  fly.textContent = ev.emoji || "😀";
  fly.style.left = sx + "px";
  fly.style.top = sy + "px";
  fly.style.setProperty("--tx", (tx - sx) + "px");
  fly.style.setProperty("--ty", (ty - sy) + "px");

  table.appendChild(fly);

  let done = false;
  const land = () => {
    if (done) return;
    done = true;
    fly.remove();
    spawnBurst(table, tx, ty, ev);
  };

  fly.addEventListener("animationend", land, { once: true });
  setTimeout(land, 1400);
}

function resubscribe() {
  if (emState.unsubRoom) {
    emState.unsubRoom();
    emState.unsubRoom = null;
  }

  if (emState.unsubEmojis) {
    emState.unsubEmojis();
    emState.unsubEmojis = null;
  }

  emState.room = null;
  emState.seen.clear();

  if (!db || !emState.roomId || !emState.user) return;

  emState.unsubRoom = onSnapshot(
    doc(db, "rooms", emState.roomId),
    (snap) => {
      emState.room = snap.exists() ? snap.data() : null;
      if (emState.trayOpen && emState.pickedEmoji) renderTargets();
    },
    () => {
      emState.room = null;
    }
  );

  emState.subscribeTs = Date.now();

  const q = query(
    collection(db, "rooms", emState.roomId, "emojis"),
    orderBy("createdAt", "desc"),
    limit(15)
  );

  emState.unsubEmojis = onSnapshot(
    q,
    (snap) => {
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
    },
    () => {}
  );
}

async function sendEmoji(target) {
  const now = Date.now();

  if (now - emState.lastSentAt < SEND_COOLDOWN_MS) {
    toast("Slow down! 😅");
    return;
  }

  if (!db || !emState.roomId || !emState.user) return;

  emState.lastSentAt = now;

  try {
    await addDoc(collection(db, "rooms", emState.roomId, "emojis"), {
      fromUid: emState.user.uid,
      fromName: myDisplayName(),
      fromSeat: myPlayerSeat(), // Pass seat index directly
      toUid: target.uid,
      toName: target.displayName || target.username,
      toSeat: target.seat,       // Pass seat index directly
      emoji: emState.pickedEmoji || "😀",
      createdAt: Date.now()
    });

    emState.pickedEmoji = null;
    emState.trayOpen = false;
    renderTray();
  } catch (error) {
    console.error(error);
    toast("Could not send emoji.");
  }
}

watchAuth((user) => {
  emState.user = user;
  resubscribe();
  refreshVisibility();
});

setInterval(() => {
  const rid = localStorage.getItem("currentRoomId") || null;

  if (rid !== emState.roomId) {
    emState.roomId = rid;
    resubscribe();
  }

  refreshVisibility();
}, 800);

injectEmojiStyles();
ensureUI();
