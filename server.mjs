// Local web server for the UI: static files, a live event stream (SSE), and a
// small JSON API for source context, editor/AI hand-off, and settings.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPrompt, openInEditor, readSource, sendToClaude } from './handoff.mjs';
import { createMcp } from './mcp.mjs';
import { avoidableRows } from './engine.mjs';
import { rangePrompt, summarizeRange } from './range.mjs';
import { compareRuns, createRuns } from './runs.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
// Browsers ask for /favicon.ico whatever the page links.
const STATIC_ALIASES = { '/': 'index.html', '/favicon.ico': 'brand/favicon-32.png' };
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function readBody(req, invalid = {}) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve(invalid);
      }
    });
  });
}

// A window reload reconnects well within this; anything longer means it was closed.
const WINDOW_GONE_MS = 15000;

export function startServer({ engine, port, onWindowsClosed }) {
  // The hub can move between projects, so resolve the root per request.
  const root = () => engine.project();
  const clients = new Set();
  let windowsGone = null;

  engine.on('event', event => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(data);
  });

  const findEvent = id => {
    const h = engine.history();
    return [h.stalls, h.hot, h.alerts ?? [], h.console ?? [], h.requests ?? [], h.startups ?? [], h.jank ?? [], h.screens ?? []].flat().find(e => e.id === id) ?? null;
  };

  // The plain log lines leading up to an event: what the app said it was doing.
  const logsBefore = at => (engine.history().logs ?? []).filter(l => l.lastAt >= at - 5000 && l.at <= at + 500).slice(-15);

  const withContext = event => {
    const recentLogs = logsBefore(event.at);
    if (event.type === 'request') return { ...event, recentLogs, responseBody: engine.responseBody?.(event.id) ?? null };
    if (event.type !== 'stall') return { ...event, recentLogs };
    const key = event.culprits[0]?.key;
    const occurrences = key ? engine.history().stalls.filter(s => s.culprits[0]?.key === key).map(s => s.ms) : [event.ms];
    return { ...event, recentLogs, occurrences, thresholdMs: engine.status().settings.stallMs };
  };

  const runs = createRuns({ engine, root });
  const serveMcp = createMcp({ engine, findEvent, withContext, root, runs });

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const { servers, phones, current } = engine.servers();
      res.write(`data: ${JSON.stringify({ type: 'snapshot', status: engine.status(), ...engine.history(), servers, phones, current })}\n\n`);
      clients.add(res);
      clearTimeout(windowsGone);
      req.on('close', () => {
        clients.delete(res);
        if (!clients.size && onWindowsClosed) windowsGone = setTimeout(onWindowsClosed, WINDOW_GONE_MS);
      });
      return;
    }

    if (url.pathname === '/mcp') return serveMcp(req, res, readBody);

    if (url.pathname === '/api/source') {
      const src = readSource(root(), url.searchParams.get('file') ?? '', Number(url.searchParams.get('line')), Number(url.searchParams.get('context') ?? 8));
      return src ? json(res, 200, src) : json(res, 404, { error: 'not found' });
    }

    if (req.method === 'POST' && url.pathname === '/api/open') {
      const { file, line } = await readBody(req);
      return openInEditor(root(), file, line).then(
        editor => json(res, 200, { editor }),
        error => json(res, 500, { error: error.message }),
      );
    }

    // A slice of the timeline: what happened between two moments.
    const rangeOf = params => {
      const from = Number(params.from);
      const to = Number(params.to);
      return Number.isFinite(from) && Number.isFinite(to) && to > from ? summarizeRange(engine.history(), from, to, engine.renders?.(from, to)) : null;
    };

    if (url.pathname === '/api/range') {
      const range = rangeOf(Object.fromEntries(url.searchParams));
      return range ? json(res, 200, range) : json(res, 400, { error: 'from and to are required' });
    }

    if (url.pathname === '/api/react') {
      const seconds = Math.min(120, Number(url.searchParams.get('seconds')) || 60);
      const to = Date.now();
      return json(res, 200, { commits: engine.reactCommits?.() ?? [], summary: engine.renders?.(to - seconds * 1000, to) ?? null, avoidable: avoidableRows(engine.history().stalls ?? []), probe: engine.status().health?.probe ?? 'off' });
    }

    if (url.pathname === '/api/response') {
      const body = engine.responseBody?.(Number(url.searchParams.get('id')));
      return body ? json(res, 200, body) : json(res, 404, { error: 'No body kept for this request (only the last 150 are kept, and failed requests have none).' });
    }

    if (url.pathname === '/api/heap') {
      return json(res, 200, { snapshots: engine.heapLabels?.() ?? [] });
    }

    if (req.method === 'POST' && url.pathname === '/api/heap/snapshot') {
      const { label } = await readBody(req);
      return Promise.resolve(engine.heapSnapshot?.(String(label || 'snapshot')))
        .then(
          summary => json(res, 200, { label: summary.label, count: summary.count, size: summary.size, groups: summary.groups.slice(0, 15) }),
          error => json(res, 500, { error: error.message }),
        );
    }

    if (url.pathname === '/api/heap/diff') {
      try {
        const diff = engine.heapDiff(url.searchParams.get('before'), url.searchParams.get('after'));
        return json(res, 200, { countDelta: diff.countDelta, sizeDelta: diff.sizeDelta, grew: diff.grew });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    if (url.pathname === '/api/prompt' && url.searchParams.has('from')) {
      const range = rangeOf(Object.fromEntries(url.searchParams));
      return range ? json(res, 200, { prompt: rangePrompt(range) }) : json(res, 400, { error: 'bad range' });
    }

    if (url.pathname === '/api/prompt') {
      const event = findEvent(Number(url.searchParams.get('id')));
      return event ? json(res, 200, { prompt: buildPrompt(withContext(event), root()) }) : json(res, 404, { error: 'unknown event' });
    }

    if (req.method === 'POST' && url.pathname === '/api/handoff') {
      const body = await readBody(req);
      const { id } = body;
      if (body.from != null) {
        const range = rangeOf(body);
        if (!range) return json(res, 400, { error: 'bad range' });
        return sendToClaude(rangePrompt(range), root(), `range-${range.from}-${Date.now()}`).then(
          file => json(res, 200, { file }),
          error => json(res, 500, { error: error.message }),
        );
      }
      const event = findEvent(id);
      if (!event) return json(res, 404, { error: 'unknown event' });
      const prompt = buildPrompt(withContext(event), root());
      return sendToClaude(prompt, root(), `${event.type}-${event.id}-${Date.now()}`).then(
        file => json(res, 200, { file }),
        error => json(res, 500, { error: error.message }),
      );
    }

    if (req.method === 'POST' && url.pathname === '/api/attach') {
      const { metro, app, device, phone, bundleId } = await readBody(req);
      return engine.attachTo
        ? engine.attachTo({ metro, app, device, phone, bundleId }).then(() => json(res, 200, { ok: true }), error => json(res, 400, { error: error.message }))
        : json(res, 400, { error: 'saved session' });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      engine.setSettings(await readBody(req));
      return json(res, 200, engine.status().settings);
    }

    if (req.method === 'POST' && url.pathname === '/api/reload') {
      const res2 = await engine.reloadApp();
      return json(res, res2?.error ? 500 : 200, res2?.error ?? { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/sample') {
      engine.sampleNow();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/clear') {
      engine.clear();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/run/start') {
      const { name } = await readBody(req);
      try {
        const run = runs.start(name);
        engine.emit('event', { type: 'run', active: { name: run.name, startedAt: run.startedAt } });
        return json(res, 200, run);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/run/stop') {
      return runs.stop().then(
        result => {
          engine.emit('event', { type: 'run', active: null, finished: result });
          return json(res, 200, result);
        },
        error => json(res, 400, { error: error.message }),
      );
    }

    if (url.pathname === '/api/runs') {
      const list = runs.list(url.searchParams.get('name') || undefined);
      return json(res, 200, { active: runs.active(), runs: list, compare: list.length > 1 ? compareRuns(list.at(-2).summary, list.at(-1).summary) : null });
    }

    if (req.method === 'POST' && url.pathname === '/api/profile') {
      const { seconds } = await readBody(req);
      return engine.profile(Math.min(30, Math.max(1, Number(seconds) || 5))).then(
        result => json(res, result ? 200 : 500, result ?? { error: "couldn't record a profile" }),
        error => json(res, 500, { error: error.message }),
      );
    }

    if (req.method === 'POST' && url.pathname === '/api/report') {
      return json(res, 200, { file: engine.writeReport() });
    }

    const file = path.join(UI_DIR, STATIC_ALIASES[url.pathname] ?? url.pathname);
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
