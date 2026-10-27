# AGENTS.md

Notes for coding agents (and people) working on **Hitch**, the live slowdown watcher for React Native dev sessions. The user-facing docs are in [README.md](README.md); this file covers how to work on the repo.

## What Hitch is, in one breath

A Node CLI with no dependencies. It finds Metro dev servers on the Mac, attaches to the app's Hermes debugger (Chrome DevTools Protocol over Metro's inspector), and, on a simulator, reads native thread CPU from the app's process. It records:

- JS-thread stalls, pinned to `file:line`;
- native hot spots;
- console errors and warnings;
- slow or failed requests;
- startups;
- memory and thread leaks.

It shows them live in a local web UI (`http://127.0.0.1:7370`), prints a line per finding to the terminal, saves a report to `~/.hitch/<time>/`, and serves an MCP endpoint at `/mcp` for agents.

It never adds code to the app being watched.

## Setup

```bash
node --version            # needs 22+ (global WebSocket and fetch are used)
npm link                  # puts `hitch` on PATH, pointing at this checkout
npm test                  # node:test, all *.test.mjs files
hitch                     # run from the RN app's repo while Metro + the app are running
hitch --no-window --port 7371   # a second instance next to a running one (handy for testing)
hitch --open ~/.hitch/<time>/session.json --no-window   # replay a saved session, no app needed
hitch --install-app       # (re)build ~/Applications/Hitch.app; needed after editing mac/HitchApp.swift
```

There is nothing to build: `git pull` updates `hitch` and Hitch.app, because both run this checkout.

**Connect an agent** (from any repo) while Hitch is running:

```bash
claude mcp add --transport http --scope user hitch http://127.0.0.1:7370/mcp
```

The tools are:

| Tool | What it does |
|---|---|
| `hitch_status` | What Hitch is watching and the current counts |
| `hitch_findings` | One line per finding; filter with `kind`, `level`, `search`, `since_seconds` and `after_id` |
| `hitch_finding` | A full brief for one id: stack, source, history and the logs just before it |
| `hitch_top_offenders` | Lines ranked by total time they blocked the JS thread |
| `hitch_logs` | The app's recent plain console lines |
| `hitch_renders` | What React rendered recently and why |
| `hitch_profile` | Hermes sampling profile for N seconds |
| `hitch_heap_snapshot`, `hitch_heap_diff` | Labelled heap snapshots and what grew between them |
| `hitch_run_start`, `hitch_run_stop`, `hitch_run_scenario`, `hitch_runs` | Record and compare runs; replay saved scenarios (medians of several plays) |
| `hitch_clear`, `hitch_reload_app` | The check-a-fix loop: clear, reload, use the app, list findings again |
| `hitch_save_report` | Writes the report now |

## Map of the repo

| File | Role |
|---|---|
| `index.mjs` | CLI entry: flags, starts hub + server + window, terminal lines, report on exit |
| `hub.mjs` | Finds Metro servers and phones; owns the current engine and swaps it when you switch apps |
| `discovery.mjs` | Metro discovery (listening `node` processes answering `/status`), booted simulators |
| `engine.mjs` | One watched app: stall detection, stack capture, diagnosis, hot-thread bursts; `writeReport`, `rankOffenders`, `openSession` |
| `observers.mjs` | Console / network / memory / threads / leaks / startup monitors; grouping of repeats |
| `js-inspector.mjs` | The CDP connection: pause, stack, console, network, heap, reload |
| `console-format.mjs` | Console args → DevTools-style text (printf placeholders, object previews, Errors); `fingerprint()` for grouping |
| `thread-monitor.mjs`, `native-sample.mjs` | Per-thread CPU (`ps -M`), macOS `sample` parsing and categories |
| `device.mjs` | Physical iPhone via `devicectl` / `xctrace` |
| `symbolicate.mjs`, `symbol-server.mjs` | Source maps from a private read-only Metro; stale-bundle detection |
| `handoff.mjs` | Per-finding AI briefs (`buildPrompt`), Claude Code launcher, editor opener |
| `server.mjs` | HTTP: static UI, `/events` SSE, `/api/*`, `/mcp` |
| `mcp.mjs` | MCP server (Streamable HTTP, JSON responses, no sessions) |
| `react-probe.mjs` | `PROBE_SOURCE` (runs inside the app on the DevTools hook: renders, reasons, frames, screen) plus host-side `summarizeRenders`, `jankPeriods`, `createScreenTracker` |
| `profile.mjs`, `heap.mjs` | Hermes profiles → stacks and hot functions; heap snapshot summaries and diffs |
| `runs.mjs` | Runs, scenarios, medians and comparisons, saved under `~/.hitch/runs` and `~/.hitch/scenarios` |
| `range.mjs` | A slice of the timeline (`summarizeRange`) and its AI brief (`rangePrompt`), served at `/api/range` |
| `android.mjs` | Android thread CPU and memory via adb (unit-tested; not yet run against a device) |
| `mac-app.mjs`, `mac/HitchApp.swift` | Native Hitch.app (WKWebView window); compiled at `--install-app` |
| `ui/` | `index.html`, `app.js` (one file: state, SSE, canvas lanes, detail panes), `app.css`, `brand/` |

## How data flows

1. `js-inspector` / `thread-monitor` / `device` raise raw signals.
2. `engine` and `observers` turn them into **events**: plain objects with `type`, a unique increasing `id` and `at` (epoch ms), and they publish them.
3. The hub forwards them as `engine.on('event')`.
4. `server.mjs` streams them over SSE. A new client first gets a `snapshot` with `status` and the whole `history()`.
5. `engine.history()` returns `{ stalls, hot, alerts, console, requests, startups, logs, vitals, lanes, jank, screens }`, and every consumer reads from it: the UI, the report, the MCP tools and `session.json`.

**Adding a new kind of finding touches all of these. Check each one:**

- `observers.mjs` or `engine.mjs` publishes it and keeps it in history.
- `hub.mjs` gets the empty default for it in `history()`.
- `engine.mjs` updates `hasFindings` and the `writeReport` section, and `openSession` defaults it (`??= []`).
- `server.mjs` includes it in `findEvent`.
- `handoff.mjs` gets a `PROMPTS[type]` brief.
- `index.mjs` prints a terminal line for it.
- `ui/app.js` gets a list row, a filter, a lane mark and a detail pane.
- `mcp.mjs` covers it in `findingsOf` and `SUMMARY`.
- Tests are added.

## Conventions

- **No npm dependencies.** Only Node built-ins in the CLI. The UI loads Shoelace and Google Fonts from CDNs, and nothing else.
- ES modules (`.mjs`), two-space indent, single quotes, long lines are fine. Use small pure helpers and export them when a test needs them.
- **Comments say why, not what.** Usually one line above the tricky bit. Match the density around you.
- **User-facing text is plain language**: "JS thread blocked 240ms", not jargon. The `(i)` explanations in `ui/app.js` (`ROW_INFO`, `EVENT_INFO`) and the README are written for app developers who don't know CDP.
- **Colors and fonts come from Shoelace tokens** (`--sl-*`, plus the `--lane-*` aliases in `app.css`). Don't hard-code hex values in the UI.
- Tests use `node:test` + `node:assert/strict` and sit next to the module (`foo.test.mjs`). Test pure logic: formatting, grouping, reports, MCP replies. The UI and the live debugger are verified by running them (see below).
- Commits: conventional style with a scope, e.g. `feat(ui): …`, `fix(device): …`, `chore: …`.
- Update the README's tables (Options, file map, tracking table) when you add a flag, file or finding.

## Good to know (gotchas)

- **Dev builds inflate times.** Rankings and culprits are real; absolute ms aren't production numbers. Dev-only work (React dev profiling, Reactotron, Redux invariant middleware) is labelled `devOnly` and should stay labelled.
- **Pauses must always be undone.** Hitch pauses the JS thread only while it's already frozen, to read a stack. Any change near pause/resume in `engine.mjs` / `js-inspector.mjs` needs the safety-net resume to keep working, including on quit.
- **Hermes is not V8.** Object previews are often missing from console args, so `js-inspector` fetches properties (`Runtime.getProperties`) for warn and error calls only, capped by count and time. Error `message`/`name` are non-enumerable.
- **Repeats are grouped by fingerprint.** UUIDs, numbers, hex and ISO times become placeholders (`fingerprint()` in `console-format.mjs`), so "retry 1 for order …" and "retry 2 for order …" are one finding with `count` and `lastText`.
- **Expo's native `fetch`** doesn't report to the debugger, so those requests are invisible. XHR and axios work.
- **The UI reads theme colors after stylesheets load** (`readTheme()` in `ui/app.js`). In WebKit (Hitch.app) a module script can run before the CDN theme arrives on a cold cache. Never capture `--sl-*` values once at import time.
- **Hitch.app** is a WKWebView, not Chrome. Test UI changes in both. It starts Hitch with `--no-window --quit-with-window` through `Contents/Resources/start-hitch`, logs to `~/.hitch/app.log`, and stops it on Cmd-Q, which saves the report. Rebuild with `hitch --install-app` after Swift changes.
- **One port, many things.** `7370` serves the UI, SSE, the JSON API and MCP. If a Hitch is already serving there, a new `hitch` just opens its window and exits. Use `--port` for a test instance.
- **`/mcp` and `/api/*` are local only.** The server binds `127.0.0.1`, and `/mcp` refuses foreign `Origin` headers so a web page can't drive it. Keep it that way.
- **Bridgeless reloads keep the debugger link open.** A reload shows up as a new execution context (`reloaded`) and a new bundle script (`bundle`), not a socket close. Anything tied to the JS runtime (source maps, the probe, the startup profile) must reset on those too.
- **The probe runs inside the user's app.** Keep `PROBE_SOURCE` plain ES2015, never throw into React, keep per-commit work bounded (`MAX_PER_COMMIT`, `MAX_DIFFED`), and keep its cost visible (`health.probeCost`). Its frames carry `hitch-probe.js` and are labelled, never blamed on the app.
- **Source maps are placed per module** (`calibrateOffset` / `offsetAt` in `symbolicate.mjs`): a long-running Metro and Hitch's fresh private Metro can order modules differently. Agreement below 95% marks the map as mismatched.
- **Dev builds vary run to run** (2× is normal). Compare medians of several plays, not single runs.
- **UI views** live in `ui/app.js` under `viewRenderers`; each re-renders on a 1–2s timer only while shown. The timeline canvas is `draw()`; WebKit pauses `requestAnimationFrame` when the page is hidden, so screenshot it in Chrome or on a visible window.
- **`~/.hitch/` layout:** `<ISO time>/report.md` + `session.json` per session that found something, `handoffs/` (briefs sent to Claude), `runs/` and `scenarios/`, `app.log` (Hitch.app output), `window-profile/` (Chrome `--app` window profile).
- **The terminal log is chronological per source, not globally.** Console lines carry the app's timestamp, so they can print slightly out of order with stall lines.

## Verifying changes

- `npm test` must pass.
- **With a real app:** run Metro and the app, then `hitch --no-window --port 7371`, and read `curl -s localhost:7371/mcp …` or open the URL.
- **Without an app:** replay a saved session with `--open ~/.hitch/<time>/session.json`. To test live inspector paths, write a small fake Metro: answer `/status` with `packager-status:running` and `/json/list` with one page whose `webSocketDebuggerUrl` points at a WebSocket that replies to CDP calls and plays `Runtime.consoleAPICalled` events.
- **UI:** look at it. Headless Chrome's `--screenshot` hangs on the never-ending SSE stream, so drive it over CDP and call `Page.captureScreenshot` after a few seconds. For Hitch.app, render in a `WKWebView` with `takeSnapshot`, keeping the window on-screen (off-screen windows pause `requestAnimationFrame`, so the canvas stays blank).

## Agents in this repo

`.claude/agents/` has three helpers:

- **hitch-reader** reads what Hitch caught (through the MCP tools, or a saved `report.md` / `session.json`), traces each finding into the app's code, and ranks what to fix.
- **hitch-codebase-guide** answers "how does Hitch do X / where would I change Y" about this repo, read-only.
- **hitch-setup** gets Hitch installed, running, attached to the app and connected over MCP, and works through the troubleshooting table.

To use hitch-reader while working in your app's repo, copy it to `~/.claude/agents/` (or the app repo's `.claude/agents/`). It needs the MCP server added with `--scope user`.
