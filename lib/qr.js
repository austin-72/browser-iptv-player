'use strict';
// QR codes as SVG (lib/qrcode.js: QR Code Generator by Kazuhiko Arase, MIT licence).
const qrcode = require('./qrcode');

/** An SVG QR code for some text (a web address). */
function qrSvg(text, { size = 220, dark = '#000', light = '#fff' } = {}) {
  const q = qrcode(0, 'M');
  q.addData(String(text));
  q.make();
  const n = q.getModuleCount(), quiet = 2, total = n + quiet * 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

module.exports = { qrSvg };
