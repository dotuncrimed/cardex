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

import { isLegalArrangement } from "./evaluator.js";
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
  autoSubmitting: false
};

function $(selector) {
  return document.querySelector(selector);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  state.room = null;
  state.handData = null;
  state.arrangement = emptyArrangement();
  state.selectedCards.clear();
  state.roundInitialized = null;

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

function renderSeats() {
  const container = $("#pg-seats");
  if (!container || !state.room) return;

  container.innerHTML = "";

  const players = [...state.room.players].sort((a, b) => a.seat - b.seat);

  players.forEach((player) => {
    const isSelf = state.user && player.uid === state.user.uid;

    const seat = document.createElement("div");
    seat.className =
      "pg-seat" +
      (isSelf ? " self" : "") +
      (player.isBot ? " bot" : "");

    const initial = (player.displayName || "?").charAt(0).toUpperCase();

    let status = "";

    if (state.room.status === "arranging" || state.room.status === "scoring") {
      status = player.submitted ? "✓" : "…";
    } else if (state.room.status === "round_end") {
      status = player.ready ? "✓" : "…";
    }

    seat.innerHTML = `
      <div class="pg-avatar">${initial}</div>
      <div class="pg-seat-name">${player.displayName}${isSelf ? " (You)" : ""}</div>
      <div class="pg-seat-status">${status}</div>
    `;

    container.appendChild(seat);
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
  if (potEl) potEl.textContent = "Pot " + (state.room.pot || 0);
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

  if (status === "lobby" || status === "round_end") {
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

  if (status === "round_end") {
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

function renderArrangeSection() {
  const arrangeStatus = $("#arrange-status");

  if (!state.handData) {
    arrangeStatus.textContent = "Waiting for cards...";
    return;
  }

  if (state.handData.submitted) {
    arrangeStatus.textContent = "You submitted. Waiting for other players...";
    disableArrangeControls(true);
    renderAssignedCards();
    renderHandCards();
    return;
  }

  if (state.room.settings.autoArrange) {
    arrangeStatus.textContent = "Auto-arranging your cards...";
    disableArrangeControls(true);

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

  arrangeStatus.textContent = "Arrange your cards.";
  disableArrangeControls(false);
  renderAssignedCards();
  renderHandCards();
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

  if (!isLegalArrangement(arrangement)) {
    setRoomMessage("Illegal arrangement. Back must beat Middle, Middle must beat Front.");
    return;
  }

  try {
    await submitArrangement(state.roomId, state.user.uid, arrangement);
    setRoomMessage("Submitted.");
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

  state.autoSubmitting = true;

  try {
    let arrangement = state.arrangement;

    const isValid =
      arrangement.front.length === 3 &&
      arrangement.middle.length === 5 &&
      arrangement.back.length === 5 &&
      isLegalArrangement(arrangement);

    if (!isValid) {
      arrangement = botArrangeHand(state.handData.hand, "hard");
    }

    await submitArrangement(state.roomId, state.user.uid, arrangement);
  } catch (error) {
    console.error(error);
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
    head.textContent =
      `${index + 1}. ${ranking.displayName}` +
      `${ranking.isBot ? " (Bot)" : ""} — ${ranking.points} wins`;

    board.appendChild(head);

    const arrangement = results.arrangements
      ? results.arrangements[ranking.uid]
      : null;

    if (arrangement) {
      board.appendChild(createCombinationBlock("Front", arrangement.front));
      board.appendChild(createCombinationBlock("Middle", arrangement.middle));
      board.appendChild(createCombinationBlock("Back", arrangement.back));
    }

    if (!ranking.isBot) {
      const net = document.createElement("div");
      net.className = "pg-board-net";
      net.textContent =
        `Bet ${ranking.bet} • Prize ${ranking.prize} • ` +
        `Net ${ranking.net >= 0 ? "+" : ""}${ranking.net}`;
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
    `Round ${results.roundNumber} | ` +
    `Pot ${results.pot} | ` +
    `Winner = most opponents beaten`;

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

  const players = [...state.room.players].sort((a, b) => a.seat - b.seat);

  const title = document.createElement("h4");
  title.textContent = "Next Round Status";
  title.style.margin = "0 0 10px 0";
  readyList.appendChild(title);

  players.forEach((player) => {
    const div = document.createElement("div");
    div.className = `player-row ready-status-row ${player.ready ? "ready" : "not-ready"}`;

    const icon = player.ready ? "✅" : "❌";
    const statusText = player.ready ? "Ready" : "Waiting...";
    const youText = (state.user && player.uid === state.user.uid) ? " (You)" : "";

    div.innerHTML = `
      <span class="ready-icon">${icon}</span>
      <span class="player-name">${player.displayName}${youText}</span>
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
    state.roundInitialized = state.room.roundNumber;
  }

  renderRoomInfo();
  renderSeats();
  selectRow(state.targetRow || "front");
  renderLobbySection();
  manageHandListener();
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

  const room = state.room;

  if (room.status === "arranging") {
    const allSubmitted = room.players.every((player) => player.submitted);

    if (allSubmitted) {
      state.hostBusy = true;

      try {
        await finishRound(room.roomCode, state.user);
      } catch (error) {
        console.error(error);
        setRoomMessage("Failed to finish round.");
      } finally {
        state.hostBusy = false;
      }
    }

    return;
  }

  if (room.status === "round_end") {
    const humans = room.players.filter((player) => !player.isBot);
    const readyHumans = humans.filter((player) => player.ready);

    if (humans.length > 0 && readyHumans.length === humans.length) {
      state.hostBusy = true;

      try {
        await sleep(800);
        await startRound(room.roomCode, state.user);
      } catch (error) {
        console.error(error);
        setRoomMessage(error.message || "Failed to start next round.");
      } finally {
        state.hostBusy = false;
      }

      return;
    }

    if (room.phaseEndsAt && Date.now() > room.phaseEndsAt) {
      if (readyHumans.length > 0) {
        state.hostBusy = true;

        try {
          await replaceUnreadyWithBots(room.roomCode);
          await startRound(room.roomCode, state.user);
        } catch (error) {
          console.error(error);
          setRoomMessage(error.message || "Failed to start after timer.");
        } finally {
          state.hostBusy = false;
        }
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

  if (timerEl && state.room.phaseEndsAt) {
    const seconds = Math.max(0, Math.ceil((state.room.phaseEndsAt - Date.now()) / 1000));
    timerEl.textContent = seconds;
  } else if (timerEl) {
    timerEl.textContent = "--";
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

$("#leave-room-button").addEventListener("click", async () => {
  try {
    await leaveRoom(state.user, state.roomId);
    clearRoomState();
    showScreen("menu");
  } catch (error) {
    setRoomMessage(error.message || "Cannot leave room.");
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
  state.arrangement = emptyArrangement();
  state.selectedCards.clear();
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
});
