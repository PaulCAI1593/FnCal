// Minimal namespace-tolerant XML reader/writer for the CalDAV spike.
// Built-in modules only. Not a general XML implementation: it understands the
// element/attribute shapes DAV clients actually send (no DTDs, no entities
// beyond the predefined five, comments/PIs skipped).
// RFC 4918 §14 is the anchor for the wire format we accept.

/** `D:prop` -> `prop`; `prop` -> `prop`. */
export function localName(name) {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

function parseAttrs(source) {
  const attrs = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(source))) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/**
 * Parse XML into a lightweight tree.
 * Node shape: { name, local, attrs, children, text }. The document root has
 * name/local '#document'; element text is concatenated and whitespace-collapsed.
 */
export function parseXml(xml) {
  const source = xml == null ? '' : String(xml);
  const root = { name: '#document', local: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/?([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(source))) {
    const between = source.slice(last, m.index);
    if (between.trim()) stack[stack.length - 1].text += decodeEntities(between.replace(/\s+/g, ' '));
    last = re.lastIndex;

    if (m[0].startsWith('<!--') || m[0].startsWith('<?')) continue;
    if (m[0].startsWith('<![CDATA[')) {
      stack[stack.length - 1].text += m[1] ?? '';
      continue;
    }
    const closing = m[0][1] === '/';
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = {
      name: m[2],
      local: localName(m[2]),
      attrs: parseAttrs(m[3] ?? ''),
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

/** Depth-first collect of elements by local name. */
export function findAll(node, local) {
  const out = [];
  const walk = (n) => {
    for (const child of n.children) {
      if (child.local === local) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** First element by local name, or null. */
export function find(node, local) {
  for (const child of node.children) {
    if (child.local === local) return child;
    const nested = find(child, local);
    if (nested) return nested;
  }
  return null;
}

/** All attributes of the first element with `local`, or {} when absent. */
export function attrsOf(node, local) {
  const found = find(node, local);
  return found ? found.attrs : {};
}

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
