'use strict';
// A film's file too far from its running time to be that film (web/js/player.js V.lengthOff): what counts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'player.js'), 'utf8');
const V = {};
new Function('V', /V\.lengthOff = function[\s\S]*?\n\};/.exec(SRC)[0])(V);
const min = (m) => m * 60;

test('a real copy passes: PAL speed, credits cut, an unrated or extended cut', () => {
  assert.strictEqual(V.lengthOff(min(103), min(103), 'Home Alone'), false);
  assert.strictEqual(V.lengthOff(min(85), min(93), 'Other Mommy'), false, '91% (seen on this server)');
  assert.strictEqual(V.lengthOff(min(96 * 0.96), min(96), 'A film'), false, 'European TV speed');
  assert.strictEqual(V.lengthOff(min(85), min(100), 'A film'), false, 'the credits left off');
  assert.strictEqual(V.lengthOff(min(263), min(201), 'The Lord of the Rings: The Return of the King'), false, 'extended, not said so (131%)');
  assert.strictEqual(V.lengthOff(min(209), min(149), 'Das Boot'), false, 'the director’s cut, 140%');
  assert.strictEqual(V.lengthOff(min(242), min(155), 'Some Film (Extended Edition)'), false, '156%, and it says so');
  assert.strictEqual(V.lengthOff(min(240), min(155), 'Some Film - Director’s Cut'.replace('’', "'")), false);
});

test('another video under its name is caught', () => {
  assert.strictEqual(V.lengthOff(min(58), min(108), 'The Cat in the Hat'), true, '54% (seen on this server)');
  assert.strictEqual(V.lengthOff(min(82), min(108), 'The Cat in the Hat'), true, 'the 2003 film under the 2026 one’s name (76%)');
  assert.strictEqual(V.lengthOff(min(25), min(108), 'The Cat in the Hat'), true, 'the 1971 cartoon');
  assert.strictEqual(V.lengthOff(min(2), min(95), 'A film'), true, 'a trailer');
  assert.strictEqual(V.lengthOff(min(150), min(100), 'A film'), true, '150%, not said to be a longer cut');
  assert.strictEqual(V.lengthOff(min(170), min(100), 'A film (Extended)'), true, 'too long even for one');
  assert.strictEqual(V.lengthOff(0, min(100), 'A film'), false, 'nothing to go on');
});
