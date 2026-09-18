import { sortCards } from "./cards.js";
import {
  evaluate5,
  strength5,
  isLegalArrangement,
  arrangementScore
} from "./evaluator.js";

function* choose(arr, k, start = 0, combo = []) {
  if (combo.length === k) {
    yield combo.slice();
    return;
  }

  if (combo.length + (arr.length - start) < k) {
    return;
  }

  for (let i = start; i < arr.length; i++) {
    combo.push(arr[i]);
    yield* choose(arr, k, i + 1, combo);
    combo.pop();
  }
}

export function botArrangeHand(hand, difficulty = "normal") {
  const sortedHand = sortCards(hand);

  const limits = {
    easy: 12,
    normal: 60,
    hard: 120
  };

  const backLimit = limits[difficulty] || limits.normal;
  const backCandidates = [];

  for (const back of choose(sortedHand, 5)) {
    const evaluated = evaluate5(back);
    backCandidates.push({
      back,
      score: strength5(evaluated)
    });
  }

  backCandidates.sort((a, b) => b.score - a.score);
  const topBacks = backCandidates.slice(0, backLimit);

  let best = null;

  for (const candidate of topBacks) {
    const remaining = sortedHand.filter((card) => !candidate.back.includes(card));

    for (const middle of choose(remaining, 5)) {
      const front = remaining.filter((card) => !middle.includes(card));

      const arrangement = {
        front,
        middle,
        back: candidate.back
      };

      if (!isLegalArrangement(arrangement)) {
        continue;
      }

      let score = arrangementScore(arrangement);

      if (difficulty === "easy") {
        score += Math.random() * 2000000;
      }

      if (!best || score > best.score) {
        best = { arrangement, score };
      }
    }
  }

  if (!best) {
    best = {
      arrangement: {
        front: sortedHand.slice(0, 3),
        middle: sortedHand.slice(3, 8),
        back: sortedHand.slice(8, 13)
      }
    };
  }

  return best.arrangement;
}
