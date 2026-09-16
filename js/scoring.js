import { compareArrangements, getRoyalty, isLegalArrangement } from "./evaluator.js";

function isFouled(handData) {
  if (!handData || !handData.arrangement) return false;
  if (handData.fouled) return true;
  
  // Double-check legality as backup
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
  const players = room.players;

  const matchWins = {};
  const rowWins = {};
  const matchupPoints = {};
  const scoopCount = {};
  const royaltyTotal = {};
  const fouledMap = {};
  const details = {};

  players.forEach((p) => {
    matchWins[p.uid] = 0;
    rowWins[p.uid] = 0;
    matchupPoints[p.uid] = 0;
    scoopCount[p.uid] = 0;
    fouledMap[p.uid] = isFouled(handsMap[p.uid]);
    const arr = !fouledMap[p.uid] && handsMap[p.uid]
      ? handsMap[p.uid].arrangement
      : null;
    royaltyTotal[p.uid] = arr ? getRoyalty(arr).total : 0;
    details[p.uid] = [];
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

      if (f1 || f2) {
        if (f1 && !f2) {
          matchWins[p2.uid] += 1;
          scoopCount[p2.uid] += 1;
          matchupPoints[p2.uid] += 6;
          matchupPoints[p1.uid] -= 6;
          details[p1.uid].push({
            opponentUid: p2.uid, opponentName: p2.displayName,
            rows: { front: -1, middle: -1, back: -1 },
            matchResult: "lose", foul: true, scoop: false,
            points: -6,
            royaltyEarned: 0, royaltyLost: royaltyTotal[p2.uid]
          });
          details[p2.uid].push({
            opponentUid: p1.uid, opponentName: p1.displayName,
            rows: { front: 1, middle: 1, back: 1 },
            matchResult: "win", opponentFoul: true, scoop: true,
            points: 6,
            royaltyEarned: royaltyTotal[p2.uid], royaltyLost: 0
          });
        } else if (f2 && !f1) {
          matchWins[p1.uid] += 1;
          scoopCount[p1.uid] += 1;
          matchupPoints[p1.uid] += 6;
          matchupPoints[p2.uid] -= 6;
          details[p1.uid].push({
            opponentUid: p2.uid, opponentName: p2.displayName,
            rows: { front: 1, middle: 1, back: 1 },
            matchResult: "win", opponentFoul: true, scoop: true,
            points: 6,
            royaltyEarned: royaltyTotal[p1.uid], royaltyLost: 0
          });
          details[p2.uid].push({
            opponentUid: p1.uid, opponentName: p1.displayName,
            rows: { front: -1, middle: -1, back: -1 },
            matchResult: "lose", foul: true, scoop: false,
            points: -6,
            royaltyEarned: 0, royaltyLost: royaltyTotal[p1.uid]
          });
        } else {
          details[p1.uid].push({
            opponentUid: p2.uid, opponentName: p2.displayName,
            rows: { front: 0, middle: 0, back: 0 },
            matchResult: "tie", foul: true, scoop: false, points: 0,
            royaltyEarned: 0, royaltyLost: 0
          });
          details[p2.uid].push({
            opponentUid: p1.uid, opponentName: p1.displayName,
            rows: { front: 0, middle: 0, back: 0 },
            matchResult: "tie", foul: true, scoop: false, points: 0,
            royaltyEarned: 0, royaltyLost: 0
          });
        }
        continue;
      }

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

      const countWins = (rows) =>
        Object.values(rows).filter((v) => v === 1).length;

      const w1 = countWins(rowsOne);
      const w2 = countWins(rowsTwo);
      const scoop1 = w1 === 3;
      const scoop2 = w2 === 3;

      let pts1 = w1 - w2;
      let pts2 = w2 - w1;
      if (scoop1) { pts1 = 6; pts2 = -6; }
      else if (scoop2) { pts2 = 6; pts1 = -6; }

      matchupPoints[p1.uid] += pts1;
      matchupPoints[p2.uid] += pts2;

      if (w1 > w2) { matchWins[p1.uid] += 1; if (scoop1) scoopCount[p1.uid] += 1; }
      else if (w2 > w1) { matchWins[p2.uid] += 1; if (scoop2) scoopCount[p2.uid] += 1; }

      rowWins[p1.uid] += w1;
      rowWins[p2.uid] += w2;

      details[p1.uid].push({
        opponentUid: p2.uid, opponentName: p2.displayName,
        rows: rowsOne,
        matchResult: w1 > w2 ? "win" : w2 > w1 ? "lose" : "tie",
        scoop: scoop1, points: pts1,
        royaltyEarned: royaltyTotal[p1.uid],
        royaltyLost: royaltyTotal[p2.uid]
      });
      details[p2.uid].push({
        opponentUid: p1.uid, opponentName: p1.displayName,
        rows: rowsTwo,
        matchResult: w2 > w1 ? "win" : w1 > w2 ? "lose" : "tie",
        scoop: scoop2, points: pts2,
        royaltyEarned: royaltyTotal[p2.uid],
        royaltyLost: royaltyTotal[p1.uid]
      });
    }
  }

  const numOpponents = players.length - 1;

  const rankings = players.map((player) => {
    const fouled = fouledMap[player.uid];
    const royaltyIncome = fouled ? 0 : royaltyTotal[player.uid] * numOpponents;
    let royaltyPaid = 0;
    players.forEach((opp) => {
      if (opp.uid !== player.uid && !fouledMap[opp.uid]) {
        royaltyPaid += royaltyTotal[opp.uid];
      }
    });
    const scorePoints =
      matchupPoints[player.uid] + royaltyIncome - royaltyPaid;

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
      humanRank: null,
      overallRank: null,
      fouled
    };
  });

  rankings.sort((a, b) =>
    b.scorePoints - a.scorePoints ||
    b.matchWins - a.matchWins ||
    a.displayName.localeCompare(b.displayName)
  );

  rankings.forEach((r, idx) => { r.overallRank = idx + 1; });

  let humanRank = 0;
  rankings.forEach((r) => {
    if (!r.isBot) { humanRank += 1; r.humanRank = humanRank; }
  });

  const minBet = Number(room.settings.minBet) || 0;
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
    calculatedAt: Date.now()
  };
}
