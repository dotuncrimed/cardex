import { isFirebaseConfigured } from "./firebase.js";
import { watchAuth, loginOrRegister, logoutUser } from "./auth.js";
import { ADMIN_PASSWORD } from "./config.js";
import {
  rankOf,
  suitOf,
  suitSymbol,
  isRedSuit,
  sortCards
} from "./cards.js";
import {
  isLegalArrangement,
  evaluate5,
  evaluate3,
  compare5
} from "./evaluator.js";
import { botArrangeHand } from "./bot.js";
import {
  listenUserTransactions,
  createRoom,
  joinRoomByCode,
  takeSeat,
  leaveRoom,
  listenRoom,
  listenOwnHand,
  listenUser,
  startRound,
  finishRound,
  submitArrangement,
  setReady,
  fillBotsInRoom,
  replaceUnreadyWithBots,
  updateRoomSettings,
  getUserData,
  adjustCash,
  setCash,
  updateDisplayName,
  addAdminLog,
  listenAllUsers,
  listenAllRooms,
  spectateRoom,
  sweepStaleRooms,
  claimDailyBonus,
  transferCash
} from "./db.js";

const state = {
  user: null,
  userData: null,
  roomId: localStorage.getItem("currentRoomId") || null,
  room: null,
  handData: null,
  arrangement: {
    front: [],
    middle: [],
    back: []
  },
  selectedCards: new Set(),
  targetRow: "front",
  roundInitialized: null,
  unsubRoom: null,
  unsubHand: null,
  unsubUser: null,
  adminLoggedIn: sessionStorage.getItem("adminLoggedIn") === "true",
  hostBusy: false,
  hostCooldownUntil: 0,
  hostFailCount: 0,
  autoSubmitting: false,
  autoSubmitFailUntil: 0,
  selectedCard: null,
  selectedPos: null,
  lastStatus: null,
  revealTimers: [],
  revealActive: false,
  revealPlayedFor: null,
  dealAnimPlayedFor: null,
  showFullResults: false,
  zoomOpen: false,
  cashMap: {},
  cashListeners: {},
  coinsFlyedFor: null,
  transactions: [],
  unsubTransactions: null,
  adminUsers: [],
  adminUnsub: null,
  adminSearch: "",
  adminSelectedUsername: null,
  allRooms: [],
  roomsUnsub: null
};

function $(selector) {
  return document.querySelector(selector);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCash(n) {
  n = Number(n) || 0;

  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";

  return String(n);
}

function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value;
}

function showScreen(name) {
  const screens = [
    $("#login-screen"),
    $("#menu-screen"),
    $("#room-screen"),
    $("#admin-screen")
  ];

  screens.forEach((screen) => {
    if (screen) screen.classList.add("hidden");
  });

  const target = $(`#${name}-screen`);
  if (target) target.classList.remove("hidden");
}

function setRoomMessage(message) {
  setText("#room-message", message || "");
}

function setAdminMessage(message) {
  setText("#admin-message", message || "");
}

function emptyArrangement() {
  return {
    front: [],
    middle: [],
    back: []
  };
}

function statusInfo(status) {
  if (status === "lobby") {
    return {
      label: "Waiting",
      cls: "st-waiting"
    };
  }

  if (status === "arranging" || status === "scoring") {
    return {
      label: "Playing",
      cls: "st-playing"
    };
  }

  return {
    label: "Round End",
    cls: "st-roundend"
  };
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));

  if (s < 60) return s + "s ago";

  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";

  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";

  return Math.floor(h / 24) + "d ago";
}

function assignedCardsSet() {
  return new Set([
    ...state.arrangement.front,
    ...state.arrangement.middle,
    ...state.arrangement.back
  ]);
}

function currentUserInRoomPlayers() {
  if (!state.room || !state.user) return false;
  return state.room.players.some((player) => player.uid === state.user.uid);
}

function currentUserInRoomSpectators() {
  if (!state.room || !state.user) return false;
  return state.room.spectators.some((spectator) => spectator.uid === state.user.uid);
}

function currentUserPlayerObject() {
  if (!state.room || !state.user) return null;
  return state.room.players.find((player) => player.uid === state.user.uid) || null;
}

function isHost() {
  return Boolean(state.room && state.user && state.room.hostId === state.user.uid);
}

function clearRoomListeners() {
  if (state.unsubRoom) {
    state.unsubRoom();
    state.unsubRoom = null;
  }

  if (state.unsubHand) {
    state.unsubHand();
    state.unsubHand = null;
  }
}

function clearRevealTimers() {
  (state.revealTimers || []).forEach(clearTimeout);
  state.revealTimers = [];
}

function clearRoomState() {
  clearRoomListeners();

  Object.values(state.cashListeners || {}).forEach((unsub) => {
    if (unsub) unsub();
  });

  state.cashListeners = {};
  state.cashMap = {};
  state.room = null;
  state.handData = null;
  state.arrangement = emptyArrangement();
  state.selectedCards.clear();
  state.roundInitialized = null;
  state.zoomOpen = false;
  state.revealActive = false;
  state.showFullResults = false;

  clearRevealTimers();

  localStorage.removeItem("currentRoomId");
  state.roomId = null;
}

function makeCardElement(card, selected = false) {
  const el = document.createElement("div");
  el.className = "card";

  if (isRedSuit(suitOf(card))) {
    el.classList.add("red");
  }

  if (selected) {
    el.classList.add("selected");
  }

  el.innerHTML = `
    <div class="rank">${rankOf(card)}</div>
    <div class="suit">${suitSymbol(suitOf(card))}</div>
  `;

  return el;
}

const SEAT_POS = ["bottom", "left", "top", "right"];

function seatOffset(playerSeat, mySeat) {
  return ((playerSeat - mySeat) % 4 + 4) % 4;
}

function showBanner(text, ms) {
  const b = $("#banner");
  if (!b) return;

  b.textContent = text;
  b.classList.remove("hidden");

  setTimeout(() => {
    b.classList.add("hidden");
  }, ms);
}

function syncCashListeners() {
  if (!state.room) return;

  const minBet = Number(state.room.settings.minBet) || 0;
  const needed = {};

  state.room.players.forEach((p) => {
    if (p.isBot) {
      state.cashMap[p.uid] = minBet * 10;
    } else {
      needed[p.username] = true;
    }
  });

  if (state.user) {
    needed[state.user.username] = true;
  }

  Object.keys(needed).forEach((username) => {
    if (!state.cashListeners[username]) {
      state.cashListeners[username] = listenUser(username, (data) => {
        state.cashMap[username] = data ? Number(data.cash) || 0 : 0;
        renderSeats();
      });
    }
  });

  Object.keys(state.cashListeners).forEach((username) => {
    if (!needed[username]) {
      state.cashListeners[username]();
      delete state.cashListeners[username];
    }
  });
}

function renderTableMyRows() {
  const wrap = document.getElementById("table-my-rows");
  if (!wrap) return;

  wrap.innerHTML = "";

  ["front", "middle", "back"].forEach((row) => {
    const line = document.createElement("div");
    line.className = "tmr-row";

    const tag = document.createElement("span");
    tag.className = "tmr-tag";
    tag.textContent = row.toUpperCase();

    const cards = document.createElement("div");
    cards.className = "tmr-cards";

    (state.arrangement[row] || []).forEach((card) => {
      const el = makeCardElement(card, false);
      el.classList.add("tmr-card");
      cards.appendChild(el);
    });

    line.appendChild(tag);
    line.appendChild(cards);
    wrap.appendChild(line);
  });
}

function flyCoinsToWinner(winnerUid) {
  if (!state.room) return;

  const layer = document.querySelector(".pg-table");
  const winner = state.room.players.find((p) => p.uid === winnerUid);

  if (!layer || !winner) return;

  const myPlayer = currentUserPlayerObject();
  const mySeat = myPlayer ? myPlayer.seat : 0;
  const pos = SEAT_POS[seatOffset(winner.seat, mySeat)];
  const target = document.querySelector("#seat-" + pos);

  if (!target) return;

  const lR = layer.getBoundingClientRect();
  const tR = target.getBoundingClientRect();

  const sx = lR.width / 2;
  const sy = lR.height / 2;

  for (let i = 0; i < 14; i++) {
    const c = document.createElement("div");
    c.className = "fly-coin";
    c.style.left = sx + "px";
    c.style.top = sy + "px";

    const tx = tR.left - lR.left + tR.width / 2 + (Math.random() * 40 - 20);
    const ty = tR.top - lR.top + tR.height / 2 + (Math.random() * 30 - 15);

    c.style.setProperty("--tx", tx - sx + "px");
    c.style.setProperty("--ty", ty - sy + "px");
    c.style.animationDelay = i * 60 + "ms";

    layer.appendChild(c);

    setTimeout(() => c.remove(), 1800 + i * 60);
  }
}

function renderAdminUserList() {
  const list = $("#admin-user-list");
  if (!list) return;

  list.innerHTML = "";

  const q = (state.adminSearch || "").trim().toLowerCase();

  const users = [...state.adminUsers]
    .filter((u) =>
      !q ||
      (u.username || "").includes(q) ||
      (u.displayName || "").toLowerCase().includes(q)
    )
    .sort((a, b) => (Number(b.cash) || 0) - (Number(a.cash) || 0));

  if (users.length === 0) {
    list.innerHTML = '<div class="admin-empty">No users found.</div>';
    return;
  }

  users.forEach((u) => {
    const row = document.createElement("div");
    row.className =
      "admin-user-row" +
      (u.username === state.adminSelectedUsername ? " selected" : "");

    const info = document.createElement("div");
    info.className = "admin-user-info-wrap";

    info.innerHTML = `
      <div class="admin-user-avatar">${(u.displayName || u.username || "?").charAt(0).toUpperCase()}</div>
      <div class="admin-user-info">
        <div class="admin-user-name">${u.displayName || u.username}
          <span class="admin-user-username">@${u.username}</span>
        </div>
        <div class="admin-user-stats">
          Cash ${formatCash(u.cash || 0)} • Games ${u.games || 0} •
          Wins ${u.wins || 0} • Pts ${u.points || 0}
        </div>
      </div>
    `;

    const btn = document.createElement("button");
    btn.className = "pg-btn";
    btn.textContent = "Edit";
    btn.addEventListener("click", () => selectAdminUser(u.username));

    row.appendChild(info);
    row.appendChild(btn);
    list.appendChild(row);
  });
}

function selectAdminUser(username) {
  state.adminSelectedUsername = username;

  const u = state.adminUsers.find((x) => x.username === username);
  const usernameField = $("#admin-player-username");

  if (usernameField) usernameField.value = username;

  if (u) {
    const infoBox = $("#admin-player-info");

    if (infoBox) {
      infoBox.innerHTML = `
        <div>Username: ${u.username}</div>
        <div>Display Name: ${u.displayName || "-"}</div>
        <div>Cash: ${u.cash || 0}</div>
        <div>Games: ${u.games || 0}</div>
        <div>Wins: ${u.wins || 0}</div>
        <div>Points: ${u.points || 0}</div>
      `;
    }

    const nameField = $("#admin-display-name");
    if (nameField) nameField.value = u.displayName || "";

    const cashField = $("#admin-cash-amount");
    if (cashField) cashField.value = u.cash || 0;
  }

  renderAdminUserList();
  setAdminMessage("Selected @" + username + " for editing.");
}

function renderRoomList() {
  const list = $("#lobby-rooms-list");
  if (!list) return;

  list.innerHTML = "";

  const countEl = $("#lobby-room-count");
  if (countEl) countEl.textContent = state.allRooms.length + " live";

  if (state.allRooms.length === 0) {
    list.innerHTML = '<div class="lobby-empty">No live tables yet. Create one!</div>';
    return;
  }

  state.allRooms.forEach((room) => {
    const st = statusInfo(room.status);
    const players = [...(room.players || [])].sort((a, b) => a.seat - b.seat);
    const playing = room.status === "arranging" || room.status === "scoring";
    const canJoin = ["lobby", "round_end"].includes(room.status) && players.length < 4;

    const seatsHtml = [0, 1, 2, 3]
      .map((seat) => {
        const p = players.find((x) => x.seat === seat);

        if (!p) return '<div class="lobby-seat empty">+</div>';

        return `<div class="lobby-seat${p.isBot ? " bot" : ""}" title="${p.displayName}">${(p.displayName || "?").charAt(0).toUpperCase()}</div>`;
      })
      .join("");

    const card = document.createElement("div");
    card.className = "lobby-room-card " + st.cls;

    card.innerHTML = `
      <div class="lobby-card-head">
        <span class="lobby-code">${room.roomCode}</span>
        <span class="lobby-status ${st.cls}">${playing ? '<span class="pulse-dot"></span>' : ""}${st.label}</span>
      </div>
      <div class="lobby-seats">${seatsHtml}</div>
      <div class="lobby-meta">
        <span>👥 ${players.length}/4</span>
        <span>🔄 Round ${room.roundNumber || 0}</span>
        <span>💰 ${formatCash(room.settings?.minBet || 0)}</span>
      </div>
      <div class="lobby-meta lobby-time">🕑 ${timeAgo(room.createdAt)}</div>
      <div class="lobby-actions">
        <button class="pg-btn" data-room-action="watch" data-code="${room.roomCode}">🎥 Watch</button>
        ${canJoin ? `<button class="pg-btn primary" data-room-action="join" data-code="${room.roomCode}">Join</button>` : ""}
      </div>
    `;

    list.appendChild(card);
  });
}

function syncRoomsListener() {
  const shouldListen = Boolean(state.user) && !state.roomId;

  if (shouldListen && !state.roomsUnsub) {
    state.roomsUnsub = listenAllRooms((rooms) => {
      state.allRooms = rooms;
      renderRoomList();
      sweepStaleRooms(rooms, state.user ? state.user.uid : null);
    });
  }

  if (!shouldListen && state.roomsUnsub) {
    state.roomsUnsub();
    state.roomsUnsub = null;
  }
}

async function enterRoom(roomId) {
  clearRoomListeners();

  state.roomId = roomId;
  localStorage.setItem("currentRoomId", roomId);

  state.unsubRoom = listenRoom(roomId, (snapshot) => {
    if (!snapshot.exists()) {
      clearRoomState();
      showScreen("menu");
      syncRoomsListener();
      return;
    }

    state.room = snapshot.data();
    renderRoom();
    hostController();
  });

  syncRoomsListener();
  showScreen("room");
}

function renderMenu() {
  if (!state.user) return;

  setText("#menu-username", state.userData?.displayName || state.user.username);
  setText("#menu-cash", state.userData?.cash ?? 0);

  const avatarEl = $("#menu-avatar");
  if (avatarEl) {
    const name = state.userData?.displayName || state.user.username || "?";
    avatarEl.textContent = name.charAt(0).toUpperCase();
  }

  const claimBtn = $("#claim-daily-button");
  if (claimBtn) {
    const today = new Date().toISOString().slice(0, 10);
    const claimed = state.userData?.lastClaimDate === today;

    claimBtn.disabled = claimed;
    claimBtn.textContent = claimed
      ? "✓ Claimed — back tomorrow"
      : "🎁 Claim Daily +10,000";
  }
}

function renderSeats() {
  ["top", "left", "right", "bottom"].forEach((p) => {
    const el = $("#seat-" + p);
    if (el) el.innerHTML = "";
  });

  if (!state.room || !state.user) return;

  const myPlayer = currentUserPlayerObject();
  const mySeat = myPlayer ? myPlayer.seat : 0;
  const minBet = Number(state.room.settings.minBet) || 0;

  state.room.players.forEach((player) => {
    const pos = SEAT_POS[seatOffset(player.seat, mySeat)];
    const el = $("#seat-" + pos);

    if (!el) return;

    const isSelf = player.uid === state.user.uid;

    let cashVal;

    if (player.isBot) {
      cashVal = state.cashMap[player.uid] ?? minBet * 10;
    } else if (isSelf) {
      cashVal = state.cashMap[player.username] ?? state.userData?.cash ?? 0;
    } else {
      cashVal = state.cashMap[player.username] ?? 0;
    }

    let status = "";

    if (["arranging", "scoring"].includes(state.room.status) && currentUserInRoomPlayers()) {
      status = player.submitted ? "✓" : "…";
    } else if (state.room.status === "round_end") {
      status = player.ready ? "✓" : "…";
    }

    el.innerHTML = `
      <div class="avatar">${(player.displayName || "?").charAt(0).toUpperCase()}</div>
      <div class="seat-name">${player.displayName}${isSelf ? " (You)" : ""}${player.isBot ? " 🤖" : ""}</div>
      <div class="coin-pill">${formatCash(cashVal)}</div>
      <div class="seat-status">${status}</div>
    `;
  });
}

function renderOpponentClusters() {
  const positions = ["top", "left", "right"];

  const show =
    state.room &&
    ["arranging", "scoring"].includes(state.room.status) &&
    currentUserInRoomPlayers();

  positions.forEach((p) => {
    const el = $("#cluster-" + p);
    if (!el) return;

    if (!show) {
      el.classList.add("hidden");
      el.innerHTML = "";
      delete el.dataset.filled;
    }
  });

  if (!show) return;

  const myPlayer = currentUserPlayerObject();
  const mySeat = myPlayer ? myPlayer.seat : 0;

  state.room.players.forEach((player) => {
    if (state.user && player.uid === state.user.uid) return;

    const pos = SEAT_POS[seatOffset(player.seat, mySeat)];
    if (pos === "bottom") return;

    const el = $("#cluster-" + pos);
    if (!el || el.dataset.filled) return;

    el.dataset.filled = "1";
    el.classList.remove("hidden");
    el.innerHTML = "";

    [3, 5, 5].forEach((n) => {
      const fan = document.createElement("div");
      fan.className = "back-fan";

      for (let i = 0; i < n; i++) {
        const b = document.createElement("div");
        b.className = "card-back";
        b.classList.add("deal-in");
        b.style.animationDelay = i * 60 + "ms";
        b.style.transform = `rotate(${((i - (n - 1) / 2) * 6).toFixed(1)}deg)`;
        fan.appendChild(b);
      }

      el.appendChild(fan);
    });
  });
}

function selectRow(row) {
  state.targetRow = row;

  document.querySelectorAll(".pg-row-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.row === row);
  });
}

function placeCardToRow(card) {
  const row = state.targetRow;
  const capacity = row === "front" ? 3 : 5;

  if (state.arrangement[row].length >= capacity) {
    setRoomMessage(row === "front" ? "Front is full (3 cards)." : "That row is full (5 cards).");
    return;
  }

  state.arrangement[row].push(card);
  renderArrangeSection();
}

function renderPlayerList() {
  const playerList = $("#player-list");
  const spectatorList = $("#spectator-list");

  if (playerList) playerList.innerHTML = "";
  if (spectatorList) spectatorList.innerHTML = "";

  if (!state.room) return;

  const players = [...state.room.players].sort((a, b) => a.seat - b.seat);

  players.forEach((player) => {
    const div = document.createElement("div");
    div.className = "player-row";

    if (state.room.status === "round_end") {
      div.classList.add(player.ready ? "ready" : "not-ready");
    }

    const hostText = player.uid === state.room.hostId ? " [Host]" : "";
    const botText = player.isBot ? " [Bot]" : "";

    const readyText =
      state.room.status === "round_end"
        ? player.ready
          ? " Ready"
          : " Not Ready"
        : "";

    const submittedText =
      state.room.status === "arranging"
        ? player.submitted
          ? " Submitted"
          : " Arranging"
        : "";

    div.textContent =
      `Seat ${player.seat + 1}: ` +
      player.displayName +
      hostText +
      botText +
      readyText +
      submittedText;

    if (playerList) playerList.appendChild(div);
  });

  state.room.spectators.forEach((spectator) => {
    const div = document.createElement("div");
    div.className = "player-row";
    div.textContent = spectator.displayName;

    if (spectatorList) spectatorList.appendChild(div);
  });
}

function renderRoomInfo() {
  if (!state.room) return;

  setText("#room-code", state.room.roomCode);
  setText("#room-status", state.room.status);
  setText("#room-round", state.room.roundNumber || 0);
  setText("#room-min-bet", state.room.settings.minBet);
  setText("#room-pot", state.room.pot || 0);
  setText("#room-bot-level", state.room.settings.botLevel);

  const timerElement = $("#room-timer");

  if (timerElement) {
    if (state.room.phaseEndsAt) {
      const secondsLeft = Math.max(
        0,
        Math.ceil((state.room.phaseEndsAt - Date.now()) / 1000)
      );

      timerElement.textContent = `${secondsLeft}s`;
    } else {
      timerElement.textContent = "Off";
    }
  }

  setText("#pg-round", "Round " + (state.room.roundNumber || 0));
  setText("#pg-pot", "1 pt = " + (state.room.settings.minBet || 0));
  setText("#hud-cash", state.userData?.cash ?? 0);
}

function renderLobbySection() {
  const lobbySection = $("#lobby-section");
  const arrangeSection = $("#arrange-section");
  const resultsSection = $("#results-section");

  if (lobbySection) lobbySection.classList.add("hidden");
  if (arrangeSection) arrangeSection.classList.add("hidden");
  if (resultsSection) resultsSection.classList.add("hidden");

  if (!state.room) return;

  const status = state.room.status;

  if (status === "lobby") {
    if (lobbySection) lobbySection.classList.remove("hidden");
  }

  if (status === "arranging" || status === "scoring") {
    if (currentUserInRoomPlayers()) {
      if (arrangeSection) arrangeSection.classList.remove("hidden");
      renderArrangeSection();
    } else {
      if (lobbySection) lobbySection.classList.remove("hidden");
      setRoomMessage("Round in progress. You are spectating.");
    }
  }

  if (status === "round_end" && state.showFullResults) {
    if (resultsSection) resultsSection.classList.remove("hidden");
    renderResultsSection();
  }

  const startButton = $("#start-room-button");
  const fillBotsButton = $("#fill-bots-button");
  const takeSeatButton = $("#take-seat-button");

  if (startButton) {
    startButton.classList.toggle(
      "hidden",
      !isHost() || !["lobby", "round_end"].includes(status)
    );
  }

  if (fillBotsButton) {
    fillBotsButton.classList.toggle(
      "hidden",
      !isHost() || !["lobby", "round_end"].includes(status)
    );
  }

  const canTakeSeat =
    currentUserInRoomSpectators() &&
    ["lobby", "round_end"].includes(status);

  if (takeSeatButton) {
    takeSeatButton.classList.toggle("hidden", !canTakeSeat);
  }

  renderPlayerList();
}

function rowLabelInfo(row) {
  const arr = state.arrangement;

  if (row === "front") {
    const ev = evaluate3(arr.front);

    return {
      name: ev.name,
      ok: arr.front.length === 3
    };
  }

  if (row === "middle") {
    const ev = evaluate5(arr.middle);

    let ok = arr.middle.length === 5;

    if (ok) {
      const f = evaluate3(arr.front);
      const req = f.category === 3 ? 3 : f.category === 2 ? 2 : 1;
      ok = ev.category >= req;
    }

    return {
      name: ev.name,
      ok
    };
  }

  const ev = evaluate5(arr.back);
  let ok = arr.back.length === 5;

  if (ok && arr.middle.length === 5) {
    ok = compare5(ev, evaluate5(arr.middle)) >= 0;
  }

  return {
    name: ev.name,
    ok
  };
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

  const a = state.arrangement[from.row][from.index];
  const b = state.arrangement[row][index];

  state.arrangement[from.row][from.index] = b;
  state.arrangement[row][index] = a;

  state.selectedCard = null;
  state.selectedPos = null;

  renderMyRows();
}

function autoPlaceFromHand() {
  if (!state.handData || !state.handData.hand || state.handData.hand.length !== 13) {
    return false;
  }

  const h = state.handData.hand;

  state.arrangement = {
    front: h.slice(0, 3),
    middle: h.slice(3, 8),
    back: h.slice(8, 13)
  };

  state.selectedCard = null;
  state.selectedPos = null;

  return true;
}

function renderMyRows() {
  ["front", "middle", "back"].forEach((row) => {
    const container = $("#row-" + row);
    if (!container) return;

    container.innerHTML = "";

    const cards = state.arrangement[row];
    const mid = (cards.length - 1) / 2;

    cards.forEach((card, index) => {
      const el = makeCardElement(card, state.selectedCard === card);

      if (state.room && state.dealAnimPlayedFor !== state.room.roundNumber) {
        el.classList.add("deal-in");
        el.style.animationDelay = index * 70 + "ms";
      }

      el.style.setProperty("--rot", `${((index - mid) * 4).toFixed(1)}deg`);
      el.addEventListener("click", () => onMyCardTap(row, index));

      container.appendChild(el);
    });

    const label = $("#label-" + row);

    if (label) {
      const info = rowLabelInfo(row);

      label.classList.toggle("ok", info.ok);
      label.classList.toggle("bad", !info.ok);

      label.innerHTML =
        `<span class="check">${info.ok ? "✓" : "✗"}</span>` +
        `<span class="hand-name">${info.name}</span>`;
    }
  });

  if (state.room) {
    state.dealAnimPlayedFor = state.room.roundNumber;
  }
}

function rowScoreFor(results, uid, rowKey) {
  const list = results.details[uid] || [];

  return list.reduce((sum, d) => {
    return sum + ((d.rows && d.rows[rowKey]) || 0);
  }, 0);
}

function rowNameFor(arrangement, row) {
  if (!arrangement) return "-";

  if (row === "front") {
    return evaluate3(arrangement.front).name;
  }

  return evaluate5(arrangement[row]).name;
}

function renderRevealSlot(pos, player, arrangement, row, rowScore, cumulative) {
  const slot = document.getElementById("reveal-" + pos);
  if (!slot) return;

  slot.innerHTML = "";

  const banner = document.createElement("div");
  banner.className = "reveal-banner";

  banner.innerHTML =
    `<span class="rb-name">${rowNameFor(arrangement, row)}</span>` +
    `<span class="rb-pts ${rowScore >= 0 ? "pos" : "neg"}">` +
    `${rowScore >= 0 ? "+" : ""}${rowScore}</span>`;

  const cards = document.createElement("div");
  cards.className = "reveal-cards";

  ((arrangement && arrangement[row]) || []).forEach((card, index) => {
    const el = makeCardElement(card, false);
    el.classList.add("reveal-card");
    el.style.animationDelay = index * 80 + "ms";
    cards.appendChild(el);
  });

  const total = document.createElement("div");
  total.className = "reveal-total";

  total.innerHTML = `Total <b>${cumulative >= 0 ? "+" : ""}${cumulative}</b>`;

  slot.appendChild(banner);
  slot.appendChild(cards);
  slot.appendChild(total);
}

function updateScorePanel(results, myUid, revealedRows) {
  let total = 0;

  [
    ["front", "sp-front"],
    ["middle", "sp-mid"],
    ["back", "sp-back"]
  ].forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el) return;

    if (revealedRows.includes(key)) {
      const v = rowScoreFor(results, myUid, key);
      total += v;
      el.textContent = (v >= 0 ? "+" : "") + v;
    } else {
      el.textContent = "";
    }
  });

  const tEl = document.getElementById("sp-total");

  if (tEl) {
    tEl.textContent = revealedRows.length
      ? (total >= 0 ? "+" : "") + total
      : "";
  }
}

function finalizeReveal() {
  state.revealActive = false;
  state.revealPlayedFor = state.room ? state.room.roundNumber : null;

  const skip = document.getElementById("reveal-skip");
  if (skip) skip.classList.add("hidden");

  const readyArea = document.getElementById("ready-area");
  if (readyArea) readyArea.classList.remove("hidden");

  renderReadyArea();
}

function skipReveal() {
  if (!state.room || !state.room.results) return;

  clearRevealTimers();

  const results = state.room.results;
  const myPlayer = currentUserPlayerObject();
  const mySeat = myPlayer ? myPlayer.seat : 0;

  // 🚨 SPECIAL HAND ANNOUNCEMENT - SKIP REVEAL 🚨
  const specialPlayers = [];

  state.room.players.forEach((pl) => {
    const spec = results.specials ? results.specials[pl.uid] : null;
    if (spec) {
      specialPlayers.push(`${pl.displayName} — ${spec.name}`);
    }
  });

  if (specialPlayers.length > 0) {
    showBanner("✨ SPECIAL HAND! ✨", 3000);
    setRoomMessage("✨ " + specialPlayers.join(" | "));
  }

  state.room.players.forEach((pl) => {
    const full = ["front", "middle", "back"].reduce((s, k) => {
      return s + rowScoreFor(results, pl.uid, k);
    }, 0);

    const pos = SEAT_POS[seatOffset(pl.seat, mySeat)];
    const arr = results.arrangements ? results.arrangements[pl.uid] : null;

    renderRevealSlot(
      pos,
      pl,
      arr,
      "back",
      rowScoreFor(results, pl.uid, "back"),
      full
    );
  });

  updateScorePanel(results, state.user.uid, ["front", "middle", "back"]);
  finalizeReveal();
}

function playRevealSequence(results) {
  clearRevealTimers();

  state.revealActive = true;

  const layer = document.getElementById("reveal-layer");
  if (!layer) return;

  layer.classList.remove("hidden");

  const skip = document.getElementById("reveal-skip");
  if (skip) skip.classList.remove("hidden");

  const resultsSection = document.getElementById("results-section");
  if (resultsSection) resultsSection.classList.add("hidden");

  const readyArea = document.getElementById("ready-area");
  if (readyArea) readyArea.classList.add("hidden");

  ["top", "left", "right", "bottom"].forEach((p) => {
    const el = document.getElementById("reveal-" + p);
    if (el) el.innerHTML = "";
  });

  updateScorePanel(results, state.user.uid, []);

  // 🚨 SPECIAL HAND ANNOUNCEMENT - NORMAL REVEAL 🚨
  const specialPlayers = [];

  state.room.players.forEach((pl) => {
    const spec = results.specials ? results.specials[pl.uid] : null;
    if (spec) {
      specialPlayers.push(`${pl.displayName} — ${spec.name}`);
    }
  });

  if (specialPlayers.length > 0) {
    showBanner("✨ SPECIAL HAND! ✨", 3000);
    setRoomMessage("✨ " + specialPlayers.join(" | "));
  }

  const myPlayer = currentUserPlayerObject();
  const mySeat = myPlayer ? myPlayer.seat : 0;

  const seats = state.room.players.map((pl) => ({
    pl,
    pos: SEAT_POS[seatOffset(pl.seat, mySeat)]
  }));

  const rows = ["front", "middle", "back"];
  const cum = {};

  seats.forEach((s) => {
    cum[s.pl.uid] = 0;
  });

  let t = 500;

  rows.forEach((row, ri) => {
    state.revealTimers.push(
      setTimeout(() => {
        seats.forEach((s, si) => {
          state.revealTimers.push(
            setTimeout(() => {
              const arr = results.arrangements
                ? results.arrangements[s.pl.uid]
                : null;

              const rs = rowScoreFor(results, s.pl.uid, row);

              cum[s.pl.uid] += rs;

              renderRevealSlot(s.pos, s.pl, arr, row, rs, cum[s.pl.uid]);

              if (s.pl.uid === state.user.uid) {
                updateScorePanel(results, state.user.uid, rows.slice(0, ri + 1));
              }
            }, si * 250)
          );
        });
      }, t)
    );

    t += 2100;
  });

  state.revealTimers.push(
    setTimeout(() => {
      finalizeReveal();
    }, t + 400)
  );
}

function disableArrangeControls(disabled) {
  [
    "#assign-front-button",
    "#assign-middle-button",
    "#assign-back-button",
    "#auto-arrange-button",
    "#clear-arrangement-button",
    "#submit-arrangement-button"
  ].forEach((selector) => {
    const el = $(selector);
    if (el) el.disabled = disabled;
  });
}

function renderAssignedSection(sectionName, container) {
  if (!container) return;

  container.innerHTML = "";

  const cards = sortCards(state.arrangement[sectionName]);

  cards.forEach((card) => {
    const cardElement = makeCardElement(card, false);

    cardElement.addEventListener("click", () => {
      state.arrangement[sectionName] = state.arrangement[sectionName].filter(
        (c) => c !== card
      );

      state.selectedCards.clear();
      renderArrangeSection();
    });

    container.appendChild(cardElement);
  });
}

function renderAssignedCards() {
  renderAssignedSection("front", $("#front-cards"));
  renderAssignedSection("middle", $("#middle-cards"));
  renderAssignedSection("back", $("#back-cards"));
}

function renderHandCards() {
  const container = $("#hand-cards");
  if (!container) return;

  container.innerHTML = "";

  if (!state.handData || !state.handData.hand) return;

  const assigned = assignedCardsSet();

  const cards = sortCards(
    state.handData.hand.filter((card) => !assigned.has(card))
  );

  const total = cards.length;
  const middleIndex = (total - 1) / 2;
  const angleStep = total > 1 ? Math.min(6, 68 / total) : 0;

  cards.forEach((card, index) => {
    const cardElement = makeCardElement(card, false);

    const offset = index - middleIndex;
    const angle = offset * angleStep;
    const arc = Math.abs(offset) * Math.abs(offset) * 0.7;

    cardElement.classList.add("hand-card");
    cardElement.style.setProperty("--rot", `${angle.toFixed(2)}deg`);
    cardElement.style.setProperty("--arc", `${arc.toFixed(2)}px`);
    cardElement.style.setProperty("--z", String(10 + index));

    cardElement.addEventListener("click", () => {
      placeCardToRow(card);
    });

    container.appendChild(cardElement);
  });
}

function renderArrangeSection() {
  const autoBtn = $("#auto-arrange-button");
  if (autoBtn && state.room) {
    autoBtn.classList.toggle("hidden", !state.room.settings.autoArrange);
  }

  const zoom = document.getElementById("zoom-view");
  const tableSec = document.getElementById("arrange-section");

  if (!zoom || !tableSec) return;

  const st = $("#arrange-status");

  if (!state.handData) {
    if (st) st.textContent = "Waiting for cards...";
    zoom.classList.add("hidden");
    tableSec.classList.remove("hidden");
    return;
  }

  if (state.handData.submitted) {
    zoom.classList.add("hidden");
    tableSec.classList.remove("hidden");

    if (st) st.textContent = "Submitted. Waiting for other players...";

    disableArrangeControls(true);
    renderTableMyRows();
    return;
  }

  if (state.room.settings.autoArrange) {
    zoom.classList.add("hidden");
    tableSec.classList.remove("hidden");

    if (st) st.textContent = "Auto-arranging your cards...";

    disableArrangeControls(true);
    renderTableMyRows();

    setTimeout(async () => {
      const arrangement = botArrangeHand(state.handData.hand, "hard");

      try {
        await submitArrangement(state.roomId, state.user.uid, arrangement);
        setRoomMessage("Cards auto-arranged and submitted!");
      } catch (error) {
        console.error(error);
        setRoomMessage("Auto-arrange failed.");
      }
    }, 600);

    return;
  }

  if (state.zoomOpen) {
    tableSec.classList.add("hidden");
    zoom.classList.remove("hidden");

    const total =
      state.arrangement.front.length +
      state.arrangement.middle.length +
      state.arrangement.back.length;

    if (total === 0) {
      autoPlaceFromHand();
    }

    renderMyRows();
  } else {
    zoom.classList.add("hidden");
    tableSec.classList.remove("hidden");

    if (st) st.textContent = "Cards arranged. Submit or re-arrange.";

    disableArrangeControls(false);
    renderTableMyRows();
  }
}

async function submitHumanArrangement() {
  const arrangement = state.arrangement;

  if (
    arrangement.front.length !== 3 ||
    arrangement.middle.length !== 5 ||
    arrangement.back.length !== 5
  ) {
    setRoomMessage("You need Front 3, Middle 5, Back 5.");
    return;
  }

  const isFouled = !isLegalArrangement(arrangement);

  if (isFouled) {
    setRoomMessage("FOUL! Your arrangement is illegal. You will auto-lose this round.");
  }

  try {
    await submitArrangement(state.roomId, state.user.uid, arrangement, isFouled);
    setRoomMessage(isFouled ? "Fouled arrangement submitted." : "Submitted.");
  } catch (error) {
    console.error(error);
    setRoomMessage("Submit failed.");
  }
}

async function autoSubmitIfNeeded() {
  if (state.autoSubmitting) return;
  if (!state.room || !state.user || !state.handData) return;
  if (state.room.status !== "arranging") return;
  if (!currentUserInRoomPlayers()) return;
  if (state.handData.submitted) return;
  if (!state.room.phaseEndsAt) return;
  if (Date.now() < state.room.phaseEndsAt) return;
  if (Date.now() < (state.autoSubmitFailUntil || 0)) return;

  state.autoSubmitting = true;

  try {
    const arrangement = state.arrangement;

    const countsOk =
      arrangement.front.length === 3 &&
      arrangement.middle.length === 5 &&
      arrangement.back.length === 5;

    if (countsOk) {
      const fouled = !isLegalArrangement(arrangement);
      await submitArrangement(state.roomId, state.user.uid, arrangement, fouled);
    } else {
      const fixed = botArrangeHand(state.handData.hand, "normal");
      await submitArrangement(state.roomId, state.user.uid, fixed, false);
    }
  } catch (error) {
    console.error(error);
    state.autoSubmitFailUntil = Date.now() + 5000;
  } finally {
    state.autoSubmitting = false;
  }
}

function createCombinationBlock(label, cards) {
  const row = document.createElement("div");
  row.className = "result-hand-row";

  const labelEl = document.createElement("div");
  labelEl.className = "result-hand-label";
  labelEl.textContent = label;

  const cardsEl = document.createElement("div");
  cardsEl.className = "result-card-row";

  if (!cards || cards.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "-";
    cardsEl.appendChild(empty);
  } else {
    sortCards(cards).forEach((card) => {
      const cardEl = makeCardElement(card, false);
      cardEl.classList.add("result-card");
      cardsEl.appendChild(cardEl);
    });
  }

  row.appendChild(labelEl);
  row.appendChild(cardsEl);

  return row;
}

function renderResultBoards(results) {
  const boards = $("#result-boards");
  if (!boards) return;

  boards.innerHTML = "";

  results.rankings.forEach((ranking, index) => {
    const board = document.createElement("div");
    board.className = "pg-board" + (index === 0 ? " winner" : "");

    const head = document.createElement("div");
    head.className = "pg-board-head";

    let headText = `${index + 1}. ${ranking.displayName}`;

    headText += `${ranking.isBot ? " (Bot)" : ""} — ${ranking.scorePoints} pts`;

    if (ranking.scoops > 0) {
      headText += ` • 🏠 ${ranking.scoops} Scoop${ranking.scoops > 1 ? "s" : ""}`;
    }

    if (ranking.royalties > 0) {
      headText += ` • 💎 +${ranking.royalties} Royalty`;
    }

    if (ranking.fouled) {
      headText += " • FOUL";
    }

    if (ranking.special) {
      headText += ` • ✨ ${ranking.special.name}`;
    }

    head.textContent = headText;
    board.appendChild(head);

    const arrangement = results.arrangements ? results.arrangements[ranking.uid] : null;

    if (arrangement) {
      board.appendChild(createCombinationBlock("Front", arrangement.front));
      board.appendChild(createCombinationBlock("Middle", arrangement.middle));
      board.appendChild(createCombinationBlock("Back", arrangement.back));
    }

    if (!ranking.isBot) {
      const net = document.createElement("div");
      net.className = "pg-board-net";
      net.textContent = `Net ${ranking.netCoins >= 0 ? "+" : ""}${ranking.netCoins} coins`;
      board.appendChild(net);
    }

    boards.appendChild(board);
  });
}

function renderResultsSection() {
  const results = state.room.results;

  const resultSummary = $("#result-summary");
  const resultTable = $("#result-table");
  const resultDetails = $("#result-details");

  if (!results) {
    if (resultSummary) resultSummary.textContent = "Waiting for results...";
    if (resultTable) resultTable.innerHTML = "";
    if (resultDetails) resultDetails.innerHTML = "";
    return;
  }

  if (resultSummary) {
    resultSummary.textContent =
      `Round ${results.roundNumber} | 1 pt = ${results.minBet} | Winner = most points`;
  }

  if (resultTable) {
    resultTable.innerHTML = "";

    const header = resultTable.insertRow();

    ["Rank", "Player", "Type", "Wins", "Bet", "Prize", "Net"].forEach((text) => {
      const th = document.createElement("th");
      th.textContent = text;
      header.appendChild(th);
    });

    results.rankings.forEach((ranking, index) => {
      const row = resultTable.insertRow();

      row.insertCell().textContent = index + 1;
      row.insertCell().textContent = ranking.displayName;
      row.insertCell().textContent = ranking.isBot ? "Bot" : "Human";
      row.insertCell().textContent = ranking.points;
      row.insertCell().textContent = ranking.isBot ? "-" : ranking.bet;
      row.insertCell().textContent = ranking.isBot ? "-" : ranking.prize;
      row.insertCell().textContent = ranking.isBot ? "-" : ranking.net;
    });
  }

  if (resultDetails) {
    resultDetails.innerHTML = "";

    results.rankings.forEach((ranking, index) => {
      const wrapper = document.createElement("details");
      wrapper.className = "details-block result-cards-block";
      wrapper.open = false;

      const summary = document.createElement("summary");

      const youText =
        state.user && ranking.uid === state.user.uid
          ? " (You)"
          : "";

      summary.textContent =
        `${index + 1}. ${ranking.displayName}${youText} — ` +
        `${ranking.points} wins`;

      wrapper.appendChild(summary);

      const details = results.details[ranking.uid] || [];

      details.forEach((detail) => {
        const row = document.createElement("div");

        const icon = (value) => {
          if (value > 0) return "W";
          if (value < 0) return "L";
          return "T";
        };

        const colorClass = (value) => {
          if (value > 0) return "win";
          if (value < 0) return "loss";
          return "tie";
        };

        let matchText = "Tied";

        if (detail.matchResult === "win") matchText = "Won";
        if (detail.matchResult === "lose") matchText = "Lost";

        row.innerHTML = `
          vs ${detail.opponentName}:
          Front <span class="${colorClass(detail.rows.front)}">${icon(detail.rows.front)}</span>
          Middle <span class="${colorClass(detail.rows.middle)}">${icon(detail.rows.middle)}</span>
          Back <span class="${colorClass(detail.rows.back)}">${icon(detail.rows.back)}</span>
          — ${matchText}
        `;

        wrapper.appendChild(row);
      });

      resultDetails.appendChild(wrapper);
    });
  }

  renderResultBoards(results);
  renderReadyArea();
}

function renderReadyArea() {
  const readyList = $("#ready-list");
  const readyButton = $("#ready-button");
  const forceStartButton = $("#force-start-button");

  if (readyList) readyList.innerHTML = "";

  if (!state.room || state.room.status !== "round_end") return;

  const results = state.room.results;
  const players = [...state.room.players].sort((a, b) => a.seat - b.seat);

  const title = document.createElement("h4");
  title.textContent = "Round Results & Next Round Status";
  title.style.margin = "0 0 10px 0";

  if (readyList) readyList.appendChild(title);

  const rankMap = {};

  if (results && results.rankings) {
    results.rankings.forEach((r, idx) => {
      rankMap[r.uid] = {
        rank: idx + 1,
        points: r.scorePoints,
        net: r.netCoins,
        prize: r.prize,
        fouled: r.fouled,
        scoops: r.scoops || 0,
        royalties: r.royalties || 0,
        special: r.special || null,
        isWinner: idx === 0
      };
    });
  }

  players.forEach((player) => {
    const div = document.createElement("div");

    const rankInfo = rankMap[player.uid];
    const isWinner = rankInfo && rankInfo.isWinner;
    const isFouled = rankInfo && rankInfo.fouled;

    div.className =
      `player-row ready-status-row ${player.ready ? "ready" : "not-ready"} ` +
      `${isWinner ? "winner" : ""} ${isFouled ? "fouled" : ""}`;

    const readyIcon = player.ready ? "✅" : "❌";
    const statusText = player.ready ? "Ready" : "Waiting...";
    const youText = state.user && player.uid === state.user.uid ? " (You)" : "";

    let rankBadge = "";

    if (rankInfo) {
      if (isWinner) {
        rankBadge = `<span class="winner-badge">🏆 WINNER</span>`;
      } else if (isFouled) {
        rankBadge = `<span class="foul-badge">FOUL</span>`;
      } else {
        const ordinal =
          rankInfo.rank === 1
            ? "st"
            : rankInfo.rank === 2
              ? "nd"
              : rankInfo.rank === 3
                ? "rd"
                : "th";

        rankBadge = `<span class="rank-badge">${rankInfo.rank}${ordinal} • ${rankInfo.points} pts</span>`;
      }

      if (rankInfo.special) {
        rankBadge += `<span class="royalty-badge">✨ ${rankInfo.special.name}</span>`;
      }

      if (rankInfo.scoops > 0) {
        rankBadge += `<span class="scoop-badge">🏠 ${rankInfo.scoops}</span>`;
      }

      if (rankInfo.royalties > 0) {
        rankBadge += `<span class="royalty-badge">💎 +${rankInfo.royalties}</span>`;
      }

      if (!player.isBot) {
        const netStr = rankInfo.net >= 0 ? `+${rankInfo.net}` : `${rankInfo.net}`;
        rankBadge += `<span class="net-badge">${netStr}</span>`;
      }
    }

    div.innerHTML = `
      <span class="ready-icon">${readyIcon}</span>
      <span class="player-name">${player.displayName}${youText}</span>
      <div class="player-badges">${rankBadge}</div>
      <span class="ready-text">${statusText}</span>
    `;

    if (readyList) readyList.appendChild(div);
  });

  const me = currentUserPlayerObject();

  const showReadyButton =
    me &&
    !me.isBot &&
    !me.ready &&
    state.userData &&
    Number(state.userData.cash) >= Number(state.room.settings.minBet);

  if (readyButton) {
    readyButton.classList.toggle("hidden", !showReadyButton);
  }

  const showForceStart = isHost();

  if (forceStartButton) {
    forceStartButton.classList.toggle("hidden", !showForceStart);
  }
}

function renderRoom() {
  if (!state.room) return;

  if (state.room.roundNumber !== state.roundInitialized) {
    state.arrangement = emptyArrangement();
    state.selectedCards.clear();
    state.selectedCard = null;
    state.selectedPos = null;
    state.roundInitialized = state.room.roundNumber;
    state.revealPlayedFor = null;
    state.dealAnimPlayedFor = null;
    state.showFullResults = false;
  }

  if (state.lastStatus && state.lastStatus !== state.room.status) {
    if (state.lastStatus === "arranging" && state.room.status === "scoring") {
      showBanner("Start Comparing", 1600);
    }

    if (
      state.room.status === "arranging" &&
      ["lobby", "round_end"].includes(state.lastStatus)
    ) {
      showBanner("Start", 1200);
    }

    if (state.room.status !== "round_end") {
      clearRevealTimers();

      state.revealActive = false;

      const layer = document.getElementById("reveal-layer");
      if (layer) layer.classList.add("hidden");

      const readyArea = document.getElementById("ready-area");
      if (readyArea) readyArea.classList.add("hidden");
    }
  }

  state.lastStatus = state.room.status;

  const tableEl = document.querySelector(".pg-table");

  if (tableEl) {
    tableEl.classList.toggle(
      "arranging",
      ["arranging", "scoring"].includes(state.room.status) && currentUserInRoomPlayers()
    );
  }

  renderRoomInfo();
  renderSeats();
  syncCashListeners();
  renderOpponentClusters();
  renderLobbySection();
  manageHandListener();

  if (state.room.status === "round_end") {
    if (
      state.room.results &&
      state.revealPlayedFor !== state.room.roundNumber &&
      !state.revealActive
    ) {
      playRevealSequence(state.room.results);
    } else {
      renderReadyArea();

      const readyArea = document.getElementById("ready-area");

      if (readyArea && state.revealPlayedFor === state.room.roundNumber) {
        readyArea.classList.remove("hidden");
      }
    }
  }
}

function manageHandListener() {
  const shouldListen =
    state.room &&
    state.user &&
    state.room.status === "arranging" &&
    currentUserInRoomPlayers();

  if (shouldListen && !state.unsubHand) {
    state.unsubHand = listenOwnHand(state.roomId, state.user.uid, (snapshot) => {
      state.handData = snapshot.exists() ? snapshot.data() : null;

      if (
        state.handData &&
        !state.handData.submitted &&
        state.handData.hand &&
        state.handData.hand.length === 13
      ) {
        const total =
          state.arrangement.front.length +
          state.arrangement.middle.length +
          state.arrangement.back.length;

        if (total === 0) {
          autoPlaceFromHand();
        }

        if (!state.room.settings.autoArrange) {
          state.zoomOpen = true;
        }
      }

      if (state.room && state.room.status === "arranging") {
        renderArrangeSection();
      }
    });
  }

  if (!shouldListen && state.unsubHand) {
    state.unsubHand();
    state.unsubHand = null;
    state.handData = null;
  }
}

async function hostController() {
  if (!state.room || !state.user) return;
  if (state.room.hostId !== state.user.uid) return;
  if (state.hostBusy) return;

  const now = Date.now();

  if (now < (state.hostCooldownUntil || 0)) return;

  const room = state.room;
  const humans = room.players.filter((p) => !p.isBot);

  const fail = () => {
    state.hostFailCount = (state.hostFailCount || 0) + 1;

    if (state.hostFailCount >= 3) {
      state.hostCooldownUntil = Date.now() + 10000;
      state.hostFailCount = 0;
      console.warn("hostController backing off 10s");
    }
  };

  const succeed = () => {
    state.hostFailCount = 0;
  };

  if (room.status === "scoring") {
    const stuckFor = Date.now() - (room.updatedAt || 0);

    if (stuckFor > 20000) {
      console.warn("Scoring stuck for 20s, retrying finishRound");

      state.hostBusy = true;

      try {
        await finishRound(room.roomCode, state.user);
        succeed();
      } catch (error) {
        console.error(error);
        fail();
      } finally {
        state.hostBusy = false;
      }
    }

    return;
  }

  if (room.status === "arranging") {
    const allSubmitted = room.players.every((p) => p.submitted);

    const timerExpired = room.phaseEndsAt && Date.now() > room.phaseEndsAt;
    const gracePeriod = timerExpired && Date.now() - room.phaseEndsAt > 10000;

    if (allSubmitted || gracePeriod) {
      state.hostBusy = true;

      try {
        await finishRound(room.roomCode, state.user);
        succeed();
      } catch (error) {
        console.error(error);
        fail();
      } finally {
        state.hostBusy = false;
      }
    }

    return;
  }

  if (room.status === "round_end") {
    if (humans.length === 0) return;

    const readyHumans = humans.filter((p) => p.ready);

    if (readyHumans.length === humans.length) {
      state.hostBusy = true;

      try {
        await sleep(800);
        await startRound(room.roomCode, state.user);
        succeed();
      } catch (error) {
        console.error(error);
        setRoomMessage(error.message || "Failed to start next round.");
        fail();
      } finally {
        state.hostBusy = false;
      }

      return;
    }

    if (room.phaseEndsAt && Date.now() > room.phaseEndsAt && readyHumans.length > 0) {
      state.hostBusy = true;

      try {
        await replaceUnreadyWithBots(room.roomCode);
        await startRound(room.roomCode, state.user);
        succeed();
      } catch (error) {
        console.error(error);
        fail();
      } finally {
        state.hostBusy = false;
      }
    }
  }
}

async function loadAdminRoomSettings() {
  if (!state.room) {
    setAdminMessage("You are not in a room.");
    return;
  }

  const minBet = $("#admin-room-min-bet");
  const botLevel = $("#admin-room-bot-level");
  const arrangeTimer = $("#admin-room-arrange-timer");
  const readyTimer = $("#admin-room-ready-timer");
  const autoFill = $("#admin-room-auto-fill-bots");
  const scoopBonus = $("#admin-room-scoop-bonus");

  if (minBet) minBet.value = state.room.settings.minBet;
  if (botLevel) botLevel.value = state.room.settings.botLevel;
  if (arrangeTimer) arrangeTimer.value = state.room.settings.arrangeTimerSeconds;
  if (readyTimer) readyTimer.value = state.room.settings.readyTimerSeconds;
  if (autoFill) autoFill.checked = Boolean(state.room.settings.autoFillBots);
  if (scoopBonus) scoopBonus.checked = Boolean(state.room.settings.scoopBonus);
}

function showAdminScreen() {
  if (!state.adminLoggedIn) {
    const password = prompt("Enter admin password:");

    if (password !== ADMIN_PASSWORD) {
      alert("Wrong admin password.");
      return;
    }

    state.adminLoggedIn = true;
    sessionStorage.setItem("adminLoggedIn", "true");
  }

  loadAdminRoomSettings();

  if (!state.adminUnsub) {
    state.adminUnsub = listenAllUsers((users) => {
      state.adminUsers = users;
      renderAdminUserList();

      if (state.adminSelectedUsername) {
        const u = users.find((x) => x.username === state.adminSelectedUsername);

        if (u) {
          const infoBox = $("#admin-player-info");

          if (infoBox) {
            infoBox.innerHTML = `
              <div>Username: ${u.username}</div>
              <div>Display Name: ${u.displayName || "-"}</div>
              <div>Cash: ${u.cash || 0}</div>
              <div>Games: ${u.games || 0}</div>
              <div>Wins: ${u.wins || 0}</div>
              <div>Points: ${u.points || 0}</div>
            `;
          }
        }
      }
    });
  }

  showScreen("admin");
}

watchAuth((user) => {
  state.user = user;

  if (state.unsubUser) {
    state.unsubUser();
    state.unsubUser = null;
  }

  if (state.unsubTransactions) {
    state.unsubTransactions();
    state.unsubTransactions = null;
    state.transactions = [];
  }

  if (!user) {
    clearRoomState();
    showScreen("login");
    return;
  }

  state.unsubUser = listenUser(user.username, (userData) => {
    state.userData = userData;
    renderMenu();
    renderReadyArea();
  });

  renderMenu();
  syncRoomsListener();

  if (state.roomId) {
    enterRoom(state.roomId);
  } else {
    showScreen("menu");
  }
});

setInterval(() => {
  if (!state.room) return;

  renderRoomInfo();

  const timerEl = $("#pg-timer");
  const zoomTimerEl = $("#zoom-timer");

  const arranging = state.room.status === "arranging";

  const readyPhase =
    state.room.status === "round_end" &&
    state.revealPlayedFor === state.room.roundNumber;

  const showTableTimer = (arranging || readyPhase) && state.room.phaseEndsAt;

  const showZoomTimer =
    arranging &&
    state.room.phaseEndsAt &&
    state.zoomOpen;

  if (timerEl) {
    timerEl.classList.toggle("hidden", !showTableTimer);

    if (showTableTimer) {
      const seconds = Math.max(
        0,
        Math.ceil((state.room.phaseEndsAt - Date.now()) / 1000)
      );

      timerEl.textContent = seconds;
    } else {
      timerEl.textContent = "--";
    }
  }

  if (zoomTimerEl) {
    zoomTimerEl.classList.toggle("hidden", !showZoomTimer);

    if (showZoomTimer) {
      const seconds = Math.max(
        0,
        Math.ceil((state.room.phaseEndsAt - Date.now()) / 1000)
      );

      zoomTimerEl.textContent = seconds;
    }
  }

  autoSubmitIfNeeded();
  hostController();
}, 700);

const loginButton = $("#login-button");

if (loginButton) {
  loginButton.addEventListener("click", async () => {
    const username = $("#login-username").value;
    const pin = $("#login-pin").value;

    setText("#login-error", "");

    try {
      await loginOrRegister(username, pin);
    } catch (error) {
      setText("#login-error", error.message || "Login failed.");
    }
  });
}

const logoutButton = $("#logout-button");

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    clearRoomState();
    await logoutUser();
  });
}

const showCreateRoomButton = $("#show-create-room-button");

if (showCreateRoomButton) {
  showCreateRoomButton.addEventListener("click", () => {
    $("#create-room-form").classList.remove("hidden");
    $("#join-room-form").classList.add("hidden");
  });
}

const cancelCreateRoomButton = $("#cancel-create-room-button");

if (cancelCreateRoomButton) {
  cancelCreateRoomButton.addEventListener("click", () => {
    $("#create-room-form").classList.add("hidden");
  });
}

const showJoinRoomButton = $("#show-join-room-button");

if (showJoinRoomButton) {
  showJoinRoomButton.addEventListener("click", () => {
    $("#join-room-form").classList.remove("hidden");
    $("#create-room-form").classList.add("hidden");
  });
}

const cancelJoinRoomButton = $("#cancel-join-room-button");

if (cancelJoinRoomButton) {
  cancelJoinRoomButton.addEventListener("click", () => {
    $("#join-room-form").classList.add("hidden");
  });
}

const createRoomButton = $("#create-room-button");

if (createRoomButton) {
  createRoomButton.addEventListener("click", async () => {
    setText("#create-room-error", "");

    if (!state.user || !state.userData) {
      setText("#create-room-error", "Not logged in.");
      return;
    }

    const settings = {
      minBet: Number($("#create-min-bet").value) || 0,
      arrangeTimerSeconds: Number($("#create-arrange-timer").value) || 0,
      readyTimerSeconds: Number($("#create-ready-timer").value) || 0,
      botLevel: $("#create-bot-level").value,
      autoFillBots: $("#create-auto-fill-bots").checked,
      scoopBonus: $("#create-scoop-bonus").checked,
      autoArrange: $("#create-auto-arrange").checked
    };

    try {
      const code = await createRoom(
        {
          ...state.user,
          displayName: state.userData.displayName || state.user.username
        },
        settings
      );

      $("#create-room-form").classList.add("hidden");
      await enterRoom(code);
    } catch (error) {
      setText("#create-room-error", error.message || "Failed to create room.");
    }
  });
}

const joinRoomButton = $("#join-room-button");

if (joinRoomButton) {
  joinRoomButton.addEventListener("click", async () => {
    setText("#join-room-error", "");

    if (!state.user || !state.userData) {
      setText("#join-room-error", "Not logged in.");
      return;
    }

    const code = $("#join-room-code").value;

    try {
      const roomId = await joinRoomByCode(
        state.user,
        code,
        state.userData.displayName || state.user.username
      );

      $("#join-room-form").classList.add("hidden");
      await enterRoom(roomId);
    } catch (error) {
      setText("#join-room-error", error.message || "Failed to join room.");
    }
  });
}

async function exitToMenu() {
  try {
    if (state.roomId && state.user) {
      await leaveRoom(state.user, state.roomId);
    }
  } catch (error) {
    console.warn("leaveRoom failed, escaping locally:", error);
  }

  clearRoomState();
  showScreen("menu");
  syncRoomsListener();
}

const leaveRoomButton = $("#leave-room-button");
if (leaveRoomButton) leaveRoomButton.addEventListener("click", exitToMenu);

const exitRoomButton = $("#exit-room-button");
if (exitRoomButton) exitRoomButton.addEventListener("click", exitToMenu);

const joinGameButton = $("#join-game-button");

if (joinGameButton) {
  joinGameButton.addEventListener("click", async () => {
    try {
      await takeSeat(
        state.user,
        state.roomId,
        state.userData?.displayName || state.user.username
      );

      setRoomMessage("Joined the game!");
    } catch (error) {
      setRoomMessage(error.message || "Cannot join game.");
    }
  });
}

const startRoomButton = $("#start-room-button");

if (startRoomButton) {
  startRoomButton.addEventListener("click", async () => {
    try {
      await startRound(state.roomId, state.user);
    } catch (error) {
      setRoomMessage(error.message || "Failed to start round.");
    }
  });
}

const fillBotsButton = $("#fill-bots-button");

if (fillBotsButton) {
  fillBotsButton.addEventListener("click", async () => {
    try {
      await fillBotsInRoom(state.roomId);
    } catch (error) {
      setRoomMessage(error.message || "Failed to fill bots.");
    }
  });
}

const takeSeatButton = $("#take-seat-button");

if (takeSeatButton) {
  takeSeatButton.addEventListener("click", async () => {
    try {
      await takeSeat(
        state.user,
        state.roomId,
        state.userData?.displayName || state.user.username
      );
    } catch (error) {
      setRoomMessage(error.message || "Failed to take seat.");
    }
  });
}

const autoArrangeButton = $("#auto-arrange-button");

if (autoArrangeButton) {
  autoArrangeButton.addEventListener("click", () => {
    if (!state.handData || !state.handData.hand) return;

    state.arrangement = botArrangeHand(state.handData.hand, "hard");
    state.selectedCards.clear();

    renderArrangeSection();
  });
}

const clearArrangementButton = $("#clear-arrangement-button");

if (clearArrangementButton) {
  clearArrangementButton.addEventListener("click", () => {
    autoPlaceFromHand();
    renderArrangeSection();
  });
}

const submitArrangementButton = $("#submit-arrangement-button");

if (submitArrangementButton) {
  submitArrangementButton.addEventListener("click", async () => {
    await submitHumanArrangement();
  });
}

const readyButton = $("#ready-button");

if (readyButton) {
  readyButton.addEventListener("click", async () => {
    try {
      await setReady(state.roomId, state.user.uid, true);
    } catch (error) {
      setRoomMessage(error.message || "Failed to ready.");
    }
  });
}

const forceStartButton = $("#force-start-button");

if (forceStartButton) {
  forceStartButton.addEventListener("click", async () => {
    try {
      await replaceUnreadyWithBots(state.roomId);
      await startRound(state.roomId, state.user);
    } catch (error) {
      setRoomMessage(error.message || "Failed force start.");
    }
  });
}

const adminButton = $("#admin-button");
if (adminButton) adminButton.addEventListener("click", showAdminScreen);

const roomAdminButton = $("#room-admin-button");
if (roomAdminButton) roomAdminButton.addEventListener("click", showAdminScreen);

const adminBackButton = $("#admin-back-button");

if (adminBackButton) {
  adminBackButton.addEventListener("click", () => {
    if (state.adminUnsub) {
      state.adminUnsub();
      state.adminUnsub = null;
    }

    if (state.roomId) {
      showScreen("room");
    } else {
      showScreen("menu");
    }
  });
}

const adminLoadPlayerButton = $("#admin-load-player-button");

if (adminLoadPlayerButton) {
  adminLoadPlayerButton.addEventListener("click", async () => {
    const username = $("#admin-player-username").value.trim().toLowerCase();

    if (!username) {
      setAdminMessage("Enter a username.");
      return;
    }

    const userData = await getUserData(username);

    if (!userData) {
      setText("#admin-player-info", "User not found.");
      return;
    }

    const infoBox = $("#admin-player-info");

    if (infoBox) {
      infoBox.innerHTML = `
        <div>Username: ${userData.username}</div>
        <div>Display Name: ${userData.displayName}</div>
        <div>Cash: ${userData.cash}</div>
        <div>Games: ${userData.games || 0}</div>
        <div>Wins: ${userData.wins || 0}</div>
        <div>Points: ${userData.points || 0}</div>
      `;
    }

    const nameField = $("#admin-display-name");
    if (nameField) nameField.value = userData.displayName || "";
  });
}

const adminSaveNameButton = $("#admin-save-name-button");

if (adminSaveNameButton) {
  adminSaveNameButton.addEventListener("click", async () => {
    const username = $("#admin-player-username").value.trim().toLowerCase();
    const displayName = $("#admin-display-name").value.trim();

    if (!username || !displayName) {
      setAdminMessage("Username and display name required.");
      return;
    }

    try {
      await updateDisplayName(username, displayName, state.user?.username || "admin");
      setAdminMessage("Display name updated.");
    } catch (error) {
      setAdminMessage(error.message || "Failed to update display name.");
    }
  });
}

const adminAddCashButton = $("#admin-add-cash-button");

if (adminAddCashButton) {
  adminAddCashButton.addEventListener("click", async () => {
    const username = $("#admin-player-username").value.trim().toLowerCase();
    const amount = Number($("#admin-cash-amount").value) || 0;
    const reason = $("#admin-cash-reason").value;

    if (!username || amount <= 0) {
      setAdminMessage("Enter username and positive amount.");
      return;
    }

    try {
      await adjustCash(username, amount, "admin_transfer", reason, state.user?.username || "admin");
      await addAdminLog(state.user?.username || "admin", "add_cash", username, { amount, reason });
      setAdminMessage("Cash added.");
    } catch (error) {
      setAdminMessage(error.message || "Failed to add cash.");
    }
  });
}

const adminDeductCashButton = $("#admin-deduct-cash-button");

if (adminDeductCashButton) {
  adminDeductCashButton.addEventListener("click", async () => {
    const username = $("#admin-player-username").value.trim().toLowerCase();
    const amount = Number($("#admin-cash-amount").value) || 0;
    const reason = $("#admin-cash-reason").value;

    if (!username || amount <= 0) {
      setAdminMessage("Enter username and positive amount.");
      return;
    }

    try {
      await adjustCash(username, -amount, "admin_deduct", reason, state.user?.username || "admin");
      await addAdminLog(state.user?.username || "admin", "deduct_cash", username, { amount, reason });
      setAdminMessage("Cash deducted.");
    } catch (error) {
      setAdminMessage(error.message || "Failed to deduct cash.");
    }
  });
}

const adminSetCashButton = $("#admin-set-cash-button");

if (adminSetCashButton) {
  adminSetCashButton.addEventListener("click", async () => {
    const username = $("#admin-player-username").value.trim().toLowerCase();
    const amount = Number($("#admin-cash-amount").value) || 0;
    const reason = $("#admin-cash-reason").value;

    if (!username) {
      setAdminMessage("Enter username.");
      return;
    }

    try {
      await setCash(username, amount, reason, state.user?.username || "admin");
      await addAdminLog(state.user?.username || "admin", "set_cash", username, { amount, reason });
      setAdminMessage("Cash set.");
    } catch (error) {
      setAdminMessage(error.message || "Failed to set cash.");
    }
  });
}

const adminSaveRoomButton = $("#admin-save-room-button");

if (adminSaveRoomButton) {
  adminSaveRoomButton.addEventListener("click", async () => {
    if (!state.roomId) {
      setAdminMessage("You are not in a room.");
      return;
    }

    const settings = {
      minBet: Number($("#admin-room-min-bet").value) || 0,
      botLevel: $("#admin-room-bot-level").value,
      arrangeTimerSeconds: Number($("#admin-room-arrange-timer").value) || 0,
      readyTimerSeconds: Number($("#admin-room-ready-timer").value) || 0,
      autoFillBots: $("#admin-room-auto-fill-bots").checked,
      scoopBonus: $("#admin-room-scoop-bonus").checked
    };

    try {
      await updateRoomSettings(state.roomId, settings);
      await addAdminLog(state.user?.username || "admin", "room_settings", state.roomId, settings);
      setAdminMessage("Room settings saved.");
    } catch (error) {
      setAdminMessage(error.message || "Failed to save room settings.");
    }
  });
}

const adminFillBotsButton = $("#admin-fill-bots-button");

if (adminFillBotsButton) {
  adminFillBotsButton.addEventListener("click", async () => {
    if (!state.roomId) {
      setAdminMessage("You are not in a room.");
      return;
    }

    try {
      await fillBotsInRoom(state.roomId);
      setAdminMessage("Bots filled.");
    } catch (error) {
      setAdminMessage(error.message || "Failed to fill bots.");
    }
  });
}

const adminForceStartButton = $("#admin-force-start-button");

if (adminForceStartButton) {
  adminForceStartButton.addEventListener("click", async () => {
    if (!state.roomId) {
      setAdminMessage("You are not in a room.");
      return;
    }

    if (!isHost()) {
      setAdminMessage("Only the room host can force start.");
      return;
    }

    try {
      await replaceUnreadyWithBots(state.roomId);
      await startRound(state.roomId, state.user);
      setAdminMessage("Round started.");
    } catch (error) {
      setAdminMessage(error.message || "Failed to force start.");
    }
  });
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest(".pg-row-tab");

  if (tab) {
    selectRow(tab.dataset.row);
  }

  if (event.target.closest("#reveal-skip")) {
    skipReveal();
  }

  if (event.target.closest("#view-results-button")) {
    state.showFullResults = !state.showFullResults;
    renderLobbySection();
  }

  if (event.target.closest("#close-results-button")) {
    state.showFullResults = false;
    renderLobbySection();
  }
});

const openZoomBtn = document.getElementById("open-zoom-button");

if (openZoomBtn) {
  openZoomBtn.addEventListener("click", () => {
    state.zoomOpen = true;
    renderArrangeSection();
  });
}

const readyArrangeBtn = document.getElementById("ready-arrange-button");

if (readyArrangeBtn && !readyArrangeBtn.dataset.bound) {
  readyArrangeBtn.dataset.bound = "true";

  readyArrangeBtn.addEventListener("click", () => {
    const a = state.arrangement;

    if (
      a.front.length !== 3 ||
      a.middle.length !== 5 ||
      a.back.length !== 5
    ) {
      setRoomMessage("You need Front 3, Middle 5, Back 5.");
      return;
    }

    if (!isLegalArrangement(a)) {
      setRoomMessage("Warning: Fouled arrangement. Submitting it will auto-lose the round.");
    }

    state.zoomOpen = false;
    renderArrangeSection();
  });
}

const swapMidBackBtn = document.getElementById("swap-mid-back-button");

if (swapMidBackBtn && !swapMidBackBtn.dataset.bound) {
  swapMidBackBtn.dataset.bound = "true";

  swapMidBackBtn.addEventListener("click", () => {
    const tempMid = [...state.arrangement.middle];
    const tempBack = [...state.arrangement.back];

    state.arrangement.middle = tempBack;
    state.arrangement.back = tempMid;

    renderMyRows();
  });
}

const adminSearchField = document.getElementById("admin-user-search");

if (adminSearchField && !adminSearchField.dataset.bound) {
  adminSearchField.dataset.bound = "true";

  adminSearchField.addEventListener("input", (e) => {
    state.adminSearch = e.target.value;
    renderAdminUserList();
  });
}

document.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-room-action]");
  if (!btn) return;

  const code = btn.dataset.code;
  const action = btn.dataset.roomAction;
  const name = state.userData?.displayName || state.user.username;

  try {
    if (action === "watch") {
      await spectateRoom(state.user, code, name);
    } else {
      await joinRoomByCode(state.user, code, name);
    }

    await enterRoom(code);
  } catch (error) {
    console.error(error);

    const err = $("#join-room-error");
    if (err) err.textContent = error.message || "Could not enter room.";
  }
});

setInterval(() => {
  const menu = $("#menu-screen");

  if (menu && !menu.classList.contains("hidden")) {
    renderRoomList();
  }
}, 30000);

const claimDailyBtn = document.getElementById("claim-daily-button");

if (claimDailyBtn && !claimDailyBtn.dataset.bound) {
  claimDailyBtn.dataset.bound = "true";

  claimDailyBtn.addEventListener("click", async () => {
    if (!state.user) return;

    const msg = $("#menu-message");

    try {
      await claimDailyBonus(state.user.username);

      if (msg) msg.textContent = "🎉 +10,000 coins claimed!";
    } catch (error) {
      if (msg) msg.textContent = error.message || "Claim failed.";
    }
  });
}

const showSendMoneyBtn = document.getElementById("show-send-money-button");

if (showSendMoneyBtn) {
  showSendMoneyBtn.addEventListener("click", () => {
    $("#send-money-form").classList.remove("hidden");
  });
}

const cancelSendMoneyBtn = document.getElementById("cancel-send-money-button");

if (cancelSendMoneyBtn) {
  cancelSendMoneyBtn.addEventListener("click", () => {
    $("#send-money-form").classList.add("hidden");
  });
}

const sendMoneyBtn = document.getElementById("send-money-button");

if (sendMoneyBtn) {
  sendMoneyBtn.addEventListener("click", async () => {
    const errEl = $("#send-money-error");
    const okEl = $("#send-money-message");

    if (errEl) errEl.textContent = "";
    if (okEl) okEl.textContent = "";

    const to = $("#send-username").value.trim().toLowerCase();
    const amount = Number($("#send-amount").value);
    const note = $("#send-note").value.trim();

    if (!to || !amount || amount <= 0) {
      if (errEl) errEl.textContent = "Enter a username and a positive amount.";
      return;
    }

    if (!confirm("Send " + formatCash(amount) + " coins to @" + to + "?")) return;

    try {
      await transferCash(state.user.username, to, amount, note);

      if (okEl) okEl.textContent = "✅ Sent " + formatCash(amount) + " to @" + to;

      $("#send-username").value = "";
      $("#send-amount").value = "";
      $("#send-note").value = "";
    } catch (error) {
      if (errEl) errEl.textContent = error.message || "Transfer failed.";
    }
  });
}

setInterval(() => {
  if (state.user && !state.unsubTransactions) {
    state.unsubTransactions = listenUserTransactions(state.user.username, (txs) => {
      state.transactions = txs;
      renderTransactionHistory();
    });
  }
}, 1000);

function renderTransactionHistory() {
  const list = document.getElementById("transaction-history");
  if (!list) return;

  list.innerHTML = "";

  if (!state.transactions || state.transactions.length === 0) {
    list.innerHTML = '<div class="tx-empty">No transactions yet.</div>';
    return;
  }

  state.transactions.forEach((tx) => {
    const amount = Number(tx.amount) || 0;

    let icon = "💰";
    let label = tx.type || "Transaction";
    let detail = tx.note || "";
    let amountClass = amount >= 0 ? "tx-pos" : "tx-neg";

    if (tx.type === "daily_bonus") {
      icon = "🎁";
      label = "Daily Bonus";
      detail = "Login reward";
      amountClass = "tx-pos";
    } else if (tx.type === "transfer_in") {
      icon = "📥";
      label = "Received";
      detail = "From @" + (tx.from || "?");
      amountClass = "tx-pos";
    } else if (tx.type === "transfer_out") {
      icon = "📤";
      label = "Sent";
      detail = "To @" + (tx.to || "?");
      amountClass = "tx-neg";
    } else if (tx.type === "game_settle") {
      icon = "🎮";
      label = "Game Settlement";
      detail = tx.note || "Settlement";
      amountClass = amount >= 0 ? "tx-pos" : "tx-neg";
    } else if (tx.type === "room_entry") {
      icon = "🎟️";
      label = "Room Entry";
      amountClass = "tx-neg";
    } else if (tx.type === "game_win") {
      icon = "🏆";
      label = "Game Win";
      amountClass = "tx-pos";
    } else if (tx.type === "admin_transfer") {
      icon = "🛠️";
      label = "Admin Add Cash";
      detail = tx.note || "Admin adjustment";
      amountClass = amount >= 0 ? "tx-pos" : "tx-neg";
    } else if (tx.type === "admin_deduct") {
      icon = "🛠️";
      label = "Admin Deduct Cash";
      detail = tx.note || "Admin adjustment";
      amountClass = amount >= 0 ? "tx-pos" : "tx-neg";
    } else if (tx.type === "admin_set") {
      icon = "🛠️";
      label = "Admin Set Cash";
      detail = tx.note || "Admin adjustment";
      amountClass = amount >= 0 ? "tx-pos" : "tx-neg";
    }

    const amountStr = (amount >= 0 ? "+" : "") + formatCash(amount);

    const time = new Date(tx.createdAt || Date.now()).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    const row = document.createElement("div");
    row.className = "tx-row";

    row.innerHTML = `
      <div class="tx-icon">${icon}</div>
      <div class="tx-body">
        <div class="tx-label">${label}</div>
        <div class="tx-detail">${detail}</div>
        <div class="tx-time">${time}</div>
      </div>
      <div class="tx-amount ${amountClass}">${amountStr}</div>
    `;

    list.appendChild(row);
  });
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#show-transaction-history-button")) {
    const panel = document.getElementById("transaction-history-panel");
    if (panel) panel.classList.remove("hidden");
    renderTransactionHistory();
  }

  if (e.target.closest("#close-transaction-history-button")) {
    const panel = document.getElementById("transaction-history-panel");
    if (panel) panel.classList.add("hidden");
  }
});

/* =========================================================
   UI ENHANCEMENTS v2
   1) Circular ⇅ Swap Mid/Back FAB placed BETWEEN the
      Middle row and Back row in the Arrange (zoom) view.
   2) "🚪 Exit Room" button added inside the Results overlay
      and inside the Ready area (no more trapped players).
   3) HUD (← back button) forced above every overlay so it
      can never be covered again.
   ========================================================= */

function injectExtraStyles() {
  if (document.getElementById("cardex-extra-styles")) return;

  const style = document.createElement("style");
  style.id = "cardex-extra-styles";

  style.textContent = `
    /* HUD always clickable above overlays / reveal / results */
    .hud { z-index: 30; }

    /* Circular swap (reverse) button */
    .swap-fab {
      width: 54px;
      height: 54px;
      border-radius: 50%;
      border: 3px solid rgba(255, 255, 255, 0.9);
      background: linear-gradient(145deg, #ff4081, #c2185b);
      color: #ffffff;
      font-size: 24px;
      font-weight: 900;
      line-height: 1;
      padding: 0;
      margin: -4px 6% -4px auto;
      align-self: flex-end;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
      cursor: pointer;
      z-index: 6;
      transition: transform 0.12s ease;
    }

    .swap-fab:active {
      transform: scale(0.9) rotate(180deg);
    }

    /* Exit room buttons inside overlays */
    .exit-room-btn {
      background: #ff5252;
      color: #ffffff;
      box-shadow: 0 3px 0 #b71c1c;
    }

    .ready-area .pg-actions {
      flex-wrap: wrap;
    }
  `;

  document.head.appendChild(style);
}

function setupSwapFab() {
  const swapBtn = document.getElementById("swap-mid-back-button");
  if (!swapBtn) return;

  // Turn the old pill button into a circular reverse FAB
  swapBtn.className = "swap-fab";
  swapBtn.textContent = "⇅";
  swapBtn.title = "Swap Middle & Back";
  swapBtn.setAttribute("aria-label", "Swap Middle and Back rows");

  // Move it between the Middle row and the Back row
  const middleRowCards = document.getElementById("row-middle");

  if (middleRowCards) {
    const middleRowWrap = middleRowCards.closest(".my-row");

    if (middleRowWrap && middleRowWrap.parentNode) {
      middleRowWrap.parentNode.insertBefore(swapBtn, middleRowWrap.nextSibling);
    }
  }
}

function addExitButton(container) {
  if (!container) return;
  if (container.querySelector(".exit-room-btn")) return;

  const btn = document.createElement("button");
  btn.className = "pg-btn exit-room-btn";
  btn.textContent = "🚪 Exit Room";

  btn.addEventListener("click", async () => {
    await exitToMenu();
  });

  container.appendChild(btn);
}

function setupExitButtons() {
  // Inside the full results overlay
  addExitButton(document.getElementById("results-section"));

  // Inside the ready / round-end area
  const readyActions = document.querySelector("#ready-area .pg-actions");
  addExitButton(readyActions || document.getElementById("ready-area"));
}

injectExtraStyles();
setupSwapFab();
setupExitButtons();
