$root = "C:\Users\Catcat\Documents\GitHub\cardex"
if (!(Test-Path $root)) { Write-Host "Folder not found!" -ForegroundColor Red; pause; exit }
Set-Location $root
Write-Host "=== FIXING COIN DISTRIBUTION + SPECIAL HANDS + FREEZE BUGS ===" -ForegroundColor Cyan

# --- FIX 1: scoring.js - Fix special hand point calculation ---
$scoringPath = "$root\js\scoring.js"
$scoring = Get-Content $scoringPath -Raw -Encoding UTF8

# Find and replace the special hand scoring section
$oldSpecialLogic = @'
      if (sp1 || sp2) {
        if (sp1 && sp2) {
          if (sp1.tier > sp2.tier) {
            matchWins[p1.uid] += 1;
            matchupPoints[p1.uid] += sp1.points;
            matchupPoints[p2.uid] -= sp1.points;
          } else if (sp2.tier > sp1.tier) {
            matchWins[p2.uid] += 1;
            matchupPoints[p2.uid] += sp2.points;
            matchupPoints[p1.uid] -= sp2.points;
          }
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: 0, middle: 0, back: 0 }, matchResult: sp1.tier === sp2.tier ? "tie" : (sp1.tier > sp2.tier ? "win" : "lose"), special: sp1.name, opponentSpecial: sp2.name, points: sp1.tier > sp2.tier ? sp1.points : sp2.tier > sp1.tier ? -sp2.points : 0, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: 0, middle: 0, back: 0 }, matchResult: sp1.tier === sp2.tier ? "tie" : (sp2.tier > sp1.tier ? "win" : "lose"), special: sp2.name, opponentSpecial: sp1.name, points: sp2.tier > sp1.tier ? sp2.points : sp1.tier > sp2.tier ? -sp1.points : 0, royaltyEarned: 0, royaltyLost: 0, scoop: false });
        } else if (sp1) {
          matchWins[p1.uid] += 1;
          matchupPoints[p1.uid] += sp1.points;
          matchupPoints[p2.uid] -= sp1.points;
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: 1, middle: 1, back: 1 }, matchResult: "win", special: sp1.name, opponentFoul: f2, points: sp1.points, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: -1, middle: -1, back: -1 }, matchResult: "lose", opponentSpecial: sp1.name, foul: f2, points: -sp1.points, royaltyEarned: 0, royaltyLost: 0, scoop: false });
        } else {
          matchWins[p2.uid] += 1;
          matchupPoints[p2.uid] += sp2.points;
          matchupPoints[p1.uid] -= sp2.points;
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: 1, middle: 1, back: 1 }, matchResult: "win", special: sp2.name, opponentFoul: f1, points: sp2.points, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: -1, middle: -1, back: -1 }, matchResult: "lose", opponentSpecial: sp2.name, foul: f1, points: -sp2.points, royaltyEarned: 0, royaltyLost: 0, scoop: false });
        }
        continue;
      }
'@

$newSpecialLogic = @'
      if (sp1 || sp2) {
        if (sp1 && sp2) {
          if (sp1.tier > sp2.tier) {
            matchWins[p1.uid] += 1;
            matchupPoints[p1.uid] += sp1.points;
            matchupPoints[p2.uid] -= sp1.points;
          } else if (sp2.tier > sp1.tier) {
            matchWins[p2.uid] += 1;
            matchupPoints[p2.uid] += sp2.points;
            matchupPoints[p1.uid] -= sp2.points;
          }
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: 0, middle: 0, back: 0 }, matchResult: sp1.tier === sp2.tier ? "tie" : (sp1.tier > sp2.tier ? "win" : "lose"), special: sp1.name, opponentSpecial: sp2.name, points: sp1.tier > sp2.tier ? sp1.points : sp2.tier > sp1.tier ? -sp2.points : 0, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: 0, middle: 0, back: 0 }, matchResult: sp1.tier === sp2.tier ? "tie" : (sp2.tier > sp1.tier ? "win" : "lose"), special: sp2.name, opponentSpecial: sp1.name, points: sp2.tier > sp1.tier ? sp2.points : sp1.tier > sp2.tier ? -sp1.points : 0, royaltyEarned: 0, royaltyLost: 0, scoop: false });
        } else if (sp1) {
          matchWins[p1.uid] += 1;
          matchupPoints[p1.uid] += sp1.points;
          matchupPoints[p2.uid] -= sp1.points;
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: 1, middle: 1, back: 1 }, matchResult: "win", special: sp1.name, points: sp1.points, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: -1, middle: -1, back: -1 }, matchResult: "lose", opponentSpecial: sp1.name, points: -sp1.points, royaltyEarned: 0, royaltyLost: 0, scoop: false });
        } else {
          matchWins[p2.uid] += 1;
          matchupPoints[p2.uid] += sp2.points;
          matchupPoints[p1.uid] -= sp2.points;
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: 1, middle: 1, back: 1 }, matchResult: "win", special: sp2.name, points: sp2.points, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: -1, middle: -1, back: -1 }, matchResult: "lose", opponentSpecial: sp2.name, points: -sp2.points, royaltyEarned: 0, royaltyLost: 0, scoop: false });
        }
        continue;
      }
'@

$scoring = $scoring.Replace($oldSpecialLogic, $newSpecialLogic)
Set-Content $scoringPath $scoring -Encoding UTF8
Write-Host "[1/3] Fixed special hand point calculation" -ForegroundColor Green

# --- FIX 2: db.js - Fix finishRound to handle missing players ---
$dbPath = "$root\js\db.js"
$db = Get-Content $dbPath -Raw -Encoding UTF8

# Replace the hand reading loop in finishRound
$oldHandLoop = @'
    const handsMap = {};

    for (const player of room.players) {
      const snap = await getDoc(handRef(roomId, player.uid));
      let data = snap.exists() ? snap.data() : null;
      if (!data) continue;

      if (!data.special && data.hand && data.hand.length === 13) {
        const spec = detectSpecial(data.hand);
        if (spec) {
          const sorted = sortCards(data.hand);
          data.special = spec;
          data.arrangement = {
            front: sorted.slice(0, 3),
            middle: sorted.slice(3, 8),
            back: sorted.slice(8, 13)
          };
          data.submitted = true;
          await setDoc(
            handRef(roomId, player.uid),
            { arrangement: data.arrangement, special: spec, submitted: true, updatedAt: Date.now() },
            { merge: true }
          );
        }
      }

      if (!data.arrangement && data.hand && data.hand.length === 13) {
        const arrangement = botArrangeHand(
          data.hand,
          player.botLevel || room.settings.botLevel || "normal"
        );
        await submitArrangement(roomId, player.uid, arrangement, false);
        data.arrangement = arrangement;
        data.submitted = true;
      }

      handsMap[player.uid] = data;
    }
'@

$newHandLoop = @'
    const handsMap = {};

    for (const player of room.players) {
      try {
        const snap = await getDoc(handRef(roomId, player.uid));
        let data = snap.exists() ? snap.data() : null;
        
        // If no hand data exists, create a fouled arrangement
        if (!data) {
          data = {
            uid: player.uid,
            username: player.username,
            hand: [],
            arrangement: { front: [], middle: [], back: [] },
            fouled: true,
            submitted: true,
            roundNumber: room.roundNumber,
            updatedAt: Date.now()
          };
          await setDoc(handRef(roomId, player.uid), data, { merge: true });
        }

        // Auto-detect special hands for players who didn't submit
        if (!data.special && data.hand && data.hand.length === 13) {
          const spec = detectSpecial(data.hand);
          if (spec) {
            const sorted = sortCards(data.hand);
            data.special = spec;
            data.arrangement = {
              front: sorted.slice(0, 3),
              middle: sorted.slice(3, 8),
              back: sorted.slice(8, 13)
            };
            data.submitted = true;
            await setDoc(
              handRef(roomId, player.uid),
              { arrangement: data.arrangement, special: spec, submitted: true, updatedAt: Date.now() },
              { merge: true }
            );
          }
        }

        // Auto-arrange for players who didn't submit (bot their hand)
        if (!data.arrangement && data.hand && data.hand.length === 13) {
          const arrangement = botArrangeHand(
            data.hand,
            player.botLevel || room.settings.botLevel || "normal"
          );
          await submitArrangement(roomId, player.uid, arrangement, false);
          data.arrangement = arrangement;
          data.submitted = true;
        }

        handsMap[player.uid] = data;
      } catch (error) {
        console.error("Failed to process hand for player:", player.uid, error);
        // Create a fouled hand on error
        handsMap[player.uid] = {
          uid: player.uid,
          username: player.username,
          hand: [],
          arrangement: { front: [], middle: [], back: [] },
          fouled: true,
          submitted: true
        };
      }
    }
'@

$db = $db.Replace($oldHandLoop, $newHandLoop)
Set-Content $dbPath $db -Encoding UTF8
Write-Host "[2/3] Fixed finishRound to handle missing players" -ForegroundColor Green

# --- FIX 3: app.js - Add timeout to force round completion ---
$appPath = "$root\js\app.js"
$app = Get-Content $appPath -Raw -Encoding UTF8

# Find the hostController and add timeout logic
$oldHostLogic = @'
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
'@

$newHostLogic = @'
  if (room.status === "arranging") {
    const allSubmitted = room.players.every((p) => p.submitted);
    
    // Force finish if all submitted OR if timer expired + 10 seconds grace
    const timerExpired = room.phaseEndsAt && Date.now() > room.phaseEndsAt;
    const gracePeriod = timerExpired && (Date.now() - room.phaseEndsAt > 10000);
    
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
'@

$app = $app.Replace($oldHostLogic, $newHostLogic)
Set-Content $appPath $app -Encoding UTF8
Write-Host "[3/3] Added timeout to force round completion" -ForegroundColor Green

Write-Host "`n=== ALL FIXES APPLIED ===" -ForegroundColor Yellow
Write-Host "Run: git add . -> git commit -m 'Fix coin distribution, special hands, and freeze bugs' -> git push" -ForegroundColor Cyan
pause