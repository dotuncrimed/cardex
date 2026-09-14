import { compareArrangements } from "./evaluator.js";

function getPayoutPercentages(humanCount) {
  if (humanCount === 1) return [1];
  if (humanCount === 2) return [0.7, 0.3];
  if (humanCount === 3) return [0.6, 0.3, 0.1];
  if (humanCount === 4) return [0.5, 0.3, 0.2, 0];
  return [];
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
      humanRank: null
    };
  });

  rankings.sort((a, b) => {
    return (
      b.points - a.points ||
      b.rowWins - a.rowWins ||
      a.displayName.localeCompare(b.displayName)
    );
  });

  let humanRank = 0;

  rankings.forEach((ranking) => {
    if (!ranking.isBot) {
      humanRank += 1;
      ranking.humanRank = humanRank;
    }
  });

  const humanRankings = rankings.filter((ranking) => !ranking.isBot);
  const percentages = getPayoutPercentages(humanRankings.length);

  humanRankings.forEach((ranking, index) => {
    const percent = percentages[index] || 0;
    ranking.prize = Math.floor((room.pot || 0) * percent);
  });

  const paid = humanRankings.reduce((sum, ranking) => sum + ranking.prize, 0);
  const remainder = (room.pot || 0) - paid;

  if (remainder > 0 && humanRankings.length > 0) {
    humanRankings[0].prize += remainder;
  }

  rankings.forEach((ranking) => {
    if (ranking.isBot) {
      ranking.bet = 0;
      ranking.prize = 0;
      ranking.net = 0;
    } else {
      ranking.bet = Number(room.settings.minBet) || 0;
      ranking.net = ranking.prize - ranking.bet;
    }
  });

  return {
    roundNumber: room.roundNumber,
    pot: room.pot || 0,
    minBet: Number(room.settings.minBet) || 0,
    rankings,
    details,
    calculatedAt: Date.now()
  };
}
