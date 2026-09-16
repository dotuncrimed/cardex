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

import { isLegalArrangement, evaluate5, evaluate3, compare5 } from "./evaluator.js";
import { botArrangeHand } from "./bot.js";

import {
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
  addAdminLog
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
  autoSubmitting: false,
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

  if (state.user) needed[state.user.username] = true;

  Object.keys(needed).forEach((un) => {
    if (!state.cashListeners[un]) {
      state.cashListeners[un] = listenUser(un, (data) => {
        state.cashMap[un] = data ? Number(data.cash) || 0 : 0;
        renderSeats();
      });
    }
  });

  Object.keys(state.cashListeners).forEach((un) => {
    if (!needed[un]) {
      state.cashListeners[un]();
      delete state.cashListeners[un];
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

    (state.arrangement[row] || []).forEach((c) => {
      const el = makeCardElement(c, false);
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
  const sR = layer.getBoundingClientRect();
  const tR = target.getBoundingClientRect();

  const sx = sR.width / 2;
  const sy = sR.height / 2;

  for (let i = 0; i < 14; i++) {
    const c = document.createElement("div");
    c.className = "fly-coin";
    c.style.left = sx + "px";
    c.style.top = sy + "px";

    const tx = tR.left - lR.left + tR.width / 2 + (Math.random() * 40 - 20);
    const ty = tR.top - lR.top + tR.height / 2 + (Math.random() * 30 - 15);

    c.style.setProperty("--tx", (tx - sx) + "px");
    c.style.setProperty("--ty", (ty - sy) + "px");
    c.style.animationDelay = (i * 60) + "ms";

    layer.appendChild(c);
    setTimeout(() => c.remove(), 1800 + i * 60);
  }
}



function showScreen(name) {
  const screens = [
    $("#login-screen"),
    $("#menu-screen"),
    $("#room-screen"),
    $("#admin-screen")
  ];

  screens.forEach((screen) => screen.classList.add("hidden"));
  $(`#${name}-screen`).classList.remove("hidden");
}

function setRoomMessage(message) {
  $("#room-message").textContent = message || "";
}

function setAdminMessage(message) {
  $("#admin-message").textContent = message || "";
}

function emptyArrangement() {
  return { front: [], middle: [], back: [] };
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

function clearRoomState() {
  clearRoomListeners();

  // Cleanup cash listeners
  Object.values(state.cashListeners || {}).forEach((un) => un && un());
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

  // Clear any pending timers
  clearRevealTimers();

  localStorage.removeItem("currentRoomId");
  state.roomId = null;
}

async function enterRoom(roomId) {
  clearRoomListeners();

  state.roomId = roomId;
  localStorage.setItem("currentRoomId", roomId);

  state.unsubRoom = listenRoom(roomId, (snapshot) => {
    if (!snapshot.exists()) {
      clearRoomState();
      showScreen("menu");
      return;
    }

    state.room = snapshot.data();
    renderRoom();
    hostController();
  });

  showScreen("room");
}

function renderMenu() {
  if (!state.user) return;

  $("#menu-username").textContent = state.userData?.displayName || state.user.username;
  $("#menu-cash").textContent = state.userData?.cash ?? 0;

  const avatarEl = $("#menu-avatar");
  if (avatarEl) {
    const name = state.userData?.displayName || state.user.username || "?";
    avatarEl.textContent = name.charAt(0).toUpperCase();
  }
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
  setTimeout(() => b.classList.add("hidden"), ms);
}

function renderSeats() {
  ["top", "left", "right", "bottom"].forEach((p) => {
    const el = $("#seat-" + p);
    if (el) el.innerHTML = "";
  });

  if (!state.room || !state.user) return;

  const myPlayer = currentUserPlayerObject();
  const mySeat = myPlayer ? myPlayer.seat : 0;

  state.room.players.forEach((player) => {
    const pos = SEAT_POS[seatOffset(player.seat, mySeat)];
    const el = $("#seat-" + pos);
    if (!el) return;

    const isSelf = player.uid === state.user.uid;

    let status = "";
    if (["arranging", "scoring"].includes(state.room.status)) {
      status = player.submitted ? "✓" : "…";
    } else if (state.room.status === "round_end") {
      status = player.ready ? "✓" : "…";
    }

    el.innerHTML = `
      <div class="avatar">${(player.displayName || "?").charAt(0).toUpperCase()}</div>
      <div class="coin-pill">${isSelf ? (state.userData?.cash ?? 0) : player.displayName}</div>
      <div class="seat-status">${status}${player.isBot ? " 🤖" : ""}</div>
    `;
  });
}

function renderOpponentClusters() {
  const positions = ["top", "left", "right"];
  const show = state.room && ["arranging", "scoring"].includes(state.room.status);

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
        b.style.animationDelay = (i * 60) + "ms";
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

  playerList.innerHTML = "";
  spectatorList.innerHTML = "";

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
        ? player.ready ? " Ready" : " Not Ready"
        : "";

    const submittedText =
      state.room.status === "arranging"
        ? player.submitted ? " Submitted" : " Arranging"
        : "";

    div.textContent =
      `Seat ${player.seat + 1}: ` +
      player.displayName +
      hostText +
      botText +
      readyText +
      submittedText;

    playerList.appendChild(div);
  });

  state.room.spectators.forEach((spectator) => {
    const div = document.createElement("div");
    div.className = "player-row";
    div.textContent = spectator.displayName;
    spectatorList.appendChild(div);
  });
}

function renderRoomInfo() {
  if (!state.room) return;

  $("#room-code").textContent = state.room.roomCode;
  $("#room-status").textContent = state.room.status;
  $("#room-round").textContent = state.room.roundNumber || 0;
  $("#room-min-bet").textContent = state.room.settings.minBet;
  $("#room-pot").textContent = state.room.pot || 0;
  $("#room-bot-level").textContent = state.room.settings.botLevel;

  const timerElement = $("#room-timer");

  if (state.room.phaseEndsAt) {
    const secondsLeft = Math.max(
      0,
      Math.ceil((state.room.phaseEndsAt - Date.now()) / 1000)
    );
    timerElement.textContent = `${secondsLeft}s`;
  } else {
    timerElement.textContent = "Off";
  }

  const roundEl = $("#pg-round");
  if (roundEl) roundEl.textContent = "Round " + (state.room.roundNumber || 0);

  const potEl = $("#pg-pot");
  if (potEl) potEl.textContent = "1 pt = " + (state.room.settings.minBet || 0);

  const hudCash = $("#hud-cash");
  if (hudCash) hudCash.textContent = state.userData?.cash ?? 0;
}

function renderLobbySection() {
  const lobbySection = $("#lobby-section");
  const arrangeSection = $("#arrange-section");
  const resultsSection = $("#results-section");

  lobbySection.classList.add("hidden");
  arrangeSection.classList.add("hidden");
  resultsSection.classList.add("hidden");

  if (!state.room) return;

  const status = state.room.status;

  if (status === "lobby") {
    lobbySection.classList.remove("hidden");
  }

  if (status === "arranging" || status === "scoring") {
    if (currentUserInRoomPlayers()) {
      arrangeSection.classList.remove("hidden");
      renderArrangeSection();
    } else {
      lobbySection.classList.remove("hidden");
      setRoomMessage("Round in progress. You are spectating.");
    }
  }

  if (status === "round_end" && state.showFullResults) {
    resultsSection.classList.remove("hidden");
    renderResultsSection();
  }

  const startButton = $("#start-room-button");
  const fillBotsButton = $("#fill-bots-button");
  const takeSeatButton = $("#take-seat-button");

  startButton.classList.toggle("hidden", !isHost() || !["lobby", "round_end"].includes(status));
  fillBotsButton.classList.toggle("hidden", !isHost() || !["lobby", "round_end"].includes(status));

  const canTakeSeat =
    currentUserInRoomSpectators() &&
    ["lobby", "round_end"].includes(status);

  takeSeatButton.classList.toggle("hidden", !canTakeSeat);

  renderPlayerList();
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
        el.style.animationDelay = (index * 70) + "ms";
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

function clearRevealTimers() {
  (state.revealTimers || []).forEach(clearTimeout);
  state.revealTimers = [];
}

function rowScoreFor(results, uid, rowKey) {
  const list = results.details[uid] || [];
  return list.reduce((sum, d) => sum + (d.rows[rowKey] || 0), 0);
}

function rowNameFor(arrangement, row) {
  if (!arrangement) return "-";
  if (row === "front") return evaluate3(arrangement.front).name;
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

  ((arrangement && arrangement[row]) || []).forEach((c, i) => {
    const el = makeCardElement(c, false);
    el.classList.add("reveal-card");
    el.style.animationDelay = (i * 80) + "ms";
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

  [["front", "sp-front"], ["middle", "sp-mid"], ["back", "sp-back"]]
    .forEach(([key, id]) => {
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
      ? ((total >= 0 ? "+" : "") + total)
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

  state.room.players.forEach((pl) => {
    const full = ["front", "middle", "back"]
      .reduce((s, k) => s + rowScoreFor(results, pl.uid, k), 0);
    const pos = SEAT_POS[seatOffset(pl.seat, mySeat)];
    const arr = results.arrangements ? results.arrangements[pl.uid] : null;
    renderRevealSlot(pos, pl, arr, "back", rowScoreFor(results, pl.uid, "back"), full);
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

  const myPlayer = currentUserPlayerObject();
  const mySeat = myPlayer ? myPlayer.seat : 0;

  const seats = state.room.players.map((pl) => ({
    pl,
    pos: SEAT_POS[seatOffset(pl.seat, mySeat)]
  }));

  const rows = ["front", "middle", "back"];
  const cum = {};
  seats.forEach((s) => { cum[s.pl.uid] = 0; });

  let t = 500;

  rows.forEach((row, ri) => {
    state.revealTimers.push(setTimeout(() => {
      seats.forEach((s, si) => {
        state.revealTimers.push(setTimeout(() => {
          const arr = results.arrangements
            ? results.arrangements[s.pl.uid]
            : null;
          const rs = rowScoreFor(results, s.pl.uid, row);
          cum[s.pl.uid] += rs;
          renderRevealSlot(s.pos, s.pl, arr, row, rs, cum[s.pl.uid]);

          if (s.pl.uid === state.user.uid) {
            updateScorePanel(results, state.user.uid, rows.slice(0, ri + 1));
          }
        }, si * 250));
      });
    }, t));

    t += 2100;
  });

  state.revealTimers.push(setTimeout(() => {
    finalizeReveal();
  }, t + 400));
}

function renderArrangeSection() {
  const autoBtn = $("#auto-arrange-button");
  if (autoBtn) autoBtn.classList.toggle("hidden", !state.room.settings.autoArrange);

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
  $("#assign-front-button").disabled = disabled;
  $("#assign-middle-button").disabled = disabled;
  $("#assign-back-button").disabled = disabled;
  $("#auto-arrange-button").disabled = disabled;
  $("#clear-arrangement-button").disabled = disabled;
  $("#submit-arrangement-button").disabled = disabled;
}

function renderAssignedCards() {
  renderAssignedSection("front", $("#front-cards"));
  renderAssignedSection("middle", $("#middle-cards"));
  renderAssignedSection("back", $("#back-cards"));
}

function renderAssignedSection(sectionName, container) {
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

function renderHandCards() {
  const container = $("#hand-cards");
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
    if (ranking.scoops > 0) headText += ` • 🏠 ${ranking.scoops} Scoop${ranking.scoops > 1 ? "s" : ""}`;
    if (ranking.royalties > 0) headText += ` • 💎 +${ranking.royalties} Royalty`;
    if (ranking.fouled) headText += ` • FOUL`;
    
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
    resultSummary.textContent = "Waiting for results...";
    resultTable.innerHTML = "";
    resultDetails.innerHTML = "";
    return;
  }

  resultSummary.textContent =
    `Round ${results.roundNumber} | 1 pt = ${results.minBet} | Winner = most points`;

  resultTable.innerHTML = "";

  const header = resultTable.insertRow();

  [
    "Rank",
    "Player",
    "Type",
    "Wins",
    "Bet",
    "Prize",
    "Net"
  ].forEach((text) => {
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

  renderResultBoards(results);
  renderReadyArea();
}

function renderReadyArea() {
  const readyList = $("#ready-list");
  const readyButton = $("#ready-button");
  const forceStartButton = $("#force-start-button");

  readyList.innerHTML = "";

  if (!state.room || state.room.status !== "round_end") return;

  const results = state.room.results;
  const players = [...state.room.players].sort((a, b) => a.seat - b.seat);

  const title = document.createElement("h4");
  title.textContent = "Round Results & Next Round Status";
  title.style.margin = "0 0 10px 0";
  readyList.appendChild(title);

  // Build a map of player rankings
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
        isWinner: idx === 0
      };
    });
  }

  players.forEach((player) => {
    const div = document.createElement("div");
    const rankInfo = rankMap[player.uid];
    const isWinner = rankInfo && rankInfo.isWinner;
    const isFouled = rankInfo && rankInfo.fouled;
    
    div.className = `player-row ready-status-row ${player.ready ? "ready" : "not-ready"} ${isWinner ? "winner" : ""} ${isFouled ? "fouled" : ""}`;

    const readyIcon = player.ready ? "✅" : "❌";
    const statusText = player.ready ? "Ready" : "Waiting...";
    const youText = (state.user && player.uid === state.user.uid) ? " (You)" : "";
    
    let rankBadge = "";
    if (rankInfo) {
      if (isWinner) {
        rankBadge = `<span class="winner-badge">🏆 WINNER</span>`;
      } else if (isFouled) {
        rankBadge = `<span class="foul-badge">FOUL</span>`;
      } else {
        const ordinal = rankInfo.rank === 1 ? "st" : rankInfo.rank === 2 ? "nd" : rankInfo.rank === 3 ? "rd" : "th";
        rankBadge = `<span class="rank-badge">${rankInfo.rank}${ordinal} • ${rankInfo.points} pts</span>`;
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

    readyList.appendChild(div);
  });

  const me = currentUserPlayerObject();

  const showReadyButton =
    me &&
    !me.isBot &&
    !me.ready &&
    state.userData &&
    Number(state.userData.cash) >= Number(state.room.settings.minBet);

  readyButton.classList.toggle("hidden", !showReadyButton);

  const showForceStart = isHost();
  forceStartButton.classList.toggle("hidden", !showForceStart);
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
      ["arranging", "scoring"].includes(state.room.status)
    );
  }

  renderRoomInfo();
  renderSeats();
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
    if (allSubmitted) {
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
    if (humans.length === 0) return; // never auto-run a bot-only table

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

  $("#admin-room-min-bet").value = state.room.settings.minBet;
  $("#admin-room-bot-level").value = state.room.settings.botLevel;
  $("#admin-room-arrange-timer").value = state.room.settings.arrangeTimerSeconds;
  $("#admin-room-ready-timer").value = state.room.settings.readyTimerSeconds;
  $("#admin-room-auto-fill-bots").checked = Boolean(state.room.settings.autoFillBots);
  $("#admin-room-scoop-bonus").checked = Boolean(state.room.settings.scoopBonus);
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
  showScreen("admin");
}

watchAuth((user) => {
  state.user = user;

  if (state.unsubUser) {
    state.unsubUser();
    state.unsubUser = null;
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
  const readyPhase = state.room.status === "round_end" && state.revealPlayedFor === state.room.roundNumber;

  const showTableTimer = (arranging || readyPhase) && state.room.phaseEndsAt;
  const showZoomTimer = arranging && state.room.phaseEndsAt && state.zoomOpen;

  if (timerEl) {
    timerEl.classList.toggle("hidden", !showTableTimer);
    if (showTableTimer) {
      const seconds = Math.max(0, Math.ceil((state.room.phaseEndsAt - Date.now()) / 1000));
      timerEl.textContent = seconds;
    } else {
      timerEl.textContent = "--";
    }
  }

  if (zoomTimerEl) {
    zoomTimerEl.classList.toggle("hidden", !showZoomTimer);
    if (showZoomTimer) {
      const seconds = Math.max(0, Math.ceil((state.room.phaseEndsAt - Date.now()) / 1000));
      zoomTimerEl.textContent = seconds;
    }
  }

  autoSubmitIfNeeded();
  hostController();
}, 700);

$("#login-button").addEventListener("click", async () => {
  const username = $("#login-username").value;
  const pin = $("#login-pin").value;

  $("#login-error").textContent = "";

  try {
    await loginOrRegister(username, pin);
  } catch (error) {
    $("#login-error").textContent = error.message || "Login failed.";
  }
});

$("#logout-button").addEventListener("click", async () => {
  clearRoomState();
  await logoutUser();
});

$("#show-create-room-button").addEventListener("click", () => {
  $("#create-room-form").classList.remove("hidden");
  $("#join-room-form").classList.add("hidden");
});

$("#cancel-create-room-button").addEventListener("click", () => {
  $("#create-room-form").classList.add("hidden");
});

$("#show-join-room-button").addEventListener("click", () => {
  $("#join-room-form").classList.remove("hidden");
  $("#create-room-form").classList.add("hidden");
});

$("#cancel-join-room-button").addEventListener("click", () => {
  $("#join-room-form").classList.add("hidden");
});

$("#create-room-button").addEventListener("click", async () => {
  $("#create-room-error").textContent = "";

  if (!state.user || !state.userData) {
    $("#create-room-error").textContent = "Not logged in.";
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
    $("#create-room-error").textContent = error.message || "Failed to create room.";
  }
});

$("#join-room-button").addEventListener("click", async () => {
  $("#join-room-error").textContent = "";

  if (!state.user || !state.userData) {
    $("#join-room-error").textContent = "Not logged in.";
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
    $("#join-room-error").textContent = error.message || "Failed to join room.";
  }
});

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
}

$("#leave-room-button").addEventListener("click", exitToMenu);
$("#exit-room-button").addEventListener("click", exitToMenu);

$("#join-game-button").addEventListener("click", async () => {
  try {
    await takeSeat(state.user, state.roomId, state.userData?.displayName || state.user.username);
    setRoomMessage("Joined the game!");
  } catch (error) {
    setRoomMessage(error.message || "Cannot join game.");
  }
});

$("#start-room-button").addEventListener("click", async () => {
  try {
    await startRound(state.roomId, state.user);
  } catch (error) {
    setRoomMessage(error.message || "Failed to start round.");
  }
});

$("#fill-bots-button").addEventListener("click", async () => {
  try {
    await fillBotsInRoom(state.roomId);
  } catch (error) {
    setRoomMessage(error.message || "Failed to fill bots.");
  }
});

$("#take-seat-button").addEventListener("click", async () => {
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

$("#auto-arrange-button").addEventListener("click", () => {
  if (!state.handData || !state.handData.hand) return;

  state.arrangement = botArrangeHand(state.handData.hand, "hard");
  state.selectedCards.clear();
  renderArrangeSection();
});

$("#clear-arrangement-button").addEventListener("click", () => {
  autoPlaceFromHand();
  renderArrangeSection();
});

$("#submit-arrangement-button").addEventListener("click", async () => {
  await submitHumanArrangement();
});

$("#ready-button").addEventListener("click", async () => {
  try {
    await setReady(state.roomId, state.user.uid, true);
  } catch (error) {
    setRoomMessage(error.message || "Failed to ready.");
  }
});

$("#force-start-button").addEventListener("click", async () => {
  try {
    await replaceUnreadyWithBots(state.roomId);
    await startRound(state.roomId, state.user);
  } catch (error) {
    setRoomMessage(error.message || "Failed force start.");
  }
});

$("#admin-button").addEventListener("click", showAdminScreen);
$("#room-admin-button").addEventListener("click", showAdminScreen);

$("#admin-back-button").addEventListener("click", () => {
  if (state.roomId) {
    showScreen("room");
  } else {
    showScreen("menu");
  }
});

$("#admin-load-player-button").addEventListener("click", async () => {
  const username = $("#admin-player-username").value.trim().toLowerCase();

  if (!username) {
    setAdminMessage("Enter a username.");
    return;
  }

  const userData = await getUserData(username);

  if (!userData) {
    $("#admin-player-info").textContent = "User not found.";
    return;
  }

  $("#admin-player-info").innerHTML = `
    <div>Username: ${userData.username}</div>
    <div>Display Name: ${userData.displayName}</div>
    <div>Cash: ${userData.cash}</div>
    <div>Games: ${userData.games || 0}</div>
    <div>Wins: ${userData.wins || 0}</div>
    <div>Points: ${userData.points || 0}</div>
  `;

  $("#admin-display-name").value = userData.displayName || "";
});

$("#admin-save-name-button").addEventListener("click", async () => {
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

$("#admin-add-cash-button").addEventListener("click", async () => {
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

$("#admin-deduct-cash-button").addEventListener("click", async () => {
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

$("#admin-set-cash-button").addEventListener("click", async () => {
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

$("#admin-save-room-button").addEventListener("click", async () => {
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

$("#admin-fill-bots-button").addEventListener("click", async () => {
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

$("#admin-force-start-button").addEventListener("click", async () => {
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

// Zoom arrange listeners
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
    if (typeof renderMyRows === "function") {
      renderMyRows();
    }
  });
}
