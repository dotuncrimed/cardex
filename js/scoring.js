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
  const settings = room.settings;

  const points = {};
  const details = {};

  players.forEach((player) => {
    points[player.uid] = 0;
    details[player.uid] = [];
  });

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const playerOne = players[i];
      const playerTwo = players[j];

      const handOne = handsMap[playerOne.uid];
      const handTwo = handsMap[playerTwo.uid];

      if (!handOne || !handTwo || !handOne.arrangement || !handTwo.arrangement) {
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

      const rowSigns = {
        front: sign(comparison.front),
        middle: sign(comparison.middle),
        back: sign(comparison.back)
      };

      const rowPointsOne = rowSigns.front + rowSigns.middle + rowSigns.back;
      const rowPointsTwo = -rowPointsOne;

      let scoreOne = rowPointsOne;
      let scoreTwo = rowPointsTwo;

      let scoopOne = false;
      let scoopTwo = false;

      if (settings.scoopBonus) {
        if (rowPointsOne === 3) {
          scoreOne += 3;
          scoopOne = true;
        }

        if (rowPointsOne === -3) {
          scoreTwo += 3;
          scoopTwo = true;
        }
      }

      points[playerOne.uid] += scoreOne;
      points[playerTwo.uid] += scoreTwo;

      details[playerOne.uid].push({
        opponentUid: playerTwo.uid,
        opponentName: playerTwo.displayName,
        rows: rowSigns,
        rowPoints: rowPointsOne,
        scoop: scoopOne,
        total: scoreOne
      });

      details[playerTwo.uid].push({
        opponentUid: playerOne.uid,
        opponentName: playerOne.displayName,
        rows: {
          front: -rowSigns.front,
          middle: -rowSigns.middle,
          back: -rowSigns.back
        },
        rowPoints: rowPointsTwo,
        scoop: scoopTwo,
        total: scoreTwo
      });
    }
  }

  const rankings = players.map((player) => {
    return {
      uid: player.uid,
      username: player.username,
      displayName: player.displayName,
      isBot: Boolean(player.isBot),
      points: points[player.uid] || 0,
      bet: 0,
      prize: 0,
      net: 0,
      humanRank: null
    };
  });

  rankings.sort((a, b) => {
    return b.points - a.points || a.displayName.localeCompare(b.displayName);
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
      ranking.bet = Number(settings.minBet) || 0;
      ranking.net = ranking.prize - ranking.bet;
    }
  });

  return {
    roundNumber: room.roundNumber,
    pot: room.pot || 0,
    minBet: Number(settings.minBet) || 0,
    rankings,
    details,
    calculatedAt: Date.now()
  };
}
