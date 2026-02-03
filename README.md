# MultiCodex Extension

Rotate multiple ChatGPT Codex OAuth accounts for the built-in `openai-codex-responses` API.

## What you get

- One provider (`multicodex`) that wraps the Codex responses API.
- Multiple OAuth accounts with automatic rotation when a quota limit is hit.
- `/multicodex-login` to add accounts and `/multicodex-use` to switch.

## Install (local dev)

From this directory:

```bash
pi -e ./index.ts
```

## Install (published / external)

Place this directory (or compiled TS) at:

- `~/.pi/agent/extensions/multicodex/`

Then run:

```bash
pi
```

## Commands

- `/multicodex-login <email>`
- `/multicodex-use`

## Notes

- This extension only uses public exports from `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent`.
- Streaming uses `streamSimple()` and a local event stream implementation to avoid deep imports.
- The local `pi-coding-agent.d.ts` module augmentation is for local typechecking only. It should be kept small and aligned with the real runtime surface.
- Login attempts to open the browser automatically using the platform default handler.
- Status is integrated into the main footer line (no extra status row).

## Checks

```bash
npm run lint
npm run tsgo
npm run test
```
