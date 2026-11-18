# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Battleground: type two fighters, get an AI-generated verdict on who'd win plus AI-generated character art for both. Vanilla HTML/CSS/JS frontend, Vercel serverless functions for the backend, no framework, no build step. See `project-brief.md` for full scope/decisions and `project-build.md` for the staged build plan — **check `project-build.md` before starting work to see what stage the project is on and what's done/not done.**

## Commands

- `vercel dev` — run locally (serves static files + `api/` functions together). No separate frontend build.
- No test suite, no linter configured yet.

## Architecture

- **Only `public/` is served as static files** (`vercel.json` `outputDirectory`). All frontend files (HTML, CSS, client JS) live there; everything else, including `api/` source and the judge prompt, must stay out of it so it isn't publicly readable.
- **Frontend is one page, four views**: `public/index.html` has `#view-form`, `#view-loading`, `#view-result`, `#view-error` sections, each toggled via the `hidden` attribute by `showView()` in `script.js`. Never show more than one at once — don't add a fifth ad-hoc state without going through `showView`.
- **`script.js` owns all view transitions and DOM wiring.** `runFight(fighterA, fighterB)` is the single entry point that drives form → loading → result/error. It calls `fetch('/api/fight')` once for the verdict and both fighter images.
- **`/api/fight` returns `{ winner, winnerSide, reasoning, imageA, imageB }`**: the model picks `winnerSide` (`'A'` or `'B'`, enforced by a zod enum) and the server sets `winner` to that fighter's exact input text. The UI decides which side won from `winnerSide`, never by comparing names, since both fighters can have identical text. `reasoning` is a short string; `imageA`/`imageB` are data URIs.
- **`api/` holds serverless functions**, one file per endpoint (Vercel convention — each file is its own route, no router). Shared non-endpoint modules go in `api/_lib/` (Vercel skips `_`-prefixed paths, so they don't become routes). `api/_lib/judge-prompt.js` exports `JUDGE_SYSTEM_PROMPT`, the locked system prompt for the verdict call; import it into `api/fight.js` rather than inlining prompt text there.
- **Judge prompt design** (`api/_lib/judge-prompt.js`): treats fighter text strictly as data to be judged, never as instructions — this is the prompt-injection defense, don't weaken it when editing. Must always name exactly one winner (no ties/refusals, even for identical fighters), reasoning capped at 2-4 sentences. Output shape (winner/reasoning) is enforced via a zod schema in the API call, not via JSON-formatting instructions in the prompt text itself.
- **Two external APIs, both server-side only**: Claude for the verdict, OpenAI's image API for character art. Keys live in env vars, never in client code (anything in `public/`) — all calls to these APIs happen inside `api/` functions.
- **Rate limiting**: 5 requests/minute per IP, checked first in `api/fight.js` before either external API call, returns 429.
- **Group inputs** (e.g. "10 cows") get exactly one image per side — enforce this in the prompt sent to the image API, not by looping over units.
- **BattleDex** (Stage 5+): saved fighters live in `localStorage` only, as `{ label, image }` — no fight/winner/reasoning data. Images are downsized via off-screen `<canvas>` and re-exported as compressed JPEG/WebP before saving, to stay under storage quota (Stage 6).
- No routing/state library — everything is direct DOM manipulation by element ID.
