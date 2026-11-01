'use strict';
const fs = require('fs');
const path = require('path');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const root = path.resolve(__dirname, '..');
// Optional defaults shipped next to the app (e.g. a preset brand name). Anything here can be changed in Admin.
let presets = {};
try {
  presets = JSON.parse(fs.readFileSync(path.join(root, 'defaults.json'), 'utf8'));
} catch (e) {
  // A missing file is fine; a broken one would silently drop the brand, port and allowed hosts, so say so loudly.
  if (e.code !== 'ENOENT') console.error('\n  !! defaults.json could not be read and is being IGNORED: ' + e.message + '\n     (often a missing comma between lines, or a comma after the last one)\n');
}

module.exports = {
  root,
  presets,
  version: require('../package.json').version,
  port: parseInt(arg('port') || process.env.PORT || presets.port || '8080', 10),
  // Every page needs the site password, so it listens on the whole network by default.
  host: arg('host') || process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(arg('data') || process.env.DATA_DIR || path.join(root, 'data')),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  // HTTPS: give a certificate and key (PEM files) to serve https directly.
  httpsCert: process.env.HTTPS_CERT || arg('https-cert') || '',
  httpsKey: process.env.HTTPS_KEY || arg('https-key') || '',
  // Behind a reverse proxy (Caddy, nginx, Traefik…): trust X-Forwarded-* headers.
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '') || presets.trustProxy === true,
  allowedHosts: [...(process.env.ALLOWED_HOSTS || '').split(','), ...(Array.isArray(presets.allowedHosts) ? presets.allowedHosts : [])].map((s) => String(s).trim().toLowerCase()).filter(Boolean),
  tmdbBase: process.env.TMDB_BASE || 'https://api.themoviedb.org/3',
  hwaccel: process.env.HWACCEL || '', // '', 'vaapi', 'nvenc', 'qsv', 'videotoolbox'
  vaapiDevice: process.env.VAAPI_DEVICE || '/dev/dri/renderD128',
};
