# Social Desk

Local-first desktop social media manager built with Electron, React, TypeScript, SQLite, and Playwright.

This app lets you:

- connect accounts by signing in through the real platform web flows
- write one post and send it to multiple platforms
- save drafts locally
- schedule posts while the app stays open
- keep account sessions, drafts, and history on your own machine

## Current Scope

Supported in this repo today:

- `X`
- `Facebook`
- `Instagram`
- `TikTok`

Important practical notes:

- this app uses browser automation, not official platform APIs
- platform web UIs change often, so selectors and flows will need maintenance
- scheduled posts only run while the desktop app is open
- local sessions are stored on the machine running the app

## Requirements

Before setup, make sure you have:

- `Node.js 20+`
- `npm`
- a desktop OS supported by Electron

You also need Playwright browser binaries. If they are not already installed on your machine, run:

```bash
npx playwright install chromium
```

## Setup

Clone the repo, install dependencies, and start the app:

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
```

Useful checks:

```bash
npm run typecheck
npm test
```

## First Run

1. Open `Accounts`.
2. Click `Connect account` for the platform you want.
3. Sign in in the opened browser window.
4. Return to the app and confirm the account shows as connected.
5. Open `Composer`.
6. Write text, choose media, pick connected platforms, and post.

## How Posting Works

- `Post now` sends the post immediately.
- `Schedule` queues the job for later.
- publish history is tracked per platform
- partial success is possible: one platform can fail while another succeeds

## Media Rules

Current platform rules are enforced in the app before posting. In general:

- X supports text, images, or one video
- Facebook supports text, images, or one video
- Instagram supports images or one video
- TikTok is video-only in this app
- mixed image + video posts are blocked

## Local Data

The app stores local data under Electron's user data directory, including:

- SQLite app data
- secure metadata
- Playwright browser profiles per connected account

That means:

- no cloud backend is required
- no `.env` file is required for normal use
- disconnecting an account removes its saved local session data

## Known Limitations

- browser automation is slower and more brittle than official API posting
- some platform login flows may require reconnecting after checkpoints, MFA, or session expiry
- TikTok and Instagram video flows are especially sensitive to front-end changes
- Windows `.exe` packaging is configured, but should be built on Windows for best results

## Windows `.exe` Packaging

This repo is configured with `electron-builder`.

Windows packaging commands:

```bash
npm run dist:win
npm run dist:win:portable
```

Expected output goes to:

```bash
release/
```

Recommended way to build the Windows installer:

- run those commands on a Windows machine
- or use a Windows CI runner

## Troubleshooting

If the app fails to post:

- reconnect the account in `Accounts`
- verify the account still shows as connected
- retry with one platform at a time
- check the publish history message for the exact platform failure

If Playwright is missing a browser:

```bash
npx playwright install chromium
```

If the app builds but packaging fails on macOS for Windows:

- build the `.exe` on Windows instead

## Project Scripts

```bash
npm run dev
npm run build
npm run typecheck
npm test
npm run pack
npm run dist:win
npm run dist:win:portable
```
