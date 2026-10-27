// Turns the debugger's console arguments (CDP RemoteObjects) into the text a
// developer would see in DevTools: printf placeholders filled in, objects shown
// by their contents rather than "Object", errors by name and message.

const MAX_PROPS = 12;

const quote = s => `'${s}'`;

// A value inside an object preview: strings quoted, objects by their short description.
function previewValue(p) {
  if (p.type === 'string') return quote(p.value ?? '');
  if (p.type === 'object' && p.subtype === 'null') return 'null';
  if (p.type === 'undefined') return 'undefined';
  if (p.type === 'function') return 'ƒ';
  return p.value ?? p.description ?? p.type;
}

// { type, subtype, properties: [{ name, type, subtype, value }], overflow } → "{a: 1, b: 'x'}"
export function renderPreview(preview) {
  const props = preview.properties ?? [];
  const more = preview.overflow || props.length > MAX_PROPS ? ', …' : '';
  const shown = props.slice(0, MAX_PROPS);
  if (preview.subtype === 'array') {
    const items = shown.filter(p => /^\d+$/.test(p.name)).map(previewValue);
    return `[${items.join(', ')}${more}]`;
  }
  const body = shown.map(p => `${p.name}: ${previewValue(p)}`).join(', ');
  const name = preview.description && !/^(Object|Array\(\d+\))$/.test(preview.description) ? `${preview.description} ` : '';
  return `${name}{${body}${more}}`;
}

// Runtime.getProperties result → a preview in the same shape the debugger would send.
export function previewFromProperties(remote, properties) {
  // An Error's message and stack are non-enumerable, and they're the point.
  const own = properties.filter(p => (p.enumerable !== false || remote.subtype === 'error') && p.name !== '__proto__' && p.value);
  return {
    type: remote.type,
    subtype: remote.subtype,
    description: remote.description,
    overflow: own.length > MAX_PROPS,
    properties: own.slice(0, MAX_PROPS + 1).map(p => ({
      name: p.name,
      type: p.value.type,
      subtype: p.value.subtype,
      value: p.value.type === 'string' ? p.value.value : p.value.value !== undefined && p.value.type !== 'object' ? String(p.value.value) : p.value.description,
    })),
  };
}

// Errors print as their stack (which starts with "Name: message"), like DevTools.
function errorText(a) {
  const description = a.description ?? '';
  if (/^\w*Error\b.*:/.test(description) || description.includes('\n')) return description;
  const props = Object.fromEntries((a.preview?.properties ?? []).map(p => [p.name, p.value]));
  return props.message ? `${props.name ?? description ?? 'Error'}: ${props.message}` : description || 'Error';
}

// One argument as top-level console text. `expanded` is a preview fetched
// separately when the debugger didn't attach one.
export function argText(a, expanded) {
  if (!a) return '';
  if (a.type === 'string') return a.value ?? '';
  if (a.type === 'undefined') return 'undefined';
  if (a.unserializableValue) return a.unserializableValue;
  if (a.type === 'object' && a.subtype === 'null') return 'null';
  if (a.type === 'object' && a.subtype === 'error') return errorText(expanded ? { ...a, preview: expanded } : a);
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  if (a.type === 'function') return (a.description ?? 'ƒ').split('\n')[0].slice(0, 120);
  const preview = a.preview ?? expanded;
  if (a.type === 'object' && preview?.properties) return renderPreview({ ...preview, description: preview.description ?? a.description });
  return a.description ?? a.type;
}

const toNumber = (a, parse) => {
  const raw = a?.value ?? a?.unserializableValue ?? a?.description;
  const n = parse(String(raw));
  return Number.isNaN(n) ? 'NaN' : String(n);
};

// console.log('%s failed: %d', name, code) → "save failed: 3", like DevTools.
// `expanded` maps an argument's index to a fetched preview.
export function formatConsoleArgs(args, expanded = new Map()) {
  const text = i => argText(args[i], expanded.get(i));
  if (!args.length) return '';
  if (args[0].type !== 'string' || !args[0].value?.includes('%')) return args.map((_, i) => text(i)).join(' ');
  let next = 1;
  const head = args[0].value.replace(/%([sdifoOc%])/g, (match, spec) => {
    if (spec === '%') return '%';
    if (next >= args.length) return match;
    const i = next++;
    if (spec === 'c') return '';
    if (spec === 'd' || spec === 'i') return toNumber(args[i], s => parseInt(s, 10));
    if (spec === 'f') return toNumber(args[i], parseFloat);
    return text(i);
  });
  const rest = args.slice(next).map((_, k) => text(next + k));
  return [head, ...rest].join(' ');
}

// Messages that differ only by ids, counts or times are the same message.
export function fingerprint(text) {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<time>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/-?\d+(\.\d+)?/g, '<n>');
}
