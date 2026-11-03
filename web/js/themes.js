/* Colour themes. Each is a set of CSS variables; the player always stays dark. */
'use strict';
V.THEMES = [
  { id: 'midnight', name: 'Midnight', dark: true, c: { bg: '#0b0d12', bg2: '#141720', card: '#1b1f2a', card2: '#262b38', text: '#eef0f5', dim: '#a3abbd', faint: '#8b92a2', line: '#2a2f3d', accent: '#e50914', on: '#ffffff' } },
  { id: 'cinema', name: 'Cinema', dark: true, c: { bg: '#000000', bg2: '#121212', card: '#1c1c1c', card2: '#2a2a2a', text: '#ffffff', dim: '#b3b3b3', faint: '#929292', line: '#2e2e2e', accent: '#e50914', on: '#ffffff' } },
  { id: 'oled', name: 'OLED black', dark: true, c: { bg: '#000000', bg2: '#0a0a0a', card: '#111111', card2: '#1d1d1d', text: '#f5f5f5', dim: '#a0a0a0', faint: '#858585', line: '#1f1f1f', accent: '#ffffff', on: '#000000' } },
  { id: 'ocean', name: 'Ocean', dark: true, c: { bg: '#07131f', bg2: '#0d1d2e', card: '#13283d', card2: '#1c3651', text: '#e6f1fb', dim: '#9cb6cf', faint: '#87a0b7', line: '#1d3550', accent: '#2fa8ff', on: '#03121f' } },
  { id: 'forest', name: 'Forest', dark: true, c: { bg: '#0a120d', bg2: '#111d16', card: '#172a1f', card2: '#21382a', text: '#e8f3eb', dim: '#a1bba9', faint: '#8ba292', line: '#1f3427', accent: '#3ccf7a', on: '#06140c' } },
  { id: 'sunset', name: 'Sunset', dark: true, c: { bg: '#160b10', bg2: '#22121a', card: '#2d1722', card2: '#3d2030', text: '#fbe9ee', dim: '#d1a6b5', faint: '#ab8895', line: '#3a1f2b', accent: '#ff7a45', on: '#1f0b03' } },
  { id: 'grape', name: 'Grape', dark: true, c: { bg: '#100b1a', bg2: '#181127', card: '#221836', card2: '#2f2249', text: '#efe9fb', dim: '#b6a8d4', faint: '#968bb0', line: '#2c2142', accent: '#a46bff', on: '#12051f' } },
  { id: 'rose', name: 'Rosé', dark: true, c: { bg: '#140c10', bg2: '#1f1318', card: '#2a1a21', card2: '#38232d', text: '#fdebf1', dim: '#d6a9ba', faint: '#ab8594', line: '#36212a', accent: '#ff5c8a', on: '#22050f' } },
  { id: 'nordic', name: 'Nordic', dark: true, c: { bg: '#20242e', bg2: '#272c38', card: '#2f3542', card2: '#3b4252', text: '#eceff4', dim: '#b8c1d1', faint: '#a7aebc', line: '#3b4252', accent: '#88c0d0', on: '#1b2028' } },
  { id: 'vampire', name: 'Vampire', dark: true, c: { bg: '#1a1b26', bg2: '#21222e', card: '#282a36', card2: '#343746', text: '#f8f8f2', dim: '#c3c7dd', faint: '#9ca0b6', line: '#343746', accent: '#ff79c6', on: '#1a1b26' } },
  { id: 'neon', name: 'Neon', dark: true, c: { bg: '#05050c', bg2: '#0c0c1a', card: '#121226', card2: '#1c1c3a', text: '#f0f0ff', dim: '#a9a9e0', faint: '#8282b1', line: '#202044', accent: '#00f0ff', on: '#001014' } },
  { id: 'ember', name: 'Ember', dark: true, c: { bg: '#120d08', bg2: '#1c140d', card: '#271b11', card2: '#352517', text: '#fbefe3', dim: '#d4b89c', faint: '#a28d77', line: '#33251a', accent: '#ffb02e', on: '#1d1100' } },
  { id: 'mint', name: 'Mint', dark: true, c: { bg: '#081413', bg2: '#0e1f1d', card: '#142b28', card2: '#1d3a36', text: '#e6faf6', dim: '#9fcac2', faint: '#82a59f', line: '#1a3632', accent: '#37e2c0', on: '#03140f' } },
  { id: 'slate', name: 'Slate', dark: true, c: { bg: '#15181d', bg2: '#1c2027', card: '#232831', card2: '#2e343f', text: '#e9edf2', dim: '#a7b0bd', faint: '#959da8', line: '#2c323c', accent: '#8ab4ff', on: '#0b1426' } },
  { id: 'coffee', name: 'Coffee', dark: true, c: { bg: '#15100c', bg2: '#1e1712', card: '#291f18', card2: '#362a21', text: '#f3e9df', dim: '#c8b29c', faint: '#a29280', line: '#33281f', accent: '#d6a26b', on: '#1e1206' } },
  { id: 'retro', name: 'Retro terminal', dark: true, c: { bg: '#0a0a05', bg2: '#11110a', card: '#1a1a0f', card2: '#262614', text: '#ffcc66', dim: '#c9a050', faint: '#a98743', line: '#2b2a14', accent: '#ffb000', on: '#120c00' } },
  { id: 'royal', name: 'Royal', dark: true, c: { bg: '#0a0c1c', bg2: '#11142a', card: '#181c3a', card2: '#22284e', text: '#eef0ff', dim: '#aeb5e4', faint: '#8b91ba', line: '#1f2448', accent: '#ffd166', on: '#1a1200' } },
  { id: 'contrast', name: 'High contrast', dark: true, c: { bg: '#000000', bg2: '#000000', card: '#0d0d0d', card2: '#1f1f1f', text: '#ffffff', dim: '#ffffff', faint: '#d0d0d0', line: '#ffffff', accent: '#ffff00', on: '#000000' } },
  { id: 'light', name: 'Daylight', dark: false, c: { bg: '#f4f5f8', bg2: '#ffffff', card: '#ffffff', card2: '#e9ebf1', text: '#13161d', dim: '#4e5666', faint: '#646a78', line: '#dde0e8', accent: '#d10a14', on: '#ffffff' } },
  { id: 'paper', name: 'Paper', dark: false, c: { bg: '#f6f0e6', bg2: '#fffaf2', card: '#fffaf2', card2: '#efe6d8', text: '#2b241c', dim: '#64584a', faint: '#706659', line: '#e3d8c6', accent: '#b15229', on: '#ffffff' } },
  { id: 'arctic', name: 'Arctic', dark: false, c: { bg: '#eef5fb', bg2: '#ffffff', card: '#ffffff', card2: '#e1ecf6', text: '#0f2234', dim: '#45607a', faint: '#576c80', line: '#d5e3ef', accent: '#0972c1', on: '#ffffff' } },
  { id: 'sakura', name: 'Sakura', dark: false, c: { bg: '#fbf1f4', bg2: '#ffffff', card: '#ffffff', card2: '#f5e1e8', text: '#2c1720', dim: '#6d4b58', faint: '#7a5e69', line: '#efd6df', accent: '#c93066', on: '#ffffff' } },
  { id: 'meadow', name: 'Meadow', dark: false, c: { bg: '#f0f6ef', bg2: '#ffffff', card: '#ffffff', card2: '#e0eedd', text: '#162415', dim: '#4a6147', faint: '#5b6d57', line: '#d5e6d1', accent: '#267e36', on: '#ffffff' } },
  { id: 'candy', name: 'Candy', dark: false, c: { bg: '#fdf6ff', bg2: '#ffffff', card: '#ffffff', card2: '#f2e3fb', text: '#271533', dim: '#644d75', faint: '#725f80', line: '#ead8f5', accent: '#9c36ff', on: '#ffffff' } },
  { id: 'sand', name: 'Sand', dark: false, c: { bg: '#f7f2e8', bg2: '#fffdf8', card: '#fffdf8', card2: '#efe6d3', text: '#2a2418', dim: '#665a43', faint: '#6f6653', line: '#e7dcc6', accent: '#996300', on: '#ffffff' } },
];

V.theme = function (id) { for (var i = 0; i < V.THEMES.length; i++) if (V.THEMES[i].id === id) return V.THEMES[i]; return V.THEMES[0]; };

V.applyTheme = function (id) {
  V.themeChosen = id;
  var t = V.theme(id === 'auto' ? (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'midnight') : id);
  var r = document.documentElement;
  Object.keys(t.c).forEach(function (k) { r.style.setProperty('--' + k, t.c[k]); });
  r.dataset.theme = t.id;
  r.style.colorScheme = t.dark ? 'dark' : 'light';
  r.classList.toggle('theme-light', !t.dark);
  var meta = V.$('meta[name=theme-color]');
  if (meta) meta.content = t.c.bg;
};

// "Match my device": follow the device when it switches between light and dark (at sunset, say) without a reload.
(function () {
  var mq = window.matchMedia && matchMedia('(prefers-color-scheme: light)');
  if (!mq) return;
  var follow = function () { if (V.themeChosen === 'auto') V.applyTheme('auto'); };
  if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
})();

/** A tiny picture of the app in a theme (for the theme picker). */
V.themePreview = function (t) {
  var c = t.c;
  return '<svg viewBox="0 0 120 72" class="tp" aria-hidden="true"><rect width="120" height="72" rx="8" fill="' + c.bg + '"/>' +
    '<rect x="0" y="0" width="120" height="12" fill="' + c.bg2 + '"/><circle cx="8" cy="6" r="3" fill="' + c.accent + '"/><rect x="16" y="4" width="22" height="4" rx="2" fill="' + c.dim + '"/>' +
    '<rect x="8" y="18" width="62" height="22" rx="4" fill="' + c.card2 + '"/><rect x="12" y="30" width="26" height="5" rx="2.5" fill="' + c.accent + '"/><rect x="12" y="22" width="40" height="4" rx="2" fill="' + c.text + '"/>' +
    [0, 1, 2, 3].map(function (i) { return '<rect x="' + (8 + i * 27) + '" y="46" width="23" height="18" rx="3" fill="' + c.card + '" stroke="' + c.line + '"/>'; }).join('') +
    '<rect x="76" y="18" width="36" height="5" rx="2.5" fill="' + c.text + '"/><rect x="76" y="27" width="28" height="4" rx="2" fill="' + c.faint + '"/></svg>';
};
