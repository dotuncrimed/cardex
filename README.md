# Chinese Poker Multiplayer MVP

This is a multiplayer Chinese Poker MVP.

Features:

- Username + PIN dummy Firebase login
- Create room
- Join room with room code
- Timer options
- Auto-fill bots
- Ready button for next round
- Cash system
- Admin panel
- Scoring results
- Winner sorted top to bottom

## Important

This MVP uses client-side logic.

Do not use it for real money.

For real cash, move wallet, payout, admin, and bot logic into Firebase Cloud Functions.

## Setup

1. Create Firebase project.
2. Enable Authentication > Email/Password.
3. Create Firestore Database.
4. Copy Firebase web app config.
5. Paste into `/js/config.js`.
6. Publish `/firestore.rules`.
7. Deploy to GitHub Pages.
