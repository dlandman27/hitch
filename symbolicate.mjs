// Maps Hermes bundle positions back to source files. Fetches each bundle's
// full source map once from the (private) Metro and does lookups locally.

import fs from 'node:fs';
import path from 'node:path';

const B64 = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));

// Returns per generated line an array of [genCol, srcIdx, srcLine, srcCol] (0-based).
function decodeMappings(mappings) {
  const lines = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  let segments = [];
  let genCol = 0;
  let i = 0;
  const readVlq = () => {
    let value = 0;
    let shift = 0;
    let digit;
    do {
      digit = B64.get(mappings[i++]);
      value += (digit & 31) << shift;
      shift += 5;
    } while (digit & 32);
    return value & 1 ? -(value >>> 1) : value >>> 1;
  };
  while (i <= mappings.length) {
    const c = mappings[i];
    if (c === ';' || i === mappings.length) {
      lines.push(segments);
      segments = [];
      genCol = 0;
      i++;
      continue;
    }
    if (c === ',') {
      i++;
      continue;
    }
    genCol += readVlq();
    const next = mappings[i];
    if (next === undefined || next === ',' || next === ';') {
      segments.push([genCol, -1, 0, 0]);
      continue;
    }
    srcIdx += readVlq();
    srcLine += readVlq();
    srcCol += readVlq();
    if (mappings[i] !== undefined && mappings[i] !== ',' && mappings[i] !== ';') readVlq();
    segments.push([genCol, srcIdx, srcLine, srcCol]);
  }
  return lines;
}

function onServer(url, metroUrl) {
  const parsed = new URL(url);
  return `${metroUrl}${parsed.pathname}${parsed.search}`;
}

// Serializer plugins (debug-id / SDK snippets) can prepend lines to the bundle
// without shifting the map, and two Metro instances can lay the same modules
// out in a different order (a long-running Metro appends modules added by a
// pull; a fresh one orders them from scratch). So every module is placed on
// its own: its `__d(..., "path")` footer in the bundle the app runs, matched to
// where the map puts that module. A frame uses the offset of the module it
// sits in. A module counts as placed when, at that offset, its lines map back
// to it in the map; the share placed says whether the map fits at all.
const FOOTER = /^},\d+,\[[^\]]*\],"(.+)"\);$/;
export function calibrateOffset(bundleText, lines, sources) {
  const sourceIndex = new Map(sources.map((source, i) => [source, i]));
  // Where each module ends in the map; modules with no mappings (JSON,
  // re-export files) can't be placed and don't count.
  const lastLine = new Map();
  lines.forEach((segments, line) => {
    for (const seg of segments) if (seg[1] >= 0) lastLine.set(seg[1], line);
  });
  const fits = (from, to, offset, idx) => {
    let mapped = 0;
    let own = 0;
    for (let l = from; l <= to; l++) {
      const segments = lines[l - offset];
      if (!segments?.length || segments.every(seg => seg[1] < 0)) continue;
      mapped += 1;
      if (segments.some(seg => seg[1] === idx)) own += 1;
    }
    return mapped > 0 && own / mapped >= 0.9;
  };
  let checked = 0;
  let placed = 0;
  const footerLines = [];
  const offsets = [];
  const bundleLines = bundleText.split('\n');
  let moduleStart = 0;
  for (let l = 0; l < bundleLines.length; l++) {
    const match = bundleLines[l].length < 400 && bundleLines[l].match(FOOTER);
    if (!match) continue;
    const idx = sourceIndex.get(match[1]);
    if (idx !== undefined && lastLine.has(idx)) {
      // The footer names the module, so its offset holds even when some of its
      // lines don't line up; the fit check only measures overall agreement.
      checked += 1;
      const offset = l - lastLine.get(idx);
      footerLines.push(l);
      offsets.push(offset);
      if (fits(moduleStart, l, offset, idx)) placed += 1;
    }
    moduleStart = l + 1;
  }
  const counts = new Map();
  for (const d of offsets) counts.set(d, (counts.get(d) ?? 0) + 1);
  return {
    offset: [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0,
    footerLines,
    offsets,
    agreement: checked ? placed / checked : null,
  };
}

// The offset for a bundle line: that of the module it belongs to.
export function offsetAt(map, line) {
  const { footerLines, offsets } = map;
  if (!footerLines?.length) return map.offset ?? 0;
  let lo = 0;
  let hi = footerLines.length - 1;
  if (line > footerLines[hi]) return offsets[hi];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (footerLines[mid] < line) lo = mid + 1;
    else hi = mid;
  }
  return offsets[lo];
}

// Below this share of agreeing modules the map and the running bundle come
// from different code, and every app line it gives would be a guess.
export const MIN_AGREEMENT = 0.95;
const MISMATCH_RETRIES = 6;
const MISMATCH_RETRY_MS = 5000;

export function createSymbolicator({ metroUrl: initialUrl, appMetroUrl, projectRoot, onHealth }) {
  let metroUrl = initialUrl;
  const maps = new Map();
  let lastError = null;
  const health = { agreement: null, mismatch: false, checkedAt: null };
  const report = patch => {
    Object.assign(health, patch);
    onHealth?.({ ...health });
  };

  const normalizeSource = source => {
    const cleaned = decodeURIComponent(source).replace(/^\/?\[metro-project\]\//, '').replace(/^file:\/\//, '');
    return path.isAbsolute(cleaned) ? path.relative(projectRoot, cleaned) : cleaned;
  };

  // The map comes from Hitch's private Metro; the bundle text from the app's
  // own Metro when we know it, so calibration checks what the app really runs.
  const fetchMap = async bundleUrl => {
    const [map, bundleText] = await Promise.all([
      fetch(onServer(bundleUrl.replace('.bundle', '.map'), metroUrl)).then(res => {
        if (!res.ok) throw new Error(`source map HTTP ${res.status}`);
        return res.json();
      }),
      fetch(onServer(bundleUrl, appMetroUrl ?? metroUrl))
        .then(res => (res.ok ? res.text() : Promise.reject(new Error(`bundle HTTP ${res.status}`))))
        .catch(() => fetch(onServer(bundleUrl, metroUrl)).then(res => res.text())),
    ]);
    const lines = decodeMappings(map.mappings);
    const sources = map.sources.map(normalizeSource);
    return { lines, sources, ...calibrateOffset(bundleText, lines, sources) };
  };

  // Right after a pull the private Metro can still be catching up on changed
  // files: retry until its map agrees with the bundle, then trust it.
  const loadVerified = async bundleUrl => {
    const started = generation;
    let loaded = null;
    for (let attempt = 0; attempt <= MISMATCH_RETRIES; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, MISMATCH_RETRY_MS));
      // The app reloaded meanwhile: a newer load owns this bundle now.
      if (started !== generation) return null;
      loaded = await fetchMap(bundleUrl);
      const ok = loaded.agreement == null || loaded.agreement >= MIN_AGREEMENT;
      report({ agreement: loaded.agreement, mismatch: !ok, checkedAt: Date.now() });
      if (ok) return loaded;
    }
    return { ...loaded, mismatch: true };
  };

  let generation = 0;
  const loadMap = bundleUrl => {
    if (!maps.has(bundleUrl)) {
      maps.set(
        bundleUrl,
        loadVerified(bundleUrl).catch(error => {
          lastError = error.message;
          maps.delete(bundleUrl);
          return null;
        }),
      );
    }
    return maps.get(bundleUrl);
  };

  const fileLines = new Map();
  const readLine = (file, index) => {
    if (!fileLines.has(file)) {
      try {
        fileLines.set(file, fs.readFileSync(path.resolve(projectRoot, file), 'utf8').split('\n'));
      } catch {
        fileLines.set(file, []);
      }
    }
    return fileLines.get(file)[index]?.trim().slice(0, 100) ?? null;
  };

  // A frame whose function name isn't in the file it mapped to means the app
  // runs an older bundle than Metro serves now (null = nothing to check).
  // Only app code is checked; Hermes-synthesized names (`foo$argument_0`,
  // `Class#method`) are reduced to the identifier that appears in source.
  const nameAppearsIn = (file, functionName) => {
    if (file.includes('node_modules/')) return null;
    const name = functionName?.split(/[#.]/).pop()?.split('$')[0];
    if (!name || !/^[A-Za-z_][\w]*$/.test(name) || name.length < 3 || /^(anonymous|global)$/.test(name)) return null;
    if (!fileLines.has(file)) readLine(file, 0);
    const lines = fileLines.get(file);
    return lines.length ? lines.some(line => line.includes(name)) : null;
  };

  const resolved = new Map();
  const keyOf = frame => `${frame.url}:${frame.lineNumber}:${frame.columnNumber}`;

  async function resolveAll(frames) {
    // Only bundles served over HTTP have maps (not Hitch's probe or eval'd code).
    const urls = [...new Set(frames.filter(f => /^https?:/.test(f.url ?? '')).map(f => f.url))];
    const loaded = new Map(await Promise.all(urls.map(async url => [url, await loadMap(url)])));
    for (const frame of frames) {
      const map = loaded.get(frame.url);
      if (!map || resolved.has(keyOf(frame))) continue;
      const segments = map.lines[frame.lineNumber - offsetAt(map, frame.lineNumber)] ?? [];
      // Last mapping at or before the column; a declaration column can sit
      // before the line's first mapping, so fall back to that one.
      let hit = null;
      for (const seg of segments) {
        if (seg[1] < 0) continue;
        if (seg[0] > frame.columnNumber && hit) break;
        hit = seg;
        if (seg[0] > frame.columnNumber) break;
      }
      if (!hit) continue;
      const file = map.sources[hit[1]];
      resolved.set(keyOf(frame), {
        file,
        // A mismatched map can't place app code; say so instead of guessing.
        verified: map.mismatch && !file.includes('node_modules/') ? false : nameAppearsIn(file, frame.functionName),
        snippet: readLine(file, hit[2]),
        // Hermes host objects map to fake paths; only real files count as code.
        inRepo: fs.existsSync(path.resolve(projectRoot, file)),
        line: hit[2] + 1,
        name: frame.functionName || '(anonymous)',
      });
    }
  }

  const lookup = frame => (frame.url ? resolved.get(keyOf(frame)) ?? null : null);
  const setUrl = url => {
    metroUrl = url;
  };
  // The app reloaded: its bundle may be newer than the maps we hold.
  const reset = () => {
    generation += 1;
    maps.clear();
    resolved.clear();
    fileLines.clear();
  };

  return { resolveAll, lookup, setUrl, reset, getLastError: () => lastError, health: () => ({ ...health }) };
}
