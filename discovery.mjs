// Finds every Metro dev server on this machine: listening node processes that
// answer Metro's /status, their project folder (the process cwd), and the
// apps currently connected to each.

import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function listeningNodePorts() {
  const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']).catch(error => ({ stdout: error.stdout ?? '' }));
  const ports = new Map();
  let pid = null;
  let command = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n') && command === 'node') {
      const port = Number(line.slice(line.lastIndexOf(':') + 1));
      if (port && !ports.has(port)) ports.set(port, pid);
    }
  }
  return ports;
}

async function processInfo(pid) {
  const [cwd, cmd] = await Promise.all([
    run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).then(({ stdout }) => stdout.split('\n').find(l => l.startsWith('n'))?.slice(1) ?? null, () => null),
    run('ps', ['-o', 'command=', '-p', String(pid)]).then(({ stdout }) => stdout.trim(), () => ''),
  ]);
  return { cwd, cmd };
}

// The folder name is what people recognize; package.json names are often terse.
function projectName(dir) {
  return path.basename(dir);
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverMetroServers() {
  const ports = await listeningNodePorts();
  const servers = await Promise.all(
    [...ports].map(async ([port, pid]) => {
      const url = `http://localhost:${port}`;
      const status = await fetchWithTimeout(`${url}/status`, 400).then(r => r.text(), () => '');
      if (!status.includes('packager-status:running')) return null;
      const { cwd, cmd } = await processInfo(pid);
      // Hitch's own private symbolication Metro is not a dev server.
      if (cmd.includes('symbol-server.mjs') || !cwd) return null;
      const pages = await fetchWithTimeout(`${url}/json/list`, 800).then(r => r.json(), () => []);
      // The same app can be open on a simulator and a phone at once.
      const apps = new Map();
      for (const page of pages) {
        if (page.webSocketDebuggerUrl && page.appId) apps.set(`${page.appId}|${page.deviceName}`, { appId: page.appId, device: page.deviceName ?? null });
      }
      return { url, port, pid, project: cwd, name: projectName(cwd), apps: [...apps.values()] };
    }),
  );
  return servers.filter(Boolean).sort((a, b) => a.port - b.port);
}

// Names of booted iOS simulators; any other device on Metro is physical.
export async function bootedSimulatorNames() {
  try {
    const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
    return new Set(Object.values(JSON.parse(stdout).devices).flat().map(d => d.name));
  } catch {
    return new Set();
  }
}
