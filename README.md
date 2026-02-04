# MultiCodex Extension

![MultiCodex](./assets/multicodex.png)

MultiCodex is a **pi** extension that wraps the built-in **`openai-codex-responses`** API and lets you use **multiple ChatGPT Codex OAuth accounts**.

The goal is to **maximize your usable Codex quota** across accounts:

- **Automatic rotation on quota/rate-limit errors** (e.g. 429, usage limit).
- **Avoids wasting quota on "untouched" accounts**: it prefers accounts that show *0% used* (so none sit unused until their window resets).
- **Prefers accounts whose weekly quota resets sooner** when usage information is available (so you don't waste a weekly window).

## Install (recommended)

```bash
pi install npm:pi-multicodex
```

After installing, restart `pi`.

## Install (local dev)

From this directory:

```bash
pi -e ./index.ts
```

## Quick start

1. Add at least one account:

   ```
   /multicodex-login your@email.com
   ```

2. Use Codex normally. When a quota window is hit, MultiCodex will rotate to another available account automatically.

## Commands

- `/multicodex-login <email>`
  - Adds/updates an account in the rotation pool.
- `/multicodex-use`
  - Manually pick an account for the current session (until rotation clears it).
- `/multicodex-status`
  - Shows accounts + cached usage info + which one is currently active.

## How account selection works (high level)

When pi starts / when a new session starts, the extension:

1. Loads your saved accounts.
2. Fetches usage info for each account (cached for a few minutes).
3. Picks an account using these heuristics:
   - Prefer accounts that look **untouched** (0% used), so their quota doesn't go to waste.
   - Otherwise prefer the account whose **weekly** quota window **resets soonest**.
   - Otherwise pick a random available account.

When streaming and a quota/rate-limit error happens **before any tokens are generated**, it:

- Marks the account as exhausted until its reset (or a fallback cooldown)
- Rotates to another account and retries

## Screenshots / PNGs

This repo already includes a screenshot at:

- `assets/multicodex.png`

You can embed it (or any other PNG) in the README like this:

```md
![MultiCodex](./assets/multicodex.png)
```

Notes:
- This package is configured to publish `assets/**` (see the `files` list in `package.json`), so relative README images work on GitHub and are included in the npm tarball.
- For the **pi package gallery**, previews must be **URLs**. This package sets `package.json -> pi.image` to a GitHub raw URL pointing at `assets/multicodex.png`.

## Notes

- Uses only public exports from `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent`.
- Streaming uses `streamSimple()` plus a small local event-stream wrapper to avoid deep imports.
- The local `pi-coding-agent.d.ts` module augmentation is for local typechecking only.

## Checks

```bash
npm run lint
npm run tsgo
npm run test
```
