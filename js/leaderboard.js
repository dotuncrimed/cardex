// js/leaderboard.js
// Self-contained Leaderboards module (Feature 1)
// Categories: Highest Coins / Lowest Coins / Highest Points / Lowest Points

import { listenAllUsers } from "./db.js";

const LB_CATEGORIES = [
  { id: "cash_desc", label: "💰 Highest Coins" },
  { id: "cash_asc", label: "🪙 Lowest Coins" },
  { id: "points_desc", label: "⭐ Highest Points" },
  { id: "points_asc", label: "📉 Lowest Points" }
];

const lbState = {
  open: false,
  category: "cash_desc",
  users: [],
  unsub: null
};

function lbFormat(n) {
  n = Number(n) || 0;

  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";

  return String(n);
}

function injectLeaderboardStyles() {
  if (document.getElementById("lb-styles")) return;

  const style = document.createElement("style");
  style.id = "lb-styles";

  style.textContent = `
    #leaderboard-panel {
      position: fixed;
      inset: 0;
      z-index: 1250;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      padding: 16px;
    }

    .lb-modal {
      position: relative;
      width: min(94%, 560px);
      max-height: 86vh;
      overflow: auto;
      background: rgba(7, 24, 15, 0.98);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 16px;
      padding: 18px;
    }

    .lb-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 12px 0;
    }

    .lb-tab {
      border: none;
      border-radius: 999px;
      padding: 8px 14px;
      background: rgba(255, 255, 255, 0.1);
      color: #e7f0e9;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
    }

    .lb-tab.active {
      background: linear-gradient(145deg, #ffd54f, #ff9800);
      color: #332000;
    }

    .lb-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .lb-row {
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 10px 12px;
    }

    .lb-row.lb-top {
      border-color: rgba(255, 213, 79, 0.6);
      background: rgba(255, 213, 79, 0.08);
    }

    .lb-rank {
      min-width: 34px;
      text-align: center;
      font-weight: 900;
      font-size: 16px;
    }

    .lb-avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: linear-gradient(145deg, #ffd54f, #ff9800);
      color: #332000;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .lb-name {
      flex: 1;
      min-width: 0;
      font-weight: 700;
      font-size: 14px;
      color: #fff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .lb-name small {
      display: block;
      font-weight: 400;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.55);
    }

    .lb-value {
      font-weight: 900;
      font-size: 15px;
      color: #ffe082;
    }

    .lb-empty {
      text-align: center;
      color: rgba(255, 255, 255, 0.5);
      padding: 20px 0;
    }
  `;

  document.head.appendChild(style);
}

function lbSort(users, category) {
  const list = [...users];

  if (category === "cash_desc") {
    list.sort((a, b) => (Number(b.cash) || 0) - (Number(a.cash) || 0));
  } else if (category === "cash_asc") {
    list.sort((a, b) => (Number(a.cash) || 0) - (Number(b.cash) || 0));
  } else if (category === "points_desc") {
    list.sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0));
  } else if (category === "points_asc") {
    list.sort((a, b) => (Number(a.points) || 0) - (Number(b.points) || 0));
  }

  return list.slice(0, 50);
}

function renderLeaderboard() {
  const list = document.getElementById("lb-list");
  if (!list) return;

  list.innerHTML = "";

  const rows = lbSort(lbState.users, lbState.category);

  if (rows.length === 0) {
    list.innerHTML = '<div class="lb-empty">No players yet.</div>';
    return;
  }

  const isCash = lbState.category.startsWith("cash");

  rows.forEach((user, index) => {
    const row = document.createElement("div");
    row.className = "lb-row" + (index < 3 ? " lb-top" : "");

    const medal =
      index === 0 ? "🥇" :
      index === 1 ? "🥈" :
      index === 2 ? "🥉" :
      String(index + 1);

    const value = isCash
      ? lbFormat(Number(user.cash) || 0)
      : String(Number(user.points) || 0) + " pts";

    row.innerHTML = `
      <span class="lb-rank">${medal}</span>
      <span class="lb-avatar">${(user.displayName || user.username || "?").charAt(0).toUpperCase()}</span>
      <span class="lb-name">
        ${user.displayName || user.username}
        <small>@${user.username}</small>
      </span>
      <span class="lb-value">${value}</span>
    `;

    list.appendChild(row);
  });
}

function setLbCategory(category) {
  lbState.category = category;

  document.querySelectorAll(".lb-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.lbCat === category);
  });

  renderLeaderboard();
}

function openLeaderboard() {
  const panel = document.getElementById("leaderboard-panel");
  if (!panel) return;

  panel.classList.remove("hidden");
  lbState.open = true;

  if (!lbState.unsub) {
    lbState.unsub = listenAllUsers(
      (users) => {
        lbState.users = users;
        if (lbState.open) renderLeaderboard();
      },
      () => {
        // permission / network error -> close safely
        closeLeaderboard();
      }
    );
  }

  renderLeaderboard();
}

function closeLeaderboard() {
  const panel = document.getElementById("leaderboard-panel");
  if (panel) panel.classList.add("hidden");

  lbState.open = false;

  if (lbState.unsub) {
    lbState.unsub();
    lbState.unsub = null;
  }
}

function createLeaderboardUI() {
  if (document.getElementById("leaderboard-button")) return;

  // 1) Menu button
  const btn = document.createElement("button");
  btn.id = "leaderboard-button";
  btn.className = "btn-secondary";
  btn.textContent = "🏆 Leaderboards";

  const grid =
    document.querySelector(".fp-menu-grid") ||
    document.querySelector("#menu-screen .fp-panel");

  if (grid) grid.appendChild(btn);

  btn.addEventListener("click", openLeaderboard);

  // 2) Overlay panel
  const overlay = document.createElement("div");
  overlay.id = "leaderboard-panel";
  overlay.className = "hidden";

  overlay.innerHTML = `
    <div class="lb-modal">
      <button id="lb-close-button" class="close-panel-btn">✕</button>
      <h3>🏆 Leaderboards</h3>
      <div class="lb-tabs">
        ${LB_CATEGORIES.map(
          (c) => `<button class="lb-tab" data-lb-cat="${c.id}">${c.label}</button>`
        ).join("")}
      </div>
      <div id="lb-list" class="lb-list"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  document
    .getElementById("lb-close-button")
    .addEventListener("click", closeLeaderboard);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeLeaderboard();
  });

  overlay.querySelectorAll(".lb-tab").forEach((tab) => {
    tab.addEventListener("click", () => setLbCategory(tab.dataset.lbCat));
  });

  setLbCategory("cash_desc");
}

injectLeaderboardStyles();
createLeaderboardUI();


