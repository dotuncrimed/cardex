// js/leaderboard.js
// Feature 1: Leaderboards  (FILE 3/7 revamp)
// - Tokenized skin (reads theme.css vars; graceful fallbacks)
// - LAZY listeners: subscribe only while open, tear down on close/logout (free-tier safe)
// - "Your Standing" sticky card + highlighted row + honest Top 50+ handling
// - Loading / empty / error states, top-3 medals, accessible modal
import { db } from "./firebase.js";
import {
  collection, query, orderBy, limit, onSnapshot, doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { watchAuth } from "./auth.js";

const LB_LIMIT = 50;

const lbState = {
  user: null,
  me: null,            // own user doc (always fresh while open)
  users: [],           // top N by cash
  loading: false,
  error: null,
  open: false,
  unsubTop: null,
  unsubMe: null,
  lastFocus: null
};

/* ----------------------------- utils ----------------------------- */
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatCash(n) {
  n = Number(n) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "K";
  return sign + String(abs);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function initialOf(u) {
  const src = (u && (u.displayName || u.username || u.id)) || "?";
  return String(src).charAt(0).toUpperCase();
}

function myRank() {
  if (!lbState.me) return null;
  const idx = lbState.users.findIndex(
    (u) => u.uid === lbState.me.uid || u.id === lbState.me.username
  );
  return idx === -1 ? null : idx + 1;
}

function isMe(u) {
  if (!lbState.me) return false;
  return u.uid === lbState.me.uid || u.id === lbState.me.username;
}

/* ----------------------------- skin ------------------------------ */
function injectLeaderboardStyles() {
  if (document.getElementById("lb-styles-v2")) return;
  const style = document.createElement("style");
  style.id = "lb-styles-v2";
  style.textContent = `
#leaderboard-panel{
  position:fixed; inset:0; z-index:1250;
  display:none; align-items:center; justify-content:center;
  padding:16px; background:rgba(0,0,0,.55);
  backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px);
}
#leaderboard-panel.is-open{ display:flex; }
.lb-modal{
  position:relative; width:min(94%,560px); max-height:86vh;
  display:flex; flex-direction:column;
  background:var(--glass-2, rgba(7,24,15,.98));
  border:1px solid var(--glass-line, rgba(255,255,255,.14));
  border-radius:var(--r-lg,16px);
  box-shadow:var(--sh-3, 0 18px 44px rgba(0,0,0,.55));
  overflow:hidden;
  animation:lbPop var(--t-med,200ms) cubic-bezier(.2,.8,.2,1) both;
}
@keyframes lbPop{ from{ transform:scale(.94); opacity:0; } to{ transform:scale(1); opacity:1; } }
.lb-head{
  flex:0 0 auto; display:flex; align-items:center; gap:10px;
  padding:14px 16px; border-bottom:1px solid var(--line, rgba(255,255,255,.12));
}
.lb-title{
  margin:0; font-family:var(--font-display, Georgia, serif);
  font-size:18px; font-weight:900; letter-spacing:.02em;
  color:var(--gold,#ffd54f); flex:1 1 auto;
}
.lb-live{
  display:inline-flex; align-items:center; gap:6px;
  font:700 11px/1 var(--font-ui, sans-serif);
  color:var(--txt-dim,#9fb3a8);
  background:rgba(255,255,255,.06);
  border:1px solid var(--line, rgba(255,255,255,.12));
  padding:4px 9px; border-radius:var(--r-pill,999px);
}
.lb-live .dot{
  width:7px; height:7px; border-radius:50%;
  background:var(--good,#3ecf8e); box-shadow:0 0 0 0 rgba(62,207,142,.6);
  animation:lbPulse 1.6s ease-in-out infinite;
}
@keyframes lbPulse{ 0%,100%{ box-shadow:0 0 0 0 rgba(62,207,142,.55);} 50%{ box-shadow:0 0 0 6px rgba(62,207,142,0);} }
.lb-close{
  flex:0 0 auto; width:34px; height:34px; border-radius:50%;
  border:1px solid var(--line-2, rgba(255,255,255,.2));
  background:rgba(0,0,0,.35); color:var(--txt,#eaf3ee);
  font-size:16px; line-height:1; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  transition:background var(--t-fast,120ms), color var(--t-fast,120ms), transform var(--t-fast,120ms);
}
.lb-close:hover{ background:rgba(0,0,0,.6); color:var(--gold,#ffd54f); transform:translateY(-1px); }

/* standing card */
.lb-standing{
  flex:0 0 auto; margin:12px 16px 4px;
  display:flex; align-items:center; gap:12px;
  padding:12px 14px; border-radius:var(--r-md,12px);
  background:linear-gradient(180deg, rgba(255,213,79,.14), rgba(255,152,0,.06));
  border:1px solid rgba(255,213,79,.4);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06);
}
.lb-standing .lb-avatar{ box-shadow:0 0 0 2px var(--gold,#ffd54f); }
.lb-standing-main{ flex:1 1 auto; min-width:0; }
.lb-standing-name{
  font:800 15px/1.2 var(--font-ui, sans-serif); color:var(--txt,#eaf3ee);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.lb-standing-sub{ font:600 11px/1.3 var(--font-ui, sans-serif); color:var(--txt-dim,#9fb3a8); }
.lb-standing-rank{
  flex:0 0 auto; text-align:right;
  font-family:var(--font-display, Georgia, serif);
  font-weight:900; font-size:22px; line-height:1; color:var(--gold,#ffd54f);
}
.lb-standing-rank small{ display:block; font:700 9px/1.2 var(--font-ui, sans-serif); color:var(--txt-dim,#9fb3a8); letter-spacing:.08em; text-transform:uppercase; }
.lb-standing-stats{ display:flex; gap:10px; margin-top:4px; flex-wrap:wrap; }
.lb-standing-stats span{ font:700 11px/1 var(--font-ui, sans-serif); color:var(--txt-dim,#9fb3a8); }
.lb-standing-stats b{ color:var(--txt,#eaf3ee); }

/* body / rows */
.lb-body{ flex:1 1 auto; overflow:auto; padding:6px 10px 14px; -webkit-overflow-scrolling:touch; }
.lb-row{
  display:flex; align-items:center; gap:10px;
  padding:9px 10px; border-radius:var(--r-sm,8px);
  border:1px solid transparent;
  transition:background var(--t-fast,120ms), border-color var(--t-fast,120ms);
}
@media (hover:hover){ .lb-row:hover{ background:rgba(255,255,255,.04); } }
.lb-row.me{
  background:rgba(255,213,79,.10);
  border-color:rgba(255,213,79,.45);
}
.lb-rank{
  flex:0 0 30px; text-align:center;
  font:800 13px/1 var(--font-ui, sans-serif); color:var(--txt-dim,#9fb3a8);
}
.lb-rank.medal{ font-size:18px; }
.lb-avatar{
  flex:0 0 34px; width:34px; height:34px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  font:800 14px/1 var(--font-ui, sans-serif); color:var(--ink,#0b1410);
  background:linear-gradient(160deg, var(--paper,#f6efdc), var(--paper-2,#e9dec2));
  box-shadow:0 0 0 2px rgba(255,213,79,.45), var(--sh-1, 0 2px 6px rgba(0,0,0,.35));
}
.lb-row.bot .lb-avatar{ background:linear-gradient(160deg,#90a4ae,#607d8b); color:#fff; }
.lb-main{ flex:1 1 auto; min-width:0; }
.lb-name{
  font:700 14px/1.2 var(--font-ui, sans-serif); color:var(--txt,#eaf3ee);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.lb-name .uname{ font-weight:600; font-size:11px; color:var(--txt-dim,#9fb3a8); margin-left:4px; }
.lb-sub{ font:600 11px/1.3 var(--font-ui, sans-serif); color:var(--txt-dim,#9fb3a8); }
.lb-cash{
  flex:0 0 auto; text-align:right;
  font:800 14px/1 var(--font-ui, sans-serif); color:#ffe082;
  background:linear-gradient(180deg, rgba(255,213,79,.16), rgba(255,152,0,.10));
  border:1px solid rgba(255,213,79,.4);
  padding:5px 10px; border-radius:var(--r-pill,999px);
  max-width:38vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.lb-foot{
  flex:0 0 auto; padding:8px 16px 12px; text-align:center;
  font:600 10px/1.3 var(--font-ui, sans-serif); color:var(--txt-dim,#9fb3a8);
  border-top:1px solid var(--line, rgba(255,255,255,.12));
}

/* skeleton / empty / error */
.lb-skel-row{ display:flex; align-items:center; gap:10px; padding:9px 10px; }
.lb-skel{
  border-radius:6px;
  background:linear-gradient(90deg, rgba(255,255,255,.05) 25%, rgba(255,255,255,.12) 37%, rgba(255,255,255,.05) 63%);
  background-size:400% 100%; animation:lbShimmer 1.4s ease infinite;
}
.lb-skel.r{ flex:0 0 30px; height:14px; }
.lb-skel.a{ flex:0 0 34px; height:34px; border-radius:50%; }
.lb-skel.n{ flex:1 1 auto; height:14px; }
.lb-skel.c{ flex:0 0 70px; height:22px; border-radius:999px; }
@keyframes lbShimmer{ 0%{ background-position:100% 0; } 100%{ background-position:0 0; } }
.lb-empty, .lb-error{
  text-align:center; padding:34px 18px; color:var(--txt-dim,#9fb3a8);
}
.lb-empty .ico{ font-size:42px; display:block; margin-bottom:8px; }
.lb-empty b, .lb-error b{ display:block; color:var(--txt,#eaf3ee); font-size:15px; margin-bottom:4px; }
.lb-error .retry{
  margin-top:12px; padding:9px 16px; border-radius:var(--r-pill,999px);
  border:1px solid var(--gold,#ffd54f); background:transparent; color:var(--gold,#ffd54f);
  font:800 13px/1 var(--font-ui, sans-serif); cursor:pointer;
  transition:background var(--t-fast,120ms), color var(--t-fast,120ms);
}
.lb-error .retry:hover{ background:var(--gold,#ffd54f); color:#2a1c00; }

/* trigger (injected) */
#lb-trigger-btn{ width:100%; }
.lb-float{
  position:fixed; right:14px; bottom:14px; z-index:1240;
  display:flex; align-items:center; gap:8px;
  padding:10px 14px; border-radius:var(--r-pill,999px);
  border:1px solid rgba(255,213,79,.5);
  background:linear-gradient(180deg, rgba(8,24,16,.92), rgba(4,14,9,.96));
  color:var(--gold,#ffd54f); font:800 13px/1 var(--font-ui, sans-serif);
  box-shadow:var(--sh-2, 0 8px 22px rgba(0,0,0,.45)); cursor:pointer;
}

@media (prefers-reduced-motion: reduce){
  .lb-modal{ animation:none; }
  .lb-live .dot{ animation:none; }
  .lb-skel{ animation:none; }
}
`;
  document.head.appendChild(style);
}

/* ----------------------------- DOM ------------------------------- */
function ensureTrigger() {
  if (document.getElementById("lb-trigger-btn")) return;
  const btn = el("button", "btn-secondary");
  btn.id = "lb-trigger-btn";
  btn.type = "button";
  btn.textContent = "🏆 Leaderboard";
  btn.addEventListener("click", togglePanel);

  const grid = document.querySelector("#menu-screen .fp-menu-grid");
  if (grid) {
    const after = document.getElementById("show-transaction-history-button");
    if (after && after.parentNode === grid) grid.insertBefore(btn, after.nextSibling);
    else grid.appendChild(btn);
  } else {
    btn.classList.add("lb-float");
    btn.classList.remove("btn-secondary");
    btn.textContent = "🏆 Rankings";
    document.body.appendChild(btn);
  }
}

function ensureDom() {
  if (document.getElementById("leaderboard-panel")) return;
  const overlay = el("div");
  overlay.id = "leaderboard-panel";

  const modal = el("div", "lb-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Leaderboard");

  const head = el("div", "lb-head");
  const title = el("h3", "lb-title", "🏆 Leaderboard");
  const live = el("span", "lb-live");
  live.appendChild(el("span", "dot"));
  live.appendChild(el("span", null, "Top " + LB_LIMIT + " • live"));
  const close = el("button", "lb-close", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Close leaderboard");
  close.addEventListener("click", closePanel);
  head.appendChild(title);
  head.appendChild(live);
  head.appendChild(close);

  const standing = el("div", "lb-standing");
  standing.id = "lb-standing";

  const body = el("div", "lb-body");
  body.id = "lb-body";

  const foot = el("div", "lb-foot", "Ranked by total coins • updates live while open");

  modal.appendChild(head);
  modal.appendChild(standing);
  modal.appendChild(body);
  modal.appendChild(foot);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => { if (e.target === overlay) closePanel(); });
}

/* --------------------------- rendering --------------------------- */
function standingSkeleton() {
  const w = el("div", "lb-standing");
  w.appendChild(el("div", "lb-skel a"));
  const main = el("div", "lb-standing-main");
  main.appendChild(el("div", "lb-skel n"));
  w.appendChild(main);
  w.appendChild(el("div", "lb-skel c"));
  return w;
}

function standingCard() {
  const me = lbState.me;
  const w = el("div", "lb-standing");
  if (!me) {
    const main = el("div", "lb-standing-main");
    main.appendChild(el("div", "lb-standing-name", "Loading your stats…"));
    w.appendChild(el("div", "lb-avatar", "…"));
    w.appendChild(main);
    return w;
  }
  const rank = myRank();
  w.appendChild(el("div", "lb-avatar", initialOf(me)));
  const main = el("div", "lb-standing-main");
  const name = el("div", "lb-standing-name");
  name.textContent = me.displayName || me.username || "You";
  const sub = el("div", "lb-standing-sub", "@" + (me.username || me.id || ""));
  main.appendChild(name);
  main.appendChild(sub);
  const stats = el("div", "lb-standing-stats");
  const sCash = el("span"); sCash.innerHTML = "Coins <b>" + escapeHtml(formatCash(me.cash)) + "</b>";
  const sWins = el("span"); sWins.innerHTML = "Wins <b>" + escapeHtml(String(me.wins || 0)) + "</b>";
  const sPts = el("span"); sPts.innerHTML = "Pts <b>" + escapeHtml(String(me.points || 0)) + "</b>";
  stats.appendChild(sCash); stats.appendChild(sWins); stats.appendChild(sPts);
  main.appendChild(stats);
  w.appendChild(main);

  const rankBox = el("div", "lb-standing-rank");
  const big = el("div", null, rank ? "#" + rank : "—");
  const lab = el("small", null, rank ? "Your rank" : "Top " + LB_LIMIT + "+");
  rankBox.appendChild(big); rankBox.appendChild(lab);
  w.appendChild(rankBox);
  return w;
}

function skelRow() {
  const r = el("div", "lb-skel-row");
  r.appendChild(el("div", "lb-skel r"));
  r.appendChild(el("div", "lb-skel a"));
  r.appendChild(el("div", "lb-skel n"));
  r.appendChild(el("div", "lb-skel c"));
  return r;
}

function rowNode(u, i) {
  const rank = i + 1;
  const row = el("div", "lb-row" + (isMe(u) ? " me" : "") + (u.isBot ? " bot" : ""));
  const rk = el("div", "lb-rank" + (rank <= 3 ? " medal" : ""));
  rk.textContent = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : String(rank);
  row.appendChild(rk);
  row.appendChild(el("div", "lb-avatar", initialOf(u)));

  const main = el("div", "lb-main");
  const name = el("div", "lb-name");
  name.textContent = u.displayName || u.username || u.id || "?";
  if (isMe(u)) {
    const you = el("span", "uname", " (You)");
    name.appendChild(you);
  } else if (u.username && u.username !== (u.displayName || "")) {
    name.appendChild(el("span", "uname", "@" + u.username));
  }
  const sub = el("div", "lb-sub",
    "Wins " + (u.wins || 0) + " • Pts " + (u.points || 0) + " • Games " + (u.games || 0));
  main.appendChild(name);
  main.appendChild(sub);
  row.appendChild(main);

  row.appendChild(el("div", "lb-cash", formatCash(u.cash)));
  return row;
}

function emptyNode() {
  const w = el("div", "lb-empty");
  w.appendChild(el("span", "ico", "🃏"));
  const b = el("b", null, "No players on the board yet");
  const p = el("div", null, "Create a table and be the first name on the leaderboard.");
  w.appendChild(b); w.appendChild(p);
  return w;
}

function errorNode() {
  const w = el("div", "lb-error");
  w.appendChild(el("span", "ico", "⚠️"));
  w.appendChild(el("b", null, "Couldn't load rankings"));
  w.appendChild(el("div", null, lbState.error || "Please try again in a moment."));
  const retry = el("button", "retry", "Retry");
  retry.type = "button";
  retry.addEventListener("click", () => { if (lbState.open) subscribe(); });
  w.appendChild(retry);
  return w;
}

function render() {
  const standing = document.getElementById("lb-standing");
  const body = document.getElementById("lb-body");
  if (!standing || !body) return;
  standing.innerHTML = "";
  body.innerHTML = "";

  if (lbState.error) { body.appendChild(errorNode()); return; }
  if (lbState.loading) {
    standing.appendChild(standingSkeleton());
    for (let i = 0; i < 8; i++) body.appendChild(skelRow());
    return;
  }
  standing.appendChild(standingCard());
  if (!lbState.users.length) { body.appendChild(emptyNode()); return; }
  const frag = document.createDocumentFragment();
  lbState.users.forEach((u, i) => frag.appendChild(rowNode(u, i)));
  body.appendChild(frag);
}

/* --------------------------- listeners --------------------------- */
function unsubscribe() {
  if (lbState.unsubTop) { lbState.unsubTop(); lbState.unsubTop = null; }
  if (lbState.unsubMe) { lbState.unsubMe(); lbState.unsubMe = null; }
}

function subscribe() {
  unsubscribe();
  if (!db || !lbState.user) return;
  lbState.loading = true;
  lbState.error = null;
  render();

  const username = lbState.user.username;

  lbState.unsubTop = onSnapshot(
    query(collection(db, "users"), orderBy("cash", "desc"), limit(LB_LIMIT)),
    (snap) => {
      const users = [];
      snap.forEach((d) => users.push({ id: d.id, ...d.data() }));
      lbState.users = users;
      lbState.loading = false;
      lbState.error = null;
      render();
    },
    (err) => {
      console.error("leaderboard top query failed:", err);
      lbState.loading = false;
      lbState.error = (err && err.code === "permission-denied")
        ? "Permission denied — check Firestore rules for /users."
        : (err && err.message) ? err.message : "Database unavailable.";
      render();
    }
  );

  lbState.unsubMe = onSnapshot(
    doc(db, "users", username),
    (snap) => {
      lbState.me = snap.exists() ? { username, ...snap.data() } : null;
      render();
    },
    () => { /* own-doc errors are non-fatal; list still shows */ }
  );
}

/* ---------------------------- open/close -------------------------- */
function openPanel() {
  ensureDom();
  const overlay = document.getElementById("leaderboard-panel");
  if (!overlay) return;
  lbState.lastFocus = document.activeElement;
  overlay.classList.add("is-open");
  lbState.open = true;
  subscribe();
  const closeBtn = overlay.querySelector(".lb-close");
  if (closeBtn) setTimeout(() => closeBtn.focus(), 0);
}

function closePanel() {
  const overlay = document.getElementById("leaderboard-panel");
  if (overlay) overlay.classList.remove("is-open");
  lbState.open = false;
  unsubscribe();
  if (lbState.lastFocus && lbState.lastFocus.focus) lbState.lastFocus.focus();
}

function togglePanel() { if (lbState.open) closePanel(); else openPanel(); }

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && lbState.open) closePanel();
});

/* ------------------------------ boot ------------------------------ */
watchAuth((user) => {
  lbState.user = user;
  if (!user) { lbState.me = null; lbState.users = []; if (lbState.open) closePanel(); render(); return; }
  if (lbState.open) subscribe();
});

injectLeaderboardStyles();
ensureTrigger();

// Keep the trigger visible only on the menu screen (hide while in a room/admin/login)
setInterval(() => {
  const btn = document.getElementById("lb-trigger-btn");
  if (!btn || btn.classList.contains("lb-float")) return;
  const menu = document.getElementById("menu-screen");
  const onMenu = menu && !menu.classList.contains("hidden");
  btn.style.display = onMenu ? "" : "none";
}, 600);
