import { rankValue, suitOf, rankOf } from "./cards.js";

/* Rank string -> numeric value (2..14). Used by special-hand detection. */
const RANK_NUM = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14
};

function getCounts(values) {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) || 0) + 1);
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);
}

function getStraightHigh(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.includes(14) && unique.includes(2) && unique.includes(3) && unique.includes(4) && unique.includes(5)) return 5;
  for (let i = 0; i <= unique.length - 5; i++) {
    if (unique[i] - unique[i + 4] === 4) return unique[i];
  }
  return null;
}

function compareArrays(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function evaluate5(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) throw new Error("Five-card hand required.");
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((suit) => suit === suits[0]);
  const straightHigh = getStraightHigh(values);
  const counts = getCounts(values);

  if (isFlush && straightHigh) return { category: 9, tiebreakers: [straightHigh], name: straightHigh === 14 ? "Royal Flush" : "Straight Flush" };
  if (counts[0].count === 4) return { category: 8, tiebreakers: [counts[0].value, counts[1].value], name: "Four of a Kind" };
  if (counts[0].count === 3 && counts[1].count === 2) return { category: 7, tiebreakers: [counts[0].value, counts[1].value], name: "Full House" };
  if (isFlush) return { category: 6, tiebreakers: values, name: "Flush" };
  if (straightHigh) return { category: 5, tiebreakers: [straightHigh], name: "Straight" };
  if (counts[0].count === 3) return { category: 4, tiebreakers: [counts[0].value, ...counts.slice(1).map((i) => i.value)], name: "Three of a Kind" };
  if (counts[0].count === 2 && counts[1].count === 2) return { category: 3, tiebreakers: [counts[0].value, counts[1].value, counts[2].value], name: "Two Pair" };
  if (counts[0].count === 2) return { category: 2, tiebreakers: [counts[0].value, ...counts.slice(1).map((i) => i.value)], name: "One Pair" };
  return { category: 1, tiebreakers: values, name: "High Card" };
}

export function evaluate3(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) throw new Error("Three-card hand required.");
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const counts = getCounts(values);
  if (counts[0].count === 3) return { category: 3, tiebreakers: [counts[0].value], name: "Three of a Kind" };
  if (counts[0].count === 2) return { category: 2, tiebreakers: [counts[0].value, counts[1].value], name: "Pair" };
  return { category: 1, tiebreakers: values, name: "High Card" };
}

export function compare5(a, b) { return a.category !== b.category ? a.category - b.category : compareArrays(a.tiebreakers, b.tiebreakers); }
export function compare3(a, b) { return a.category !== b.category ? a.category - b.category : compareArrays(a.tiebreakers, b.tiebreakers); }

export function strength5(evaluated) {
  return evaluated.category * 1000000 + evaluated.tiebreakers.reduce((sum, v, i) => sum + v * Math.pow(15, 4 - i), 0);
}
export function strength3(evaluated) {
  return evaluated.category * 1000000 + evaluated.tiebreakers.reduce((sum, v, i) => sum + v * Math.pow(15, 2 - i), 0);
}

export function arrangementScore(arrangement) {
  return strength5(evaluate5(arrangement.back)) * 1.15 + strength5(evaluate5(arrangement.middle)) * 1.0 + strength3(evaluate3(arrangement.front)) * 0.7;
}

/* ============================================================
   FIXED: Middle-beats-Front legality.
   Front uses the 3-card scale (1=high, 2=pair, 3=trips).
   Middle uses the 5-card scale (1=high, 2=pair, 3=two-pair, 4=trips, ...).
   We map the front category to the minimum 5-card category that beats it.
   ============================================================ */
function middleBeatsFront(frontEval, middleEval) {
  let requiredCategory;
  if (frontEval.category === 3) requiredCategory = 4;      // front trips  -> middle needs trips or better
  else if (frontEval.category === 2) requiredCategory = 2; // front pair   -> middle needs pair or better
  else requiredCategory = 1;                               // front high   -> anything

  if (middleEval.category < requiredCategory) return false;

  // Same-class tiebreaks (the trips case was previously missing).
  if (frontEval.category === 1 && middleEval.category === 1 && middleEval.tiebreakers[0] < frontEval.tiebreakers[0]) return false; // high vs high
  if (frontEval.category === 2 && middleEval.category === 2 && middleEval.tiebreakers[0] < frontEval.tiebreakers[0]) return false; // pair vs pair
  if (frontEval.category === 3 && middleEval.category === 4 && middleEval.tiebreakers[0] < frontEval.tiebreakers[0]) return false; // trips vs trips
  return true;
}

export function isLegalArrangement(arrangement) {
  const { front, middle, back } = arrangement;
  if (!front || front.length !== 3) return false;
  if (!middle || middle.length !== 5) return false;
  if (!back || back.length !== 5) return false;

  const backEval = evaluate5(back);
  const middleEval = evaluate5(middle);
  const frontEval = evaluate3(front);

  // Back must beat Middle.
  if (compare5(backEval, middleEval) < 0) return false;
  // Middle must beat Front (fixed logic).
  if (!middleBeatsFront(frontEval, middleEval)) return false;
  return true;
}

export function compareArrangements(a, b) {
  return {
    front: compare3(evaluate3(a.front), evaluate3(b.front)),
    middle: compare5(evaluate5(a.middle), evaluate5(b.middle)),
    back: compare5(evaluate5(a.back), evaluate5(b.back))
  };
}

export function getRoyalty(arrangement) {
  if (!arrangement) return { front: 0, middle: 0, back: 0, total: 0 };
  const f = evaluate3(arrangement.front);
  const m = evaluate5(arrangement.middle);
  const b = evaluate5(arrangement.back);
  let front = 0, middle = 0, back = 0;
  if (f.category === 3) front = 3;
  if (m.category === 7) middle = 2;
  if (m.category === 8) middle = 8;
  if (m.category === 9) middle = m.tiebreakers[0] === 14 ? 20 : 10;
  if (b.category === 8) back = 4;
  if (b.category === 9) back = b.tiebreakers[0] === 14 ? 10 : 5;
  return { front, middle, back, total: front + middle + back };
}

export function detectSpecial(hand) {
  if (!hand || hand.length !== 13) return null;
  const ranks = hand.map((c) => rankOf(c));
  const suits = hand.map((c) => suitOf(c));

  if (new Set(ranks).size === 13) return { id: "dragon", name: "Dragon", tier: 5, points: 108 };

  const colorSet = new Set(suits.map((s) => (s === "H" || s === "D" ? "R" : "B")));
  if (colorSet.size === 1) {
    return { id: "allcolor", name: colorSet.has("R") ? "All Red" : "All Black", tier: 4, points: 52 };
  }

  const counts = {};
  ranks.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
  if (hasThreeStraights(counts)) return { id: "threestraights", name: "Three Straights", tier: 3, points: 39 };

  const suitCounts = {};
  suits.forEach((s) => { suitCounts[s] = (suitCounts[s] || 0) + 1; });
  if (hasThreeFlushes(Object.values(suitCounts))) return { id: "threeflushes", name: "Three Flushes", tier: 2, points: 26 };

  const vals = Object.values(counts);
  if (vals.filter((c) => c === 2).length === 6 && vals.filter((c) => c === 1).length === 1) {
    return { id: "sixpairs", name: "Six Pairs", tier: 1, points: 13 };
  }
  return null;
}

function hasThreeFlushes(suitCountList) {
  const bins = [...suitCountList].sort((a, b) => b - a);
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++)
      for (let c = 0; c < 4; c++) {
        const use = [0, 0, 0, 0];
        use[a] += 5; use[b] += 5; use[c] += 3;
        if (use.every((u, i) => u <= (bins[i] || 0))) return true;
      }
  return false;
}

/* ============================================================
   FIXED: Three Straights detection.
   counts keys are rank STRINGS ("2".."10","J","Q","K","A").
   Aces live in a single stock at pool[14]; a straight that needs an
   ace-low (position 1) draws from pool[14], so an Ace can play low or
   high but can NEVER be double-spent across two straights.
   ============================================================ */
function hasThreeStraights(counts) {
  const pool = {};
  for (let r = 2; r <= 14; r++) pool[r] = 0;

  let total = 0;
  Object.entries(counts).forEach(([rankStr, v]) => {
    const n = RANK_NUM[rankStr] || 0;
    if (n >= 2 && n <= 14) {
      pool[n] += v;
      total += v;
    }
  });
  if (total !== 13) return false;

  return searchStraights(pool, [5, 5, 3], 0);
}

function searchStraights(pool, groups, idx) {
  if (idx === groups.length) return true; // all three straights placed (5+5+3 = 13)
  const len = groups[idx];
  const maxStart = 14 - len + 1; // len=5 -> 10, len=3 -> 12

  for (let s = 1; s <= maxStart; s++) {
    // Map each straight position to a pool rank. Position value 1 (ace-low) draws from pool[14].
    const ranks = [];
    let ok = true;
    for (let i = 0; i < len; i++) {
      const val = s + i;
      const poolRank = val === 1 ? 14 : val;
      if ((pool[poolRank] || 0) <= 0) { ok = false; break; }
      ranks.push(poolRank);
    }
    if (!ok) continue;

    ranks.forEach((r) => { pool[r] -= 1; });
    const found = searchStraights(pool, groups, idx + 1);
    ranks.forEach((r) => { pool[r] += 1; });
    if (found) return true;
  }
  return false;
}
