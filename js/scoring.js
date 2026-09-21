import {
  compareArrangements,
  getRoyalty,
  isLegalArrangement,
  detectSpecial
} from "./evaluator.js";

function isFouled(handData) {
  if (!handData) return false;
  if (handData.special) return false; // special hands are never fouled
  if (!handData.arrangement) return false;
  if (handData.fouled) return true;
  const arr = handData.arrangement;
  if (
    !Array.isArray(arr.front) || arr.front.length !== 3 ||
    !Array.isArray(arr.middle) || arr.middle.length !== 5 ||
    !Array.isArray(arr.back) || arr.back.length !== 5
  ) {
    return true;
  }
  return !isLegalArrangement(arr);
}

export function calculateResults(room, handsMap) {
  const players = room.players || [];
  const settings = room.settings || {};
  const scoopPoints = settings.scoopBonus ? 9 : 6;
  const minBet = Number(settings.minBet) || 0;

  const matchWins = {};
  const rowWins = {};
  const matchupPoints = {};
  const scoopCount = {};
  const royaltyTotal = {};
  const fouledMap = {};
  const details = {};
  const specials = {};
  const botNetMap = {};
  const humanNetMap = {};

  players.forEach((p) => {
    matchWins[p.uid] = 0;
    rowWins[p.uid] = 0;
    matchupPoints[p.uid] = 0;
    scoopCount[p.uid] = 0;
    royaltyTotal[p.uid] = 0;
    details[p.uid] = [];
    botNetMap[p.uid] = 0;
    humanNetMap[p.uid] = 0;

    const hd = handsMap[p.uid];
    let spec = hd && hd.special ? hd.special : null;
    if (!spec && hd && hd.hand) spec = detectSpecial(hd.hand);
    specials[p.uid] = spec;
    fouledMap[p.uid] = spec ? false : isFouled(hd);
  });

  players.forEach((p) => {
    const hd = handsMap[p.uid];
    const canEarnRoyalty =
      !fouledMap[p.uid] && !specials[p.uid] && hd && hd.arrangement;
    royaltyTotal[p.uid] = canEarnRoyalty ? getRoyalty(hd.arrangement).total : 0;
  });

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const p1 = players[i];
      const p2 = players[j];
      const h1 = handsMap[p1.uid];
      const h2 = handsMap[p2.uid];
      if (!h1 || !h2) continue;

      const f1 = fouledMap[p1.uid];
      const f2 = fouledMap[p2.uid];
      const sp1 = specials[p1.uid];
      const sp2 = specials[p2.uid];

      let pts1 = 0;
      let pts2 = 0;

      if (sp1 || sp2) {
        if (sp1 && sp2) {
          if (sp1.tier > sp2.tier) {
            matchWins[p1.uid] += 1;
            pts1 = sp1.points; pts2 = -sp1.points;
            details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: 1, middle: 1, back: 1 }, matchResult: "win", special: sp1.name, opponentSpecial: sp2.name, points: pts1, royaltyEarned: 0, royaltyLost: 0, scoop: false });
            details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: -1, middle: -1, back: -1 }, matchResult: "lose", special: sp2.name, opponentSpecial: sp1.name, points: pts2, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          } else if (sp2.tier > sp1.tier) {
            matchWins[p2.uid] += 1;
            pts2 = sp2.points; pts1 = -sp2.points;
            details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: -1, middle: -1, back: -1 }, matchResult: "lose", special: sp1.name, opponentSpecial: sp2.name, points: pts1, royaltyEarned: 0, royaltyLost: 0, scoop: false });
            details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: 1, middle: 1, back: 1 }, matchResult: "win", special: sp2.name, opponentSpecial: sp1.name, points: pts2, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          } else {
            details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: 0, middle: 0, back: 0 }, matchResult: "tie", special: sp1.name, opponentSpecial: sp2.name, points: 0, royaltyEarned: 0, royaltyLost: 0, scoop: false });
            details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: 0, middle: 0, back: 0 }, matchResult: "tie", special: sp2.name, opponentSpecial: sp1.name, points: 0, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          }
        } else if (sp1) {
          matchWins[p1.uid] += 1;
          pts1 = sp1.points; pts2 = -sp1.points;
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: 1, middle: 1, back: 1 }, matchResult: "win", special: sp1.name, points: pts1, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: -1, middle: -1, back: -1 }, matchResult: "lose", opponentSpecial: sp1.name, points: pts2, royaltyEarned: 0, royaltyLost: 0, scoop: false });
        } else {
          matchWins[p2.uid] += 1;
          pts2 = sp2.points; pts1 = -sp2.points;
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: 1, middle: 1, back: 1 }, matchResult: "win", special: sp2.name, points: pts2, royaltyEarned: 0, royaltyLost: 0, scoop: false });
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: -1, middle: -1, back: -1 }, matchResult: "lose", opponentSpecial: sp2.name, points: pts1, royaltyEarned: 0, royaltyLost: 0, scoop: false });
        }
      } else if (f1 || f2) {
        if (f1 && !f2) {
          matchWins[p2.uid] += 1;
          scoopCount[p2.uid] += 1;
          pts2 = scoopPoints; pts1 = -scoopPoints;
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: -1, middle: -1, back: -1 }, matchResult: "lose", foul: true, scoop: false, points: pts1, royaltyEarned: 0, royaltyLost: royaltyTotal[p2.uid] });
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: 1, middle: 1, back: 1 }, matchResult: "win", opponentFoul: true, scoop: true, points: pts2, royaltyEarned: royaltyTotal[p2.uid], royaltyLost: 0 });
        } else if (f2 && !f1) {
          matchWins[p1.uid] += 1;
          scoopCount[p1.uid] += 1;
          pts1 = scoopPoints; pts2 = -scoopPoints;
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: 1, middle: 1, back: 1 }, matchResult: "win", opponentFoul: true, scoop: true, points: pts1, royaltyEarned: royaltyTotal[p1.uid], royaltyLost: 0 });
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: -1, middle: -1, back: -1 }, matchResult: "lose", foul: true, scoop: false, points: pts2, royaltyEarned: 0, royaltyLost: royaltyTotal[p1.uid] });
        } else {
          details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: { front: 0, middle: 0, back: 0 }, matchResult: "tie", foul: true, scoop: false, points: 0, royaltyEarned: 0, royaltyLost: 0 });
          details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: { front: 0, middle: 0, back: 0 }, matchResult: "tie", foul: true, scoop: false, points: 0, royaltyEarned: 0, royaltyLost: 0 });
        }
      } else {
        const comparison = compareArrangements(h1.arrangement, h2.arrangement);
        const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
        const rowsOne = {
          front: sign(comparison.front),
          middle: sign(comparison.middle),
          back: sign(comparison.back)
        };
        const rowsTwo = {
          front: -rowsOne.front,
          middle: -rowsOne.middle,
          back: -rowsOne.back
        };
        const countWins = (rows) => Object.values(rows).filter((v) => v === 1).length;
        const w1 = countWins(rowsOne);
        const w2 = countWins(rowsTwo);
        const scoop1 = w1 === 3;
        const scoop2 = w2 === 3;

        pts1 = w1 - w2;
        pts2 = w2 - w1;
        if (scoop1) { pts1 = scoopPoints; pts2 = -scoopPoints; }
        else if (scoop2) { pts2 = scoopPoints; pts1 = -scoopPoints; }

        if (w1 > w2) { matchWins[p1.uid] += 1; if (scoop1) scoopCount[p1.uid] += 1; }
        else if (w2 > w1) { matchWins[p2.uid] += 1; if (scoop2) scoopCount[p2.uid] += 1; }
        rowWins[p1.uid] += w1;
        rowWins[p2.uid] += w2;

        details[p1.uid].push({ opponentUid: p2.uid, opponentName: p2.displayName, rows: rowsOne, matchResult: w1 > w2 ? "win" : w2 > w1 ? "lose" : "tie", scoop: scoop1, points: pts1, royaltyEarned: royaltyTotal[p1.uid], royaltyLost: royaltyTotal[p2.uid] });
        details[p2.uid].push({ opponentUid: p1.uid, opponentName: p1.displayName, rows: rowsTwo, matchResult: w2 > w1 ? "win" : w1 > w2 ? "lose" : "tie", scoop: scoop2, points: pts2, royaltyEarned: royaltyTotal[p2.uid], royaltyLost: royaltyTotal[p1.uid] });
      }

      matchupPoints[p1.uid] += pts1;
      matchupPoints[p2.uid] += pts2;

      // ---- coin attribution: bots vs humans (feeds the House Pot) ----
      const coins1 = pts1 * minBet;
      const coins2 = pts2 * minBet;
      if (!p1.isBot) {
        if (p2.isBot) botNetMap[p1.uid] += coins1;
        else humanNetMap[p1.uid] += coins1;
      }
      if (!p2.isBot) {
        if (p1.isBot) botNetMap[p2.uid] += coins2;
        else humanNetMap[p2.uid] += coins2;
      }
    }
  }

  const numOpponents = Math.max(0, players.length - 1);

  const rankings = players.map((player) => {
    const fouled = fouledMap[player.uid];
    const special = specials[player.uid] || null;

    const royaltyIncome =
      (fouled || special) ? 0 : royaltyTotal[player.uid] * numOpponents;

    let royaltyPaid = 0;
    players.forEach((opp) => {
      if (opp.uid === player.uid) return;
      if (fouledMap[opp.uid] || specials[opp.uid]) return;
      royaltyPaid += royaltyTotal[opp.uid];
    });

    let scorePoints =
      matchupPoints[player.uid] + royaltyIncome - royaltyPaid;

    if (fouled) {
      scorePoints = matchupPoints[player.uid] - royaltyPaid;
      if (scorePoints > 0) {
        console.warn("Clamping impossible positive foul score:", player.uid);
        scorePoints = -scoopPoints * numOpponents;
      }
    }

    return {
      uid: player.uid,
      username: player.username,
      displayName: player.displayName,
      isBot: Boolean(player.isBot),
      points: scorePoints,
      scorePoints,
      matchWins: matchWins[player.uid] || 0,
      rowWins: rowWins[player.uid] || 0,
      scoops: scoopCount[player.uid] || 0,
      royalties: royaltyTotal[player.uid] || 0,
      bet: 0,
      prize: 0,
      net: 0,
      netCoins: 0,
      botNetCoins: botNetMap[player.uid] || 0,
      humanNetCoins: humanNetMap[player.uid] || 0,
      humanRank: null,
      overallRank: null,
      fouled,
      special
    };
  });

  rankings.sort(
    (a, b) =>
      b.scorePoints - a.scorePoints ||
      b.matchWins - a.matchWins ||
      b.rowWins - a.rowWins ||
      a.displayName.localeCompare(b.displayName)
  );
  rankings.forEach((r, idx) => { r.overallRank = idx + 1; });

  let humanRank = 0;
  rankings.forEach((r) => {
    if (!r.isBot) { humanRank += 1; r.humanRank = humanRank; }
  });

  rankings.forEach((r) => {
    r.netCoins = r.scorePoints * minBet;
    r.net = r.netCoins;
  });

  const arrangements = {};
  players.forEach((p) => {
    const hd = handsMap[p.uid];
    arrangements[p.uid] = hd && hd.arrangement ? hd.arrangement : null;
  });

  return {
    roundNumber: room.roundNumber,
    pot: 0,
    minBet,
    pointValue: minBet,
    rankings,
    details,
    arrangements,
    specials,
    calculatedAt: Date.now()
  };
}
