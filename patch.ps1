$root = "C:\Users\Catcat\Documents\GitHub\cardex"
if (!(Test-Path $root)) { Write-Host "Folder not found!" -ForegroundColor Red; pause; exit }
Set-Location $root
Write-Host "Applying safe Cardex patches..." -ForegroundColor Cyan

# ==========================================
# 1. PATCH index.html
# ==========================================
$html = Get-Content "index.html" -Raw -Encoding UTF8
if ($html -notmatch 'show-transaction-history-button') {
    $txHtml = @"

<!-- Transaction History Panel -->
<button id="show-transaction-history-button" class="btn btn-ghost btn-block">📊 Transaction History</button>
<div id="transaction-history-panel" class="hidden fp-subpanel">
  <div class="fp-subpanel-head">
    <h3>Recent Transactions</h3>
    <button id="close-transaction-history-button" class="pg-btn">Close</button>
  </div>
  <div id="transaction-history" class="tx-list"></div>
</div>

"@
    # Safely insert right before the room screen starts
    $html = $html.Replace('<section id="room-screen"', "$txHtml<section id=`"room-screen`"")
    Set-Content "index.html" $html -Encoding UTF8
    Write-Host "[1/4] index.html patched successfully." -ForegroundColor Green
} else {
    Write-Host "[1/4] index.html already has Transaction History." -ForegroundColor Yellow
}

# ==========================================
# 2. PATCH style.css
# ==========================================
$css = Get-Content "style.css" -Raw -Encoding UTF8
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
    Add-Content "style.css" $cssPatch -Encoding UTF8
    Write-Host "[2/4] style.css patched successfully." -ForegroundColor Green
} else {
    Write-Host "[2/4] style.css already has Transaction History styles." -ForegroundColor Yellow
}

# ==========================================
# 3. PATCH js\db.js
# ==========================================
$db = Get-Content "js\db.js" -Raw -Encoding UTF8
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
    Add-Content "js\db.js" $dbPatch -Encoding UTF8
    Write-Host "[3/4] js\db.js patched successfully." -ForegroundColor Green
} else {
    Write-Host "[3/4] js\db.js already has listener." -ForegroundColor Yellow
}

# ==========================================
# 4. PATCH js\app.js
# ==========================================
$app = Get-Content "js\app.js" -Raw -Encoding UTF8
if ($app -notmatch 'renderTransactionHistory') {
    
    # Add import to top
    if ($app -notmatch 'import \{ listenUserTransactions \}') {
        $app = "import { listenUserTransactions } from ""./db.js"";`r`n" + $app
    }

    # Add state fields
    if ($app -notmatch 'transactions: \[\]') {
        $app = $app -replace 'coinsFlyedFor: null,', 'coinsFlyedFor: null, transactions: [], unsubTransactions: null,'
    }

    # Append logic
    $jsPatch = @"

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
    $app += $jsPatch
    Set-Content "js\app.js" $app -Encoding UTF8
    Write-Host "[4/4] js\app.js patched successfully." -ForegroundColor Green
} else {
    Write-Host "[4/4] js\app.js already has Transaction History logic." -ForegroundColor Yellow
}

Write-Host "`nAll patches verified and applied!" -ForegroundColor Cyan
pause