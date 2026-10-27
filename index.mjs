#!/usr/bin/env node
// Hitch: live thread lanes for a React Native app in the simulator, with
// every JS freeze / hot thread pinned to the code responsible and one click to
// hand it to an AI agent. Attaches through Metro only; never touches the app.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

import { hasFindings, openSession } from './engine.mjs';
import { startHub } from './hub.mjs';
import { APP_PATH, installMacApp, macAppInstalled } from './mac-app.mjs';
import { startServer } from './server.mjs';

const USAGE = `hitch [options]   (run from the app's repo, or pass --project)

  --project <dir>       app repo root, for source maps + hand-off (default: the Metro's own folder)
  --metro <url>         start on this Metro (default: the one running from cwd, else any with an app)
  --app <bundleId>      pin one app (default: follow whichever app is on that Metro)
  --port <n>            UI port (default 7370)
  --stall <ms>          JS freeze threshold (default 50)
  --ui-hot <pct>        UI-thread % that triggers a native sample (default 60)
  --thread-hot <pct>    any-thread % that triggers a native sample (default 90)
  --no-native           skip native threads (Android / physical device)
  --no-window           don't open the UI window (just print its URL)
  --open <session.json> review a saved session (from ~/.hitch/<time>/) without an app
  --quit-with-window    stop (and save the report) once the window has been closed for 15s
  --install-app         create ~/Applications/Hitch.app to start Hitch from the Dock, Spotlight or Launchpad
  --help, -h`;

function parseArgs(argv) {
  const opts = { open: null, project: process.cwd(), metro: 'http://localhost:8081', app: null, port: 7370, stallMs: 50, uiHot: 60, threadHot: 90, native: true, window: true, quitWithWindow: false, installApp: false };
  const strings = { '--project': 'project', '--metro': 'metro', '--app': 'app', '--open': 'open' };
  const numbers = { '--port': 'port', '--stall': 'stallMs', '--ui-hot': 'uiHot', '--thread-hot': 'threadHot' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (strings[arg]) opts[strings[arg]] = argv[++i];
    else if (numbers[arg]) opts[numbers[arg]] = Number(argv[++i]);
    else if (arg === '--no-native') opts.native = false;
    else if (arg === '--no-window') opts.window = false;
    else if (arg === '--quit-with-window') opts.quitWithWindow = true;
    else if (arg === '--install-app') opts.installApp = true;
    else {
      console.error(`unknown option ${arg}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  opts.metroExplicit = argv.includes('--metro');
  opts.projectExplicit = argv.includes('--project');
  opts.project = path.resolve(opts.project);
  return opts;
}

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Arc.app/Contents/MacOS/Arc',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

// A Chromium "app" window has no tabs or URL bar, so it reads as its own app.
function openWindow(url) {
  // Hitch.app shows the default port in its own window, with a Dock icon.
  if (new URL(url).port === '7370' && macAppInstalled()) {
    execFile('open', [APP_PATH]);
    return;
  }
  const browser = BROWSERS.find(b => fs.existsSync(b) && !b.includes('Arc'));
  if (!browser) {
    execFile('open', [url]);
    return;
  }
  const profile = path.join(os.homedir(), '.hitch', 'window-profile');
  spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1440,900', '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }).unref();
}

const color = code => text => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = color(2);
const red = color(31);
const yellow = color(33);
const oneLine = (text, max = 140) => {
  const line = text.split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const clock = at => new Date(at).toTimeString().slice(0, 8);

// Hitch used to be called perf-watch: carry its sessions and window profile over once.
function migrateDataDir() {
  const from = path.join(os.homedir(), '.perf-watch');
  const to = path.join(os.homedir(), '.hitch');
  if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
}

// Is this port already serving a Hitch window? Then there's nothing to start.
async function runningHitch(port) {
  const url = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${url}/manifest.webmanifest`, { signal: AbortSignal.timeout(1000) });
    return (await res.json()).name === 'Hitch' ? url : null;
  } catch {
    return null;
  }
}

async function main() {
  migrateDataDir();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.installApp) {
    const app = installMacApp();
    console.log(`Created ${app}\nOpen it from Spotlight, Launchpad or Finder, or drag it to the Dock. It runs this checkout, so \`git pull\` updates it.`);
    return;
  }
  if (!opts.open) {
    const existing = await runningHitch(opts.port);
    if (existing) {
      console.log(`Hitch is already running → ${existing}${opts.window ? '; opening its window' : ''}`);
      if (opts.window) openWindow(existing);
      return;
    }
  }
  const engine = opts.open ? openSession(path.resolve(opts.open), opts) : startHub(opts);
  let shutdown = null;
  const onWindowsClosed = opts.quitWithWindow ? () => shutdown?.() : null;
  const { url } = await startServer({ engine, port: opts.port, onWindowsClosed }).catch(error => {
    console.error(`Couldn't start the UI on port ${opts.port}: ${error.message}. Try --port <n>.`);
    process.exit(1);
  });

  console.log(`Hitch → ${url}`);
  console.log(dim('  finds every Metro dev server on this machine; switch apps from the window'));
  console.log(dim(`  agents: claude mcp add --transport http hitch ${url}/mcp`));
  if (opts.window) openWindow(url);

  let lastState = null;
  engine.on('event', event => {
    if (event.type === 'snapshot') {
      lastState = null;
      console.log(dim(`${clock(Date.now())}  watching ${engine.describeTarget?.() ?? ''}`));
    } else if (event.type === 'status' && event.state !== lastState) {
      lastState = event.state;
      console.log(dim(`${clock(Date.now())}  ${event.state}${event.appId ? ` · ${event.appId}` : ''}`));
    } else if (event.type === 'stall') {
      const c = event.culprits[0];
      const top = event.renders?.components?.[0];
      const rendered = top ? dim(`  rendered ${top.name} ×${top.renders}${event.renders.avoidable ? `, ${event.renders.avoidable} avoidable` : ''}`) : '';
      console.log(`${clock(event.at)}  JS freeze ${event.ms}ms  ${c ? `${c.name}${c.file ? `  ${c.file}:${c.line}` : ''}` : dim('(no stack)')}${event.devOnly ? dim(` (dev-only: ${event.devOnly})`) : ''}${rendered}`);
    } else if (event.type === 'jank' && event.seconds === 1) {
      // A choppy period that keeps going comes back with the same id; print it once.
      console.log(`${clock(event.at)}  ${yellow(`choppy frames ${event.fps} fps`)}${event.screen ? ` on ${event.screen}` : ''}  ${dim(`${event.dropped} frames dropped outside freezes`)}`);
    } else if (event.type === 'screen') {
      const line = `screen ${event.name} ${(event.ms / 1000).toFixed(1)}s`;
      console.log(`${clock(event.at)}  ${event.issue ? yellow(line) : line}  ${dim(`${event.commits} renders, ${event.mounts} mounts${event.stalls ? `, ${event.stalls} freezes` : ''}`)}`);
    } else if (event.type === 'run' && event.finished) {
      const { run, comparison } = event.finished;
      console.log(`${clock(Date.now())}  run "${run.name}" — blocked ${run.summary.blockedMs}ms over ${run.summary.stalls} freezes${comparison ? `, ${comparison.verdict} than last time` : ''}`);
    } else if (event.type === 'hot') {
      console.log(`${clock(event.at)}  threads hot — ${event.trigger}`);
    } else if (event.type === 'console' && event.count === 1) {
      // Repeats come back as the same event with a higher count; print each message once.
      const kind = event.exception ? 'exception' : `console.${event.level}`;
      const from = event.source?.file ? dim(`  ${event.source.file}:${event.source.line}`) : '';
      console.log(`${clock(event.at)}  ${(event.level === 'error' ? red : yellow)(kind)} ${oneLine(event.text)}${from}`);
    } else if (event.type === 'request' && event.issue) {
      const what = event.failed ? red(`request failed (${event.error ?? `HTTP ${event.status}`})`) : yellow(`slow request ${(event.ms / 1000).toFixed(1)}s`);
      console.log(`${clock(event.at)}  ${what} ${event.method} ${oneLine(event.url, 100)}`);
    } else if (event.type === 'startup') {
      const total = event.toSettleMs ?? event.toJsMs;
      console.log(`${clock(event.at)}  ${event.kind}${total != null ? ` ${(total / 1000).toFixed(1)}s` : ''}${event.settled ? '' : dim(' (never settled)')}`);
    } else if (event.type === 'leak' || event.type === 'threadleak') {
      const MB = 1048576;
      const text =
        event.type === 'threadleak'
          ? `threads piling up ${event.from} → ${event.to}`
          : event.kind === 'reload'
            ? `app memory not freed by a JS reload ${Math.round(event.from / MB)} → ${Math.round(event.to / MB)} MB`
            : `${event.kind === 'heap' ? 'JS heap' : 'app memory'} climbing ${event.mbPerMin} MB/min`;
      console.log(`${clock(event.at)}  ${red(text)}`);
    }
  });
  engine.on('log', message => console.log(dim(`  ! ${message}`)));

  let exiting = false;
  shutdown = async () => {
    if (exiting) process.exit(0);
    exiting = true;
    await engine.stop();
    if (hasFindings(engine.history())) console.log(`\nreport: ${engine.writeReport()}`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
