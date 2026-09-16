import { compareArrangements, isLegalArrangement } from "./evaluator.js";

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
  const details = {};

  players.forEach((player) => {
    matchWins[player.uid] = 0;
    rowWins[player.uid] = 0;
    details[player.uid] = [];
  });

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const playerOne = players[i];
      const playerTwo = players[j];

      const handOne = handsMap[playerOne.uid];
      const handTwo = handsMap[playerTwo.uid];

      if (!handOne || !handTwo) {
        continue;
      }

      if (!handOne.arrangement || !handTwo.arrangement) {
        continue;
      }

      const foulOne = isFouled(handOne);
      const foulTwo = isFouled(handTwo);

      if (foulOne || foulTwo) {
        // Fouled player(s) auto-lose
        if (foulOne && !foulTwo) {
          matchWins[playerTwo.uid] += 1;
          details[playerOne.uid].push({
            opponentUid: playerTwo.uid,
            opponentName: playerTwo.displayName,
            rows: { front: -1, middle: -1, back: -1 },
            matchResult: "lose",
            foul: true
          });
          details[playerTwo.uid].push({
            opponentUid: playerOne.uid,
            opponentName: playerOne.displayName,
            rows: { front: 1, middle: 1, back: 1 },
            matchResult: "win",
            opponentFoul: true
          });
        } else if (foulTwo && !foulOne) {
          matchWins[playerOne.uid] += 1;
          details[playerOne.uid].push({
            opponentUid: playerTwo.uid,
            opponentName: playerTwo.displayName,
            rows: { front: 1, middle: 1, back: 1 },
            matchResult: "win",
            opponentFoul: true
          });
          details[playerTwo.uid].push({
            opponentUid: playerOne.uid,
            opponentName: playerOne.displayName,
            rows: { front: -1, middle: -1, back: -1 },
            matchResult: "lose",
            foul: true
          });
        } else {
          // Both fouled = tie
          details[playerOne.uid].push({
            opponentUid: playerTwo.uid,
            opponentName: playerTwo.displayName,
            rows: { front: 0, middle: 0, back: 0 },
            matchResult: "tie",
            foul: true
          });
          details[playerTwo.uid].push({
            opponentUid: playerOne.uid,
            opponentName: playerOne.displayName,
            rows: { front: 0, middle: 0, back: 0 },
            matchResult: "tie",
            foul: true
          });
        }
        continue; // Skip normal comparison
      }

      const comparison = compareArrangements(
        handOne.arrangement,
        handTwo.arrangement
      );

      const sign = (value) => {
        if (value > 0) return 1;
        if (value < 0) return -1;
        return 0;
      };

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

      const countWins = (rows) => {
        return Object.values(rows).filter((value) => value === 1).length;
      };

      const playerOneRowWins = countWins(rowsOne);
      const playerTwoRowWins = countWins(rowsTwo);

      let playerOneResult = "tie";
      let playerTwoResult = "tie";

      if (playerOneRowWins > playerTwoRowWins) {
        matchWins[playerOne.uid] += 1;
        playerOneResult = "win";
        playerTwoResult = "lose";
      } else if (playerTwoRowWins > playerOneRowWins) {
        matchWins[playerTwo.uid] += 1;
        playerOneResult = "lose";
        playerTwoResult = "win";
      }

      rowWins[playerOne.uid] += playerOneRowWins;
      rowWins[playerTwo.uid] += playerTwoRowWins;

      details[playerOne.uid].push({
        opponentUid: playerTwo.uid,
        opponentName: playerTwo.displayName,
        rows: rowsOne,
        matchResult: playerOneResult
      });

      details[playerTwo.uid].push({
        opponentUid: playerOne.uid,
        opponentName: playerOne.displayName,
        rows: rowsTwo,
        matchResult: playerTwoResult
      });
    }
  }

  const rankings = players.map((player) => {
    const handData = handsMap[player.uid];
    const fouled = isFouled(handData);
    
    return {
      uid: player.uid,
      username: player.username,
      displayName: player.displayName,
      isBot: Boolean(player.isBot),
      points: matchWins[player.uid] || 0,
      rowWins: rowWins[player.uid] || 0,
      bet: 0,
      prize: 0,
      net: 0,
      humanRank: null,
      overallRank: null,
      fouled: fouled
    };
  });

  rankings.sort((a, b) => {
    return (
      b.points - a.points ||
      b.rowWins - a.rowWins ||
      a.displayName.localeCompare(b.displayName)
    );
  });

  rankings.forEach((ranking, index) => {
    ranking.overallRank = index + 1;
  });

  let humanRank = 0;

  rankings.forEach((ranking) => {
    if (!ranking.isBot) {
      humanRank += 1;
      ranking.humanRank = humanRank;
    }
  });

  const minBet = Number(room.settings.minBet) || 0;
  const pot = Number(room.pot) || 0;

  rankings.forEach((ranking) => {
    if (ranking.isBot) {
      ranking.bet = 0;
    } else {
      ranking.bet = minBet;
    }
  });

  /*
    Prize logic:

    Prize is based on OVERALL rank, not human-only rank.

    If one or more humans are tied for the top overall score,
    they split the prize.

    If a bot alone is the top overall player, humans get no prize.
  */

  if (pot > 0 && rankings.length > 0) {
    const topPoints = rankings[0].points;
    const topRowWins = rankings[0].rowWins;

    const topHumans = rankings.filter((ranking) => {
      return (
        !ranking.isBot &&
        ranking.points === topPoints &&
        ranking.rowWins === topRowWins
      );
    });

    if (topHumans.length > 0) {
      const share = Math.floor(pot / topHumans.length);

      let paid = 0;

      topHumans.forEach((ranking, index) => {
        if (index === topHumans.length - 1) {
          ranking.prize = pot - paid;
        } else {
          ranking.prize = share;
          paid += share;
        }
      });
    }
  }

  rankings.forEach((ranking) => {
    if (!ranking.isBot) {
      ranking.net = ranking.prize - ranking.bet;
    } else {
      ranking.net = 0;
    }
  });

  const arrangements = {};

  players.forEach((player) => {
    const handData = handsMap[player.uid];

    arrangements[player.uid] =
      handData && handData.arrangement
        ? handData.arrangement
        : null;
  });

  return {
    roundNumber: room.roundNumber,
    pot,
    minBet,
    rankings,
    details,
    arrangements,
    calculatedAt: Date.now()
  };
}
