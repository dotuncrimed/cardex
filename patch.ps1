$root = "C:\Users\Catcat\Documents\GitHub\cardex"
if (!(Test-Path $root)) { Write-Host "Folder not found!" -ForegroundColor Red; pause; exit }
Set-Location $root

Write-Host "Applying final Cardex patches..." -ForegroundColor Cyan

# --- 1. CSS Patch ---
$css = Get-Content "$root\style.css" -Raw -Encoding UTF8
if ($css -notmatch '\.tx-list') {
$cssPatch = @"

/* === Transaction History Styles === */
.fp-subpanel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.fp-subpanel-head h3 { margin: 0; font-size: 16px; }
.tx-list { display: flex; flex-direction: column; gap: 8px; max-height: 360px; overflow: auto; padding-right: 4px; }
.tx-row { display: flex; align-items: center; gap: 12px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 10px 12px; }
.tx-icon { width: 38px; height: 38px; border-radius: 50%; background: rgba(255, 213, 79, 0.15); display: flex; align-items: center; justify-content: center; font-size: 18px; }
.tx-body { flex: 1; min-width: 0; }
.tx-label { font-weight: 700; font-size: 14px; color: #fff; }
.tx-detail { font-size: 12px; color: rgba(255, 255, 255, 0.7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx-time { font-size: 11px; color: rgba(255, 255, 255, 0.45); margin-top: 2px; }
.tx-amount { font-weight: 900; font-size: 15px; }
.tx-pos { color: #7cffb2; }
.tx-neg { color: #ff8a80; }
.tx-empty { text-align: center; color: rgba(255, 255, 255, 0.5); font-size: 13px; padding: 20px 0; }
"@
    Add-Content "$root\style.css" $cssPatch -Encoding UTF8
    Write-Host "[1/3] style.css patched" -ForegroundColor Green
} else { Write-Host "[1/3] style.css already updated" -ForegroundColor Yellow }

# --- 2. DB Patch ---
$db = Get-Content "$root\js\db.js" -Raw -Encoding UTF8
if ($db -notmatch 'listenUserTransactions') {
$dbPatch = @"

export function listenUserTransactions(username, callback) {
  const q = query(collection(db, "users", username, "transactions"), orderBy("createdAt", "desc"), limit(30));
  return onSnapshot(q, (snapshot) => {
    const txs = [];
    snapshot.forEach((docSnap) => { txs.push({ id: docSnap.id, ...docSnap.data() }); });
    callback(txs);
  });
}
"@
    Add-Content "$root\js\db.js" $dbPatch -Encoding UTF8
    Write-Host "[2/3] js/db.js patched" -ForegroundColor Green
} else { Write-Host "[2/3] js/db.js already updated" -ForegroundColor Yellow }

# --- 3. APP Patch (Logic + Spectator Fix) ---
$app = Get-Content "$root\js\app.js" -Raw -Encoding UTF8
$changed = $false

if ($app -notmatch 'listenUserTransactions') {
    $app = "import { listenUserTransactions } from ""./db.js"";`r`n" + $app
    $changed = $true
}

if ($app -notmatch 'unsubTransactions') {
    $app = $app.Replace('coinsFlyedFor: null,', "coinsFlyedFor: null,`r`n  transactions: [],`r`n  unsubTransactions: null,")
    $changed = $true
}

# Fix Spectator Bug
if ($app -notmatch 'currentUserInRoomPlayers\(\)') {
    $app = $app.Replace('["arranging", "scoring"].includes(state.room.status)', '["arranging", "scoring"].includes(state.room.status) && currentUserInRoomPlayers()')
    $changed = $true
}

if ($app -notmatch 'renderTransactionHistory') {
$appPatch = @"

// === Transaction History Logic ===
setInterval(() => {
  if (state.user && !state.unsubTransactions) {
    state.unsubTransactions = listenUserTransactions(state.user.username, (txs) => {
      state.transactions = txs;
      if (typeof renderTransactionHistory === 'function') renderTransactionHistory();
    });
  }
}, 1000);

function renderTransactionHistory() {
  const list = document.getElementById("transaction-history");
  if (!list) return;
  list.innerHTML = "";
  if (!state.transactions || state.transactions.length === 0) {
    list.innerHTML = '<div class="tx-empty">No transactions yet.</div>'; return;
  }
  state.transactions.forEach((tx) => {
    const row = document.createElement("div"); row.className = "tx-row";
    let icon = "💰", label = "Transaction", detail = "", amountClass = "tx-pos";
    if (tx.type === "daily_bonus") { icon = "🎁"; label = "Daily Bonus"; detail = "Login reward"; }
    else if (tx.type === "transfer_in") { icon = "📥"; label = "Received"; detail = "From @" + (tx.from || "?"); }
    else if (tx.type === "transfer_out") { icon = "📤"; label = "Sent"; detail = "To @" + (tx.to || "?"); amountClass = "tx-neg"; }
    else if (tx.type === "game_settle") { icon = "🎮"; label = "Game"; detail = tx.note || "Settlement"; if (tx.amount < 0) amountClass = "tx-neg"; }
    else if (tx.type === "room_entry") { icon = "🎟️"; label = "Room Entry"; amountClass = "tx-neg"; }
    else if (tx.type === "game_win") { icon = "🏆"; label = "Game Win"; }
    else { label = tx.type || "Transaction"; if (tx.amount < 0) amountClass = "tx-neg"; }
    
    const amount = Number(tx.amount) || 0;
    const amountStr = (amount >= 0 ? "+" : "") + formatCash(amount);
    const time = new Date(tx.createdAt || Date.now()).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    
    row.innerHTML = '<div class="tx-icon">' + icon + '</div><div class="tx-body"><div class="tx-label">' + label + '</div><div class="tx-detail">' + detail + '</div><div class="tx-time">' + time + '</div></div><div class="tx-amount ' + amountClass + '">' + amountStr + '</div>';
    list.appendChild(row);
  });
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#show-transaction-history-button")) {
    document.getElementById("transaction-history-panel").classList.remove("hidden");
    renderTransactionHistory();
  }
  if (e.target.closest("#close-transaction-history-button")) {
    document.getElementById("transaction-history-panel").classList.add("hidden");
  }
});
"@
    $app += "`r`n" + $appPatch
    $changed = $true
}

if ($changed) {
    Set-Content "$root\js\app.js" $app -Encoding UTF8
    Write-Host "[3/3] js/app.js patched & spectator bug fixed!" -ForegroundColor Green
} else {
    Write-Host "[3/3] js/app.js already updated" -ForegroundColor Yellow
}

Write-Host "`nAll patches applied successfully!" -ForegroundColor Cyan
Write-Host "Now run: git add . -> git commit -m ""tx history"" -> git push" -ForegroundColor Yellow
pause