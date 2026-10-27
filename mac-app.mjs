// Builds Hitch.app: a native window (mac/HitchApp.swift) with its own Dock
// icon. It starts Hitch for this checkout, or shows the one already running,
// and quitting the app stops the Hitch it started, which saves the report.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_ID = 'dev.hitch.launcher';
export const APP_PATH = path.join(os.homedir(), 'Applications', 'Hitch.app');

const plist = version => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Hitch</string>
  <key>CFBundleDisplayName</key><string>Hitch</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Hitch</string>
  <key>CFBundleIconFile</key><string>hitch</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <!-- The window shows Hitch's page on 127.0.0.1. -->
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`;

const quote = s => `'${s.replace(/'/g, `'\\''`)}'`;

const startScript = ({ node, entry, log }) => `#!/bin/bash
# Run by Hitch.app to start Hitch for this checkout (rerun \`hitch --install-app\` if you move the repo).
# Apps opened from Finder get a bare PATH; borrow the login shell's so the
# editor, \`claude\` and Xcode tools resolve the same as in a terminal.
SHELL_PATH="$("\${SHELL:-/bin/zsh}" -ilc 'printf %s "$PATH"' </dev/null 2>/dev/null | tail -n 1)"
export PATH="\${SHELL_PATH:+$SHELL_PATH:}$PATH"
cd "$HOME"
mkdir -p "$(dirname ${quote(log)})"
# The Node that installed the app, unless it's since been removed (nvm upgrades).
NODE=${quote(node)}
[ -x "$NODE" ] || NODE="$(command -v node)"
# The app shows the window and stops Hitch on quit; --quit-with-window covers the app crashing.
exec "$NODE" ${quote(entry)} --no-window --quit-with-window >> ${quote(log)} 2>&1
`;

function isOurApp(app) {
  try {
    return fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').includes(`<string>${BUNDLE_ID}</string>`);
  } catch {
    return false;
  }
}

export const macAppInstalled = () => isOurApp(APP_PATH);

export function installMacApp(dir = path.dirname(APP_PATH)) {
  const app = path.join(dir, 'Hitch.app');
  if (fs.existsSync(app) && !isOurApp(app)) throw new Error(`${app} already exists and isn't a Hitch launcher; move it away first`);
  const version = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
  // Compile first, so a missing toolchain leaves any existing app untouched.
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'hitch-app-'));
  const binary = path.join(build, 'Hitch');
  try {
    execFileSync('xcrun', ['swiftc', '-O', '-o', binary, path.join(HERE, 'mac', 'HitchApp.swift'), '-framework', 'Cocoa', '-framework', 'WebKit'], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Couldn't compile Hitch.app (needs Xcode's command-line tools): ${error.stderr?.toString().trim() || error.message}`);
  }
  // Rebuild from scratch so a reinstall never keeps stale files.
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist(version));
  fs.copyFileSync(binary, path.join(app, 'Contents', 'MacOS', 'Hitch'));
  fs.chmodSync(path.join(app, 'Contents', 'MacOS', 'Hitch'), 0o755);
  fs.rmSync(build, { recursive: true, force: true });
  fs.copyFileSync(path.join(HERE, 'ui', 'brand', 'hitch.icns'), path.join(app, 'Contents', 'Resources', 'hitch.icns'));
  const start = path.join(app, 'Contents', 'Resources', 'start-hitch');
  fs.writeFileSync(start, startScript({ node: process.execPath, entry: path.join(HERE, 'index.mjs'), log: path.join(os.homedir(), '.hitch', 'app.log') }));
  fs.chmodSync(start, 0o755);
  // Local builds need a signature on Apple silicon; ad-hoc is enough.
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'pipe' });
  return app;
}
