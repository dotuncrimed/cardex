export const RANKS = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A"
];

export const SUITS = ["C", "D", "H", "S"];

const RANK_VALUES = Object.fromEntries(
  RANKS.map((rank, index) => [rank, index + 2])
);

const SUIT_VALUES = Object.fromEntries(
  SUITS.map((suit, index) => [suit, index])
);

const SUIT_SYMBOLS = {
  C: "♣",
  D: "♦",
  H: "♥",
  S: "♠"
};

export function buildDeck() {
  const deck = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(rank + suit);
    }
  }

  return deck;
}

export function shuffle(input) {
  const deck = [...input];

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

export function rankOf(card) {
  return card.slice(0, -1);
}

export function suitOf(card) {
  return card.slice(-1);
}

export function rankValue(card) {
  return RANK_VALUES[rankOf(card)] || 0;
}

export function suitValue(card) {
  return SUIT_VALUES[suitOf(card)] || 0;
}

export function sortCards(cards) {
  return [...cards].sort((a, b) => {
    return rankValue(b) - rankValue(a) || suitValue(b) - suitValue(a);
  });
}

export function suitSymbol(suit) {
  return SUIT_SYMBOLS[suit] || suit;
}

export function isRedSuit(suit) {
  return suit === "D" || suit === "H";
}
