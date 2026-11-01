'use strict';
// Extra CSS for older TV browsers (no CSS variables, clamp(), flexbox gap, aspect-ratio, :focus-visible, color-mix()):
// each fallback is written so newer browsers ignore it. Used when the web app's stylesheet is bundled.

/**
 * Browsers without CSS variables (Chrome before 49 — e.g. 2017 Tizen TVs) drop every declaration that uses var().
 * Give them the default theme's values first; browsers that understand var() use the later declaration as usual.
 */
/** A selector list split at its top-level commas (not the ones inside :is(…), :not(…) and the like). */
function splitSelectors(sel) {
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(sel.slice(from, i)); from = i + 1; }
  }
  out.push(sel.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

function varFallbacks(css) {
  const root = {};
  // (The first :root block holds the defaults.)
  const first = /:root\s*\{([^{}]*)\}/.exec(css);
  if (first) first[1].replace(/(--[\w-]+)\s*:\s*([^;]+)/g, (d, k, v) => { root[k] = v.trim(); });
  const resolve = (val, depth = 0) => {
    if (depth > 6) return null;
    let failed = false;
    const out = val.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))*[^()]*))?\)/g, (m, name, fb) => {
      const v = root[name] !== undefined ? root[name] : fb !== undefined ? fb.trim() : null;
      if (v === null) { failed = true; return m; }
      return v;
    });
    if (failed) return null;
    return /var\(/.test(out) ? resolve(out, depth + 1) : out;
  };
  return css.replace(/([{;]\s*)([\w-]+)(\s*:\s*)([^;{}]*var\(--[^;{}]*)(?=[;}])/g, (m, pre, prop, colon, val) => {
    const plain = resolve(val);
    return plain && plain !== val ? `${pre}${prop}${colon}${plain}; ${prop}${colon}${val}` : m;
  });
}

/**
 * Older TV browsers ignore a whole declaration that uses color-mix(): put a simpler one in front of each
 * (the stronger of the two colours, or a light grey veil when mixing with transparent).
 * Then the other fallbacks (CSS variables, clamp(), :focus-visible, flexbox gap, aspect-ratio).
 */
function cssFallbacks(css) {
  css = varFallbacks(css);
  // env(safe-area-inset-…) (Chrome before 69): 0 there.
  css = css.replace(/([{;]\s*)([\w-]+)(\s*:\s*)([^;{}]*\benv\([^;{}]*)(?=[;}])/g, (m, pre, prop, colon, val) => {
    if (prop.startsWith('--')) return m;
    const plain = val.replace(/env\(\s*[\w-]+\s*(?:,\s*([^()]*))?\)/g, (e, fb) => (fb ? fb.trim() : '0px'));
    return plain !== val && !/env\(/.test(plain) ? `${pre}${prop}${colon}${plain}; ${prop}${colon}${val}` : m;
  });
  const C = '(var\\(--[\\w-]+\\)|#[0-9a-fA-F]{3,8}|transparent|[a-z]+)';
  const mix = new RegExp(`color-mix\\(in srgb,\\s*${C}\\s*(\\d+)%\\s*,\\s*${C}\\s*\\)`, 'g');
  const simple = (decl) => decl.replace(mix, (m, a, pct, b) => (b === 'transparent' ? (+pct >= 60 ? a : 'rgba(128,128,128,.22)') : +pct >= 50 ? a : b));
  css = css.replace(/([{;]\s*)([\w-]+\s*:[^;{}]*color-mix\([^;{}]*)(?=[;}])/g, (m, pre, decl) => `${pre}${simple(decl)}; ${decl}`);
  // clamp() / min() / max() (Chrome before 79): a plain value first, which older browsers keep and newer ones replace.
  css = css.replace(/([{;]\s*)([\w-]+)(\s*:\s*)([^;{}]*\b(?:clamp|min|max)\([^;{}]*)(?=[;}])/g, (m, pre, prop, colon, val) => {
    // (Custom properties take anything, so there a later value always wins: those go in an @supports block below.)
    if (prop.startsWith('--')) return m;
    const plain = noCompare(val);
    return plain && plain !== val ? `${pre}${prop}${colon}${plain}; ${prop}${colon}${val}` : m;
  });
  // (Right after the rule they belong to, so later rules — .tv's own values — still win.)
  css = css.replace(/(?<=^|[{};])(\s*)([^{}@;]+?)\s*\{([^{}]*)\}/g, (m, ws, sel, decls) => {
    const vars = [];
    decls.replace(/(--[\w-]+)\s*:\s*([^;]*\b(?:clamp|min|max)\([^;]*)/g, (d, prop, val) => { const plain = noCompare(val.trim()); if (plain) vars.push(`${prop}: ${plain};`); });
    return vars.length ? `${m} @supports not (width: clamp(1px, 1px, 1px)) { ${sel.replace(/\/\*[\s\S]*?\*\//g, '').trim()} { ${vars.join(' ')} } }` : m;
  });
  // :focus-visible (Chrome before 86) makes an older browser drop the whole rule — including the other selectors
  // listed with it, and the focus ring a TV remote needs. Repeat those parts in rules it understands.
  css = css.replace(/(?<=^|[{};])(\s*)([^{}@;]+?)\s*\{([^{}]*)\}/g, (m, ws, sel, decls) => {
    if (!sel.includes(':focus-visible')) return m;
    const sels = splitSelectors(sel.replace(/\/\*[\s\S]*?\*\//g, ''));
    const other = sels.filter((x) => !x.includes(':focus-visible'));
    const tv = sels.filter((x) => x.includes(':focus-visible')).map((x) => '.tv ' + x.replace(/:focus-visible/g, ':focus'));
    return `${m}${other.length ? ` ${other.join(', ')} {${decls}}` : ''} ${tv.join(', ')} {${decls}}`;
  });
  return flexGapFallbacks(css);
}

/** clamp(a, b, c) → c, min(a, b) → a, max(a, b) → a (old browsers are mostly big TV screens). '' if it can't. */
function noCompare(val) {
  for (let guard = 0; guard < 10; guard++) {
    const m = /\b(clamp|min|max)\(/.exec(val);
    if (!m) return val;
    let i = m.index + m[0].length, depth = 1, args = [], cur = '';
    for (; i < val.length && depth; i++) {
      const ch = val[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (!depth) break; }
      if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (depth) return '';
    args.push(cur.trim());
    const pick = m[1] === 'clamp' ? args[2] : args[0];
    if (!pick) return '';
    val = val.slice(0, m.index) + pick + val.slice(i + 1);
  }
  return '';
}

/**
 * Boxes sized with aspect-ratio (posters, thumbnails) collapse on browsers without it (Chrome before 88 — many 2019–21
 * TVs). For them, a zero-width spacer holds the shape open (the classic padding trick).
 */
function aspectFallbacks(css) {
  const rules = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  flat.replace(/(?<=^|[{};])\s*([^{}@;]+?)\s*\{([^{}]*)\}/g, (m, sel, decls) => {
    const a = /(?:^|;)\s*aspect-ratio\s*:\s*([\d.]+)\s*(?:\/\s*([\d.]+))?/.exec(decls);
    if (!a || /#player-layer|card-art/.test(sel)) return m;
    const pct = +((+(a[2] || 1) / +a[1]) * 100).toFixed(3);
    const sels = splitSelectors(sel);
    rules.push(`${sels.map((x) => x + '::before').join(', ')} { content: ''; float: left; width: 0; padding-top: ${pct}%; } ${sels.map((x) => x + '::after').join(', ')} { content: ''; display: block; clear: both; }`);
    return m;
  });
  // Wide cards (16:9) need their own fallback next to the poster one in the stylesheet.
  rules.push('.card.wide .card-art, .card.channel .card-art { padding-top: 56.25%; }');
  return `\n@supports not (aspect-ratio: 1) {\n${rules.join('\n')}\n}\n`;
}

/**
 * Older TV browsers (Chrome before 84, Safari before 14.1) ignore `gap` on flex boxes, so everything sits touching.
 * For them (the page marks <html class="no-flexgap">), space the children with margins instead. Each extra rule goes
 * right after the one it copies, so it stays inside the same @media block.
 */
function flexGapFallbacks(css) {
  const autoLeft = [];
  const out = css.replace(/(?<=^|[{};])(\s*)([^{}@;]+?)\s*\{([^{}]*)\}/g, (m, ws, sel, decls) => {
    sel = sel.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (/margin-left\s*:\s*auto/.test(decls)) autoLeft.push(sel);
    if (!/display\s*:\s*(inline-)?flex\b/.test(decls)) return m;
    const g = /(?:^|;)\s*gap\s*:\s*([^;!]+)/.exec(decls);
    if (!g) return m;
    // (Split "row column" at top-level spaces only: clamp(1rem, 3vw, 2rem) is one value.)
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of g[1].trim()) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (/\s/.test(ch) && !depth) { if (cur) parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur) parts.push(cur);
    if (depth || !parts.length || parts.length > 2) return m;
    const [row, col = row] = parts;
    if (/^0(px|rem|em)?$/.test(row) && /^0(px|rem|em)?$/.test(col)) return m;
    const column = /flex-direction\s*:\s*column/.test(decls);
    const wrap = /flex-wrap\s*:\s*wrap\b/.test(decls);
    const sels = splitSelectors(sel);
    const each = (suffix) => sels.map((x) => `.no-flexgap ${x} > ${suffix}`).join(', ');
    // (An icon followed by text — a text node, which `* + *` can't see — gets its space on the icon.)
    let extra = column ? `${each('* + *')} { margin-top: ${row}; }` : `${each('* + *')} { margin-left: ${col}; } ${each('.i:only-child')} { margin-right: ${col}; }`;
    if (wrap && !column) extra += ` ${each('*')} { margin-bottom: ${row}; }`;
    return `${m} ${extra}`;
  });
  // (A child pushed to the far side with margin-left: auto keeps that.)
  return out + aspectFallbacks(css) + (autoLeft.length ? `\n${autoLeft.map((x) => splitSelectors(x).map((y) => `.no-flexgap ${y}`).join(', ')).join(', ')} { margin-left: auto; }\n` : '');
}

module.exports = { cssFallbacks };
