'use strict';
// Genre names from providers and TMDB, tidied so the same genre groups together (lib/catalog.js genresOf).
const test = require('node:test');
const assert = require('node:assert');
const { genresOf } = require('../lib/catalog');

test('genre names from anywhere become the same names', () => {
  const cases = [
    ['Comedy.', ['Comedy']], ['  - drama ', ['Drama']], ['Talk-Show', ['Talk']], ['Talk Show', ['Talk']],
    ['MystèRe', ['Mystery']], ['Krimi', ['Crime']], ['Familie', ['Family']], ['Dokumentarfilm', ['Documentary']],
    ['Action &amp; Adventure', ['Action', 'Adventure']], ['Sci-Fi & Fantasy', ['Science Fiction', 'Fantasy']],
    ['Comédie, Drame', ['Comedy', 'Drama']], ['War & Politics', ['War', 'Politics']], ['Silent Movies', ['Silent']],
    [['Comedy.', 'Comedy'], ['Comedy']], ['Teen Sitcom Fantasy', ['Teen Sitcom Fantasy']], ['teen-drama', ['Teen-Drama']],
    ['', []], ['1999', []],
  ];
  for (const [input, want] of cases) assert.deepStrictEqual(genresOf(input), want, JSON.stringify(input));
});
