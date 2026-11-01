// The CSS fallbacks for older TV browsers must never break the stylesheet for everyone else.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { cssFallbacks } = require('../lib/cssfallbacks');

const WEB = path.join(__dirname, '..', 'web');
const order = JSON.parse(fs.readFileSync(path.join(WEB, 'order.json'), 'utf8'));
const css = order.css.map((f) => fs.readFileSync(path.join(WEB, 'css', f), 'utf8')).join('\n');

/** Every { has its }, and no ( is left open inside a declaration. */
function balanced(text) {
  let depth = 0;
  for (const ch of text.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

test('fallbacks keep the stylesheet well-formed and only add to it', () => {
  const out = cssFallbacks(css);
  assert.ok(balanced(out), 'braces balance');
  for (const decl of out.match(/(?<=[{;]\s*)[\w-]+\s*:[^;{}]*/g) || []) {
    const open = (decl.match(/\(/g) || []).length, close = (decl.match(/\)/g) || []).length;
    assert.strictEqual(open, close, `parentheses balance in: ${decl.slice(0, 120)}`);
  }
  assert.ok(!/NaN|undefined/.test(out), 'no NaN/undefined values');
  // Every original rule's selector is still there.
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?<=^|[{};])\s*([^{}@;]+?)\s*\{/g)) {
    assert.ok(out.includes(m[1].trim()), `selector kept: ${m[1].trim().slice(0, 80)}`);
  }
});

test('each kind of fallback is produced', () => {
  const out = cssFallbacks(css);
  assert.match(out, /background: #0b0d12; background: var\(--bg\)/, 'CSS variables');
  assert.match(out, /\.no-flexgap \.btn > \* \+ \* \{ margin-left: \.5em; \}/, 'flexbox gap');
  assert.match(out, /@supports not \(aspect-ratio: 1\)/, 'aspect-ratio');
  assert.match(out, /\.tv \.chip-check input:focus \+ span/, ':focus-visible');
  assert.match(out, /@supports not \(width: clamp\(1px, 1px, 1px\)\) \{ :root \{ --gutter: 56px; \} \}/, 'clamp() in a variable');
  assert.match(out, /bottom: calc\(20px \+ 0px \+ 0px\); bottom: calc\(20px \+ 0px \+ env\(safe-area-inset-bottom\)\)/, 'env()');
});

test('values with functions are kept whole', () => {
  const out = cssFallbacks('.a { display: flex; gap: clamp(1rem, 3vw, 2rem); width: min(26rem, calc(100vw - 32px)); }');
  assert.match(out, /gap: 2rem; gap: clamp\(1rem, 3vw, 2rem\)/);
  assert.match(out, /\.no-flexgap \.a > \* \+ \* \{ margin-left: 2rem; \}/);
  assert.match(out, /width: 26rem; width: min\(26rem, calc\(100vw - 32px\)\)/);
});

test('commas inside :is() and :not() do not split a selector', () => {
  const out = cssFallbacks('.q :is(.a:focus-visible, .b) { color: red; } .r:not(.x, .y) { display: flex; gap: 4px; } .z { color: blue; }');
  assert.ok(balanced(out), 'braces balance');
  assert.match(out, /\.tv \.q :is\(\.a:focus, \.b\)/);
  assert.match(out, /\.no-flexgap \.r:not\(\.x, \.y\) > \* \+ \*/);
  assert.match(out, /\.z \{ color: blue; \}/);
});
