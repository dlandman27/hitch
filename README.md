# Hitch

**See what's slowing your React Native app down while you test it.** Every thread is shown as a live lane. Each freeze, hot thread, console error, slow request, startup and leak is pinned to the code responsible, and one click hands it to an AI agent to fix.

Hitch runs **completely outside your app**. It connects the same way React Native DevTools does (through Metro's debugger link) and reads thread CPU and memory from your Mac. There is no SDK, no code change and nothing to install in the app, and it costs the app nothing while things are healthy.

```
┌ Hitch ────── [my-app ▾ com.example.myapp · iPhone 16 Pro]     Live   JS heap 109 MB  App memory 541 MB  Threads 48 ┐
│ THREADS                                                          │ CAPTURED                       [Everything ▾]  │
│ ■ Main/UI thread ⓘ   ▁▁▂▁▇█▆▁▁▁▁▂▁▁                              │ ⛔ React render · PlayerMarketTile       790ms │
│ ■ JS thread ⓘ        ▁▁[ 120ms ]▁▁▁▁                              │ ⚠  console.warn: Each child in a list…    ×4   │
│ ■ Network ⓘ          ▬ ▬  ▬▬▬▬▬                                   │ ⌛ GET api…/bets/open                     2.3s │
│ ■ Console ⓘ                ▲    ▲                                 │ 🚀 App reload                            5.1s │
│ ■ Memory ⓘ           ╱╲__╱‾‾╲_╱‾                                  │ 📈 JS heap climbing 5.1 MB/min                 │
│ ■ NSURLSession-work  ▁▁▁▁▆▆▆▁                                     │  … click any → what was running + Send to AI   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Contents

- [Setup](#setup)
- [Quick start](#quick-start)
- [A tour of the window](#a-tour-of-the-window)
- [What it tracks and how](#what-it-tracks-and-how)
- [Handing issues to an AI](#handing-issues-to-an-ai)
- [Testing on a real iPhone](#testing-on-a-real-iphone)
- [Saved sessions](#saved-sessions)
- [Options](#options)
- [How it stays out of the way](#how-it-stays-out-of-the-way)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)
- [How it's built](#how-its-built)
- [License](#license)

---

## Setup

**You need**

- macOS with Xcode and its command-line tools (`xcrun simctl`, `xcrun xctrace`, `xcrun devicectl`)
- Node 22 or newer (Hitch has no npm dependencies)
- Google Chrome, which Hitch uses to open its window as a standalone app. Without it, Hitch opens your default browser.
- A React Native app on **Hermes** with the modern debugger (RN 0.73+) that you run as a **dev build** through Metro

**Install once**

```bash
git clone https://github.com/dlandman27/hitch.git ~/hitch
cd ~/hitch
npm link          # puts `hitch` on your PATH
```

To update later, run `git pull`; there's nothing to rebuild. To uninstall, run `npm unlink -g hitch`.

**Optional: a Mac app.** To start Hitch from the Dock, Spotlight or Launchpad instead of a terminal:

```bash
hitch --install-app       # builds ~/Applications/Hitch.app (needs Xcode's command-line tools)
```

Hitch.app is a native window with its own Dock icon, Cmd-Tab entry and Cmd-Q. Opening it starts Hitch, or shows the one already running, and `hitch` in a terminal opens it too. Quitting the app (or closing its window) stops the Hitch it started and saves the report. Output goes to `~/.hitch/app.log`. The app runs this checkout, so `git pull` updates it; rerun `--install-app` if you move the repo or after pulling changes to `mac/HitchApp.swift`. To remove it, delete `~/Applications/Hitch.app`.


---

## Quick start

```bash
# 1. Run your app as usual
yarn start                 # Metro
yarn ios                   # app in the simulator

# 2. In another terminal, anywhere
hitch
```

A window opens and attaches to your app. Use the app normally and slowdowns appear as they happen. Press **Ctrl-C** in the terminal to quit; a report is saved to `~/.hitch/<time>/`.

If you run several Metro servers (different projects or ports), Hitch finds all of them. Switch between them, and between apps and devices, from the dropdown in the top-left corner.

---

## A tour of the window

Hover any **ⓘ** for a plain-language explanation of what that part shows and how it's measured.

### Top bar

| | |
|---|---|
| **Project ▾** | Every Metro dev server on your Mac, its folder, and the apps connected to it (simulator and phone listed separately), plus any iPhone plugged in over USB. Pick one to watch it. Source maps and AI hand-off follow the selected project. |
| **Status** | Live, Waiting for app, Reconnecting (after a reload), No Metro running, or Saved session. |
| **Vitals** | JS heap, app memory, thread count (each with its change over the last 2 minutes) and the last startup time. |
| **15s · 30s · 1m · 3m** | How much history the lanes show. |
| **Pause** (`P`) | Freezes the lanes so you can inspect them. Data keeps being collected. |
| **Sample threads** | Samples every native thread for 1 second right now. |
| **Settings** | Thresholds (freeze ms, UI-thread %, any-thread %, slow-request ms), save a report, clear events. |

### Threads (left)

One lane per thread, refreshed every 50ms. A taller bar means a busier thread.

- **Main/UI thread:** touches, layout, native views and animations. When it's busy, the screen stutters.
- **JS thread:** your React and JS code. **Boxed blocks are freezes**: click one to see what was running.
- **Hermes GC:** garbage collection. Spikes mean lots of throwaway objects are being created.
- **Network:** each request as a bar from send to finish. Teal is OK, amber is slow, red failed.
- **Console:** ▲ markers for `console.warn`, `console.error` and uncaught exceptions. Faint ticks along the bottom are plain `console.log` / `info` / `debug` lines; hover them to read.
- **Memory:** green is the JS heap, blue is total app memory. Red ticks are leak warnings.
- **Other threads:** SDKs (Datadog, Sentry, Firebase…), networking and the worker pool, shown when active. Idle threads collapse into a row you can expand.

**Pink-striped areas** mark moments when every native thread was sampled.

### Captured (right)

Everything Hitch caught, newest first. Filter it with the dropdown (JS freezes, Hot threads, Console errors and warnings, errors only or warnings only, Slow & failed requests, Startups, Leaks) and narrow it with the search box, which matches messages, URLs, function names and files. Click an item for its detail view:

- **JS freeze:**
  - a plain-English diagnosis (a React render or commit, time inside a library, or dev-only tooling);
  - the code that was running, with that line highlighted and a click to open it in your editor;
  - the React components that were rendering, the call stack (your code highlighted, libraries folded) and what else happened around that moment.
- **Hot threads:** each busy thread's time by subsystem (Yoga layout, mounting, CoreAnimation, SDKs, GC) and its hottest native functions.
- **Console:** the full message, the line that logged it and its stack, each with a copy button. Messages show the way DevTools would: `%s`-style placeholders filled in (so React warnings name the component), objects by their contents and errors by name and message. Repeats of the same message are grouped even when ids, numbers or timestamps in it change, with first-seen and last-seen times and the latest version of the text.
- **Request:** URL, status, size, the code that sent it, and what happened while it was in flight.
- **Startup:** the reload or launch broken into time until the first screen rendered and time until the app settled.
- **Leak:** how fast memory or the thread count is climbing, and which threads grew.

Console, freeze and request details also list the **app logs** from just before: the plain `console.log` lines that say what the app was doing. They're included in the AI hand-off too.

Use `J` and `K` to move through events and `Esc` to go back to the list.

---

## What it tracks and how

| Signal | Source | Cost to the app |
|---|---|---|
| Per-thread CPU (lanes) | `ps -M` on the simulator process, every 50ms | none (read from the Mac) |
| JS freezes and the code responsible | Metro debugger: brief `Debugger.pause` → stack → resume, only while the JS thread is already pegged | none while healthy |
| Hot-thread breakdown | macOS `sample` for 1s when the UI thread is ≥60% or another thread ≥90% for a second | only during that 1s |
| Console output (all levels) | Metro debugger `Runtime` events; an object in a warning or error may get one property read to show its contents | none (already produced by the app) |
| Network requests | Metro debugger `Network` events (XHR) | none |
| JS heap | `Runtime.getHeapUsage` every 2s (answered off the JS thread) | negligible |
| App memory and thread count | `ps` on the simulator process every 2s | none |
| Startup time | debugger reconnect → `Running "app"` log → JS and UI threads quiet for 1s | none |
| Leaks | memory floor after GC (or thread count) rising steadily for 3 minutes; app memory that a JS reload didn't give back | none |
| What React rendered, and why | a small probe Hitch installs through the debugger on React's DevTools hook (dev builds already load it): per commit, which components rendered or mounted, their render time, and the reason (state, store, context, changed props, or new props with equal values) | about 1ms per React commit (measured ~3% of React's own render time), nothing while idle |
| Choppy frames | the same probe counts animation frames while React is busy; dropped frames that freezes don't explain become a finding | one frame callback while React is active |
| Screen load times | the focused React Navigation screen, from the change until React is quiet for 1s | none beyond the probe |
| Stacks for short freezes | Hermes' sampling profiler for the first 15s after a launch or reload, during recorded runs, and on request | a little CPU only while recording |
| Redux action behind a freeze | read from the paused `dispatch` frame while a stack is captured | at most 30ms, during a freeze |
| Heap snapshots | `HeapProfiler.takeHeapSnapshot`, only when asked (MCP) | freezes the app a few seconds |

**Diagnosis rules**, so you don't chase the wrong thing:
- **React render or commit:** most stack captures were inside React's render or commit, so the cost is the whole render, not one line. The detail lists the components seen and what started it (state update, touch handler, timer).
- **Time inside a library:** names the library and the app code that called it.
- **Dev-only:** Reactotron, Redux Toolkit's dev checks, React's dev profiling, the React DevTools backend and Hitch's own probe only exist in dev builds and are labelled as such. Agents see them hidden by default.
- **Bursts:** freezes back to back (a screen load, a scroll) are grouped, so one slow screen is one item, not thirteen.
- **Avoidable re-renders:** components that re-rendered with props equal in value (a new `style` object, a new callback, a new JSX child) are counted per freeze and across the session, with the props named.
- **Weak evidence:** freezes with only 1–2 captures are marked as a lead, not proof.

---

## Handing issues to an AI

Every item in the detail view has:

- **Send to Claude Code:** opens Terminal in the project folder and starts `claude` with a complete bug report: the diagnosis, measurements, highlighted code, call stack, history ("happened 6× this session") and fix steps tailored to the issue type. Reports are also saved in `~/.hitch/handoffs/`.
- **Copy prompt:** the same report on your clipboard, for any agent.
- **Open in editor** (↗): jumps to the line in Cursor or VS Code. Set `HITCH_EDITOR=code` (or `cursor`, `webstorm`…) to choose.

### Let an agent ask Hitch directly (MCP)

While Hitch is running, it serves an MCP endpoint on its own port. Add it to Claude Code once (or to any agent that supports Streamable HTTP MCP servers):

```bash
claude mcp add --transport http --scope user hitch http://127.0.0.1:7370/mcp
```

An agent working in your app's repo can then ask what Hitch saw and check its own fixes:

| Tool | What it does |
|---|---|
| `hitch_status` | What Hitch is watching, memory and threads now, and how many findings of each kind |
| `hitch_findings` | One line per finding, with an id. Filter by `kind`, `level`, `search`, `since_seconds`, or `after_id` for only what's new |
| `hitch_finding` | One finding in full: the same brief as **Copy prompt** |
| `hitch_top_offenders` | The lines that blocked the JS thread longest across the session |
| `hitch_logs` | The app's recent `console.log` / `info` / `debug` lines |
| `hitch_renders` | What React rendered in the last N seconds and why, plus the session's avoidable re-renders |
| `hitch_profile` | Record the JS thread for N seconds with Hermes' profiler: hottest functions, and your own code by total time |
| `hitch_heap_snapshot` · `hitch_heap_diff` | Snapshot the JS heap under a label, then see which kinds of objects grew between two snapshots |
| `hitch_run_start` · `hitch_run_stop` | Record a named interaction; stopping saves it and compares it with the last run of that name |
| `hitch_run_scenario` | Replay saved steps (reload, open a deep link, wait) as a run, 3 times by default, and compare the medians |
| `hitch_runs` | Saved runs with their branch and commit |
| `hitch_clear` · `hitch_reload_app` | Start fresh and reload the JS, to check whether a change helped |
| `hitch_save_report` | Write the report to `~/.hitch` now |

The window has **Record run** in the toolbar for the same thing by hand. Runs are saved in `~/.hitch/runs/<name>/`, scenarios in `~/.hitch/scenarios/`. A single run of the same code can vary by 2× in a dev build, so compare scenarios played several times rather than one-off runs.

It only answers on this Mac: it listens on `127.0.0.1` and refuses requests from web pages. This repo also ships agent definitions in `.claude/agents/`; to use the findings reader from your app's repo, copy `hitch-reader.md` to `~/.claude/agents/`. See [AGENTS.md](AGENTS.md).

---

## Testing on a real iPhone

### Option A: dev build on the phone (full JS detail)

You get JS freezes with code lines, React diagnosis, console, network, JS heap, startup and a JS responsiveness lane. Per-thread native lanes need the simulator.

1. Plug the phone in, unlock it, and put it on the **same Wi-Fi** as your Mac.
2. **Turn off any VPN on the phone** (e.g. NordVPN). It blocks the app from reaching Metro on your Mac.
3. Install a dev build on the phone (from Xcode, or `yarn ios --device "<Your iPhone>"`).
4. In Hitch, pick the phone's entry under your Metro server in the dropdown.

On a phone, freeze detection uses a 5-per-second heartbeat, which costs the app about 1%.

### Option B: Release build on the phone (real speed, threads only)

A Release build has none of the dev overhead (no Reactotron, React dev checks or Metro), so timings are real. Hitch **streams** the phone's threads onto the same lanes as the simulator:

- Apple's profiler (`xctrace`, Time Profiler) records the app in back-to-back **20-second chunks**. iOS allows only one profiling session at a time, so chunks can't overlap.
- Each finished chunk is replayed onto the lanes at its **real timestamps**, at 50ms detail. Data arrives about **15–25 seconds behind**, and the timeline ends at the latest recorded moment ("latest").
- The **5–15 seconds between chunks** that couldn't be recorded are **hatched**, so a gap never looks like an idle app. Coverage is about 60–70%.
- Hot seconds (UI thread ≥60%, any thread ≥90%) and **JS-thread busy streaks** (the Release-build equivalent of a freeze) become events with per-thread breakdowns. **Sample threads** summarizes the latest chunk.
- The app must be **open on screen**: iOS suspends backgrounded apps, and the profiler can only attach to a running one. Hitch shows "Waiting for ALPHA to be open" and resumes on its own.

Release builds strip JS function names, console and network reporting, so those aren't available here.

**One-time signing setup.** The phone build has to be development-signed by your app's team:

1. **Xcode → Settings → Accounts**: sign in with your work Apple ID (re-enter the password if it shows a warning).
2. Select your team → **Manage Certificates… → + → Apple Development** → Done.

**Build and install** (command-line overrides only; no project files change):

```bash
cd ios
xcodebuild -workspace <App>.xcworkspace -scheme <scheme> -configuration <Release config> \
  -destination 'id=<PHONE_UDID>' -derivedDataPath /tmp/pw-device \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<TEAM_ID> CODE_SIGN_IDENTITY="Apple Development" \
  PROVISIONING_PROFILE_SPECIFIER= PROVISIONING_PROFILE= build

xcrun devicectl device install app --device <PHONE_UDID> /tmp/pw-device/Build/Products/<config>-iphoneos/<App>.app
```

Find your phone's UDID with `xcrun devicectl list devices`, and your team ID in Xcode → Settings → Accounts (or the Signing & Capabilities tab).

Then pick the app under **📱 Your iPhone** in Hitch's dropdown.

> **TestFlight and App Store builds can't be profiled.** iOS refuses to attach to distribution-signed apps. That's why you install your own Release build.

---

## Saved sessions

When you quit, if anything was caught, Hitch writes `~/.hitch/<time>/report.md` (a ranked summary of freezes, hot threads, console errors and warnings, slow and failed requests, startups and leaks) and `session.json` (everything, including the app logs). The terminal also prints a line for each new console error or warning, failed or slow request, startup and leak as it happens. Reopen a session later to review it or hand off issues, with no app or Metro needed:

```bash
hitch --open ~/.hitch/<time>/session.json
```

**Settings → Save report** writes a report at any time.

---

## Options

```
hitch [options]

  --project <dir>       project folder for source maps and hand-off (default: the Metro server's own folder)
  --metro <url>         start on this Metro (default: the one running from your cwd, else any with an app)
  --app <bundleId>      pin one app (default: follow whichever app is on that Metro)
  --port <n>            window port (default 7370)
  --stall <ms>          JS freeze threshold (default 50)
  --ui-hot <pct>        UI-thread % that triggers a native sample (default 60)
  --thread-hot <pct>    any-thread % that triggers a native sample (default 90)
  --no-native           skip native threads (Android / physical device)
  --no-window           print the URL instead of opening a window
  --open <file>         review a saved session.json
  --quit-with-window    stop (and save the report) once the window has been closed for 15s
  --install-app         create ~/Applications/Hitch.app (see Setup)
```

If Hitch is already running on the port, `hitch` opens a window onto that one instead of starting a second.

Most thresholds can also be changed live in **Settings**.

---

## How it stays out of the way

- **Nothing in the app.** No SDK, no imports, no code changes. All data comes from the debugger connection React Native already exposes, plus reads of the app's process from your Mac.
- **Idle cost is zero.** Measured app CPU over 10s was 0.55s without Hitch and 0.53s with it. The React probe only works when React commits (about 3% of React's own render time, at most a few ms per commit) and is read every 2s; Hitch shows its running cost in `hitch_status`. Turning Hitch off removes it.
- **Pauses are tiny and always undone.** Hitch only pauses the JS thread for an instant while it's already frozen, to read the stack. A safety net re-sends the resume, and quitting always resumes the app. If a DevTools breakpoint pauses the app, Hitch stays out of the way.
- **Source maps without touching Metro.** A private, read-only Metro (`symbol-server.mjs`) loads your project's own config to map the bundle back to source. That lets it work even where `react-native start` can't symbolicate stacks itself.
- **Stale code is detected.** If the app runs an older bundle than Metro serves (you edited without reloading), Hitch notices the stack doesn't match the source and offers **Reload app** instead of pointing at the wrong line.
- **Source maps are checked against the running bundle.** Each module is placed separately, since two Metros can order the same modules differently after a pull. If too few modules line up, Hitch warns in the window and in `hitch_status`, and keeps retrying.

---

## Limits

- **Dev builds are slower than production.** Absolute times are inflated; the ranking and the culprits are real, and dev-only work is labelled.
- **Network:** apps whose global `fetch` is Expo's native implementation don't report those requests to the debugger, so RTK Query and plain `fetch` calls won't appear. XHR and axios do.
- **Native lanes need the simulator.** On a phone, use Option A for JS detail or Option B for native threads.
- **Short freezes:** a freeze shorter than ~100ms sometimes ends before a stack can be captured. It's still listed with its duration.
- **Production users:** Hitch is for testing. For real users in production, use your RUM tool (e.g. Datadog).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No Metro running" | Start Metro (`yarn start`) and open the app. |
| App listed but status stays "Waiting for app" | Reload the app (`r` in Metro) so it reconnects to the debugger. |
| Phone app never connects to Metro | Same Wi-Fi as the Mac, **VPN off** on the phone, and the Mac's firewall allows port 8081. |
| "Couldn't start the UI on port 7370" | Another Hitch is running; quit it, or use `--port 7371`. |
| Code lines look wrong, or a yellow "older JS bundle" banner shows | Press **Reload app** in the banner (or `r` in Metro). |
| Frames show `[bundle 123:45]` instead of files | Source maps are still loading (first stall after launch), or the project folder is wrong: pass `--project`. |
| Phone missing from the dropdown | Unlock it and trust this Mac; check that `xcrun devicectl list devices` shows it as `connected`. |
| Release build fails with "No signing certificate" | Do the one-time signing setup above. |
| "Unable to log in with account" during a build | Re-enter your password in Xcode → Settings → Accounts. |
| Sampling a TestFlight or App Store app fails | Expected: iOS doesn't allow it. Install your own Release build. |

---

## How it's built

| File | What it does |
|---|---|
| `index.mjs` | CLI: options, starts the hub and window, prints a log line per event |
| `hub.mjs` | Finds Metro servers and phones; moves the watcher between them |
| `discovery.mjs` | Metro discovery (listening `node` processes answering `/status`), booted simulators |
| `engine.mjs` | The watcher for a dev build: freeze detection, stack capture, diagnosis, hot-thread bursts, report |
| `observers.mjs` | Console, network, memory, thread-count, leak and startup monitors |
| `js-inspector.mjs` | Debugger connection: pause, stack, console, network, heap, reload |
| `console-format.mjs` | Console arguments to DevTools-style text (placeholders, object previews, errors); message fingerprints for grouping |
| `thread-monitor.mjs` | Per-thread CPU from `ps -M` every 50ms |
| `native-sample.mjs` | macOS `sample` parsing and subsystem categories |
| `device.mjs` | Physical iPhone: `devicectl` discovery and `xctrace` Time Profiler bursts |
| `symbolicate.mjs` / `symbol-server.mjs` | Source maps from a private Metro, line-offset calibration, stale-bundle check |
| `handoff.mjs` | AI bug-report prompts, Claude Code launcher, editor opener |
| `server.mjs` | Local web server: UI files, live event stream, small JSON API |
| `mcp.mjs` | The `/mcp` endpoint: findings, logs and actions as MCP tools for agents |
| `react-probe.mjs` | The in-app React probe (renders, reasons, frames, screens) and its host-side summaries |
| `profile.mjs` · `heap.mjs` | Hermes sampling profiles as stacks; heap snapshot summaries and diffs |
| `runs.mjs` | Named runs, scenarios and their comparisons |
| `android.mjs` | Android thread lanes and memory over adb |
| `mac-app.mjs` / `mac/HitchApp.swift` | `--install-app`: compiles the native `Hitch.app` window and its start script |
| `ui/` | The window, built on the [Shoelace](https://shoelace.style) design system, with a canvas for the lanes |

---

## License

[MIT](LICENSE) © 2026 Dylan Landman. Contributions welcome; see [AGENTS.md](AGENTS.md) for how the repo is laid out.
