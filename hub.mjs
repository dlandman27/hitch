// Owns the current engine and lets the UI move it between Metro servers and
// apps. Exposes the same surface as an engine, so the server never cares
// which one is live.

import path from 'node:path';
import { EventEmitter } from 'node:events';

import { listPhysicalDevices, listProfilableApps, startDeviceEngine } from './device.mjs';
import { discoverMetroServers } from './discovery.mjs';
import { startEngine } from './engine.mjs';

const DISCOVERY_MS = 3000;
// devicectl takes a second or two per call; phones change rarely.
const PHONE_DISCOVERY_MS = 15000;

export function startHub(opts) {
  const hub = new EventEmitter();
  const settings = { stallMs: opts.stallMs, uiHot: opts.uiHot, threadHot: opts.threadHot };
  let servers = [];
  let phones = [];
  let engine = null;
  let target = null;
  let switching = Promise.resolve();

  // Phone targets carry device handles; the UI only needs ids.
  const serializable = t => (t?.phone ? { phone: t.phone.udid, bundleId: t.phoneApp.bundleId, project: t.project } : t);
  const serversEvent = () => ({ type: 'servers', servers, phones, current: serializable(target) });

  const attach = next => {
    switching = switching.then(async () => {
      if (engine) {
        engine.removeAllListeners();
        await engine.stop();
      }
      target = next;
      engine = next.phone
        ? startDeviceEngine({ device: next.phone, app: next.phoneApp, settings, chunkSec: opts.phoneChunkSec ?? 20 })
        : startEngine({ ...opts, ...settings, metro: next.metro, project: next.project, app: next.app, device: next.device ?? null });
      engine.on('event', event => {
        if (event.type === 'status') Object.assign(settings, event.settings);
        hub.emit('event', event);
      });
      engine.on('log', message => hub.emit('log', message));
      hub.emit('event', { type: 'snapshot', status: engine.status(), ...engine.history(), servers, phones, current: serializable(target) });
    });
    return switching;
  };

  const sameTarget = (a, b) => a && b && a.metro === b.metro && (a.app ?? null) === (b.app ?? null) && (a.device ?? null) === (b.device ?? null);

  // First pick: an explicit --metro, else the server running from this folder,
  // else any server with an app connected, else the first one found.
  const initialTarget = list => {
    if (opts.metroExplicit) return { metro: opts.metro, project: opts.project, app: opts.app };
    const here = list.find(s => s.project === opts.project);
    const pick = here ?? list.find(s => s.apps.length) ?? list[0];
    if (!pick) return null;
    return { metro: pick.url, project: opts.projectExplicit ? opts.project : pick.project, app: opts.app };
  };

  const refresh = async () => {
    servers = await discoverMetroServers().catch(() => servers);
    if (!engine) {
      const first = initialTarget(servers);
      if (first) await attach(first);
    }
    hub.emit('event', serversEvent());
  };

  const refreshPhones = async () => {
    const devices = await listPhysicalDevices();
    phones = await Promise.all(devices.map(async device => ({ ...device, apps: await listProfilableApps(device) })));
    hub.emit('event', serversEvent());
  };

  refresh();
  refreshPhones();
  const timer = setInterval(refresh, DISCOVERY_MS);
  const phoneTimer = setInterval(refreshPhones, PHONE_DISCOVERY_MS);

  hub.servers = serversEvent;
  hub.attachTo = ({ metro, app, device, phone, bundleId }) => {
    if (phone) {
      const found = phones.find(p => p.udid === phone);
      const phoneApp = found?.apps.find(a => a.bundleId === bundleId);
      if (!found || !phoneApp) return Promise.reject(new Error('phone or app not found'));
      return attach({ phone: found, phoneApp, project: opts.project }).then(() => hub.emit('event', serversEvent()));
    }
    const server = servers.find(s => s.url === metro);
    if (!server) return Promise.reject(new Error('unknown Metro server'));
    const next = { metro, project: server.project, app: app ?? null, device: app ? device ?? null : null };
    if (sameTarget(next, target)) return Promise.resolve();
    return attach(next).then(() => hub.emit('event', serversEvent()));
  };
  hub.project = () => target?.project ?? opts.project;
  hub.target = () => target;

  const idleStatus = () => ({ type: 'status', state: 'no-server', appId: null, device: null, native: false, settings, project: opts.project });
  hub.status = () => engine?.status() ?? idleStatus();
  hub.history = () => engine?.history() ?? { stalls: [], hot: [], lanes: [], alerts: [], vitals: [], requests: [], console: [], logs: [], startups: [], jank: [], screens: [] };
  hub.setSettings = patch => engine?.setSettings(patch);
  hub.clear = () => engine?.clear();
  hub.sampleNow = () => engine?.sampleNow();
  hub.reloadApp = () => engine?.reloadApp();
  hub.writeReport = () => engine?.writeReport();
  // Only the dev-build engine has these; a phone (Release) session doesn't.
  hub.profile = seconds => (engine?.profile ? engine.profile(seconds) : Promise.reject(new Error('profiling needs a dev build attached through Metro')));
  hub.heapSnapshot = label => (engine?.heapSnapshot ? engine.heapSnapshot(label) : Promise.reject(new Error('heap snapshots need a dev build attached through Metro')));
  hub.heapDiff = (a, b) => {
    if (!engine?.heapDiff) throw new Error('heap snapshots need a dev build attached through Metro');
    return engine.heapDiff(a, b);
  };
  hub.heapLabels = () => engine?.heapLabels?.() ?? [];
  hub.renders = (from, to) => engine?.renders?.(from, to) ?? null;
  hub.reactCommits = () => engine?.reactCommits?.() ?? [];
  hub.profileWindow = (ms, reason) => engine?.profileWindow?.(ms, reason);
  hub.stopProfileWindow = () => engine?.stopProfileWindow?.();
  hub.stop = async () => {
    clearInterval(timer);
    clearInterval(phoneTimer);
    await switching;
    await engine?.stop();
  };
  hub.describeTarget = () => (target?.phone ? `${target.phoneApp.bundleId} on ${target.phone.name} (Release, profiler)` : target ? `${path.basename(target.project)} via ${target.metro}` : 'no Metro server yet');
  return hub;
}
