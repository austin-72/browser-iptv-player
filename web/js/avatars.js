var _templateObject, _templateObject2, _templateObject3, _templateObject4, _templateObject5, _templateObject6, _templateObject7, _templateObject8, _templateObject9, _templateObject0, _templateObject1, _templateObject10, _templateObject11, _templateObject12, _templateObject13, _templateObject14, _templateObject15, _templateObject16, _templateObject17, _templateObject18, _templateObject19, _templateObject20, _templateObject21;
function _taggedTemplateLiteralLoose(e, t) { return t || (t = e.slice(0)), e.raw = t, e; }
/*
 * avatars.js - original, procedurally drawn profile avatars for the
 * "Who's watching?" screen. No dependencies, plain browser script.
 *
 *   window.AVATARS.count          number of avatars
 *   window.AVATARS.svg(i)         complete <svg> string (100x100 viewBox, full-bleed background)
 *   window.AVATARS.name(i)        short friendly label, e.g. "Sleepy Fox"
 *   window.AVATARS.category(i)    category name
 *   window.AVATARS.categories     [{ name, from, to, count }] in display order (from/to are inclusive)
 *
 * Every id inside an SVG is prefixed with "av<i>" so many avatars can share a page.
 * Written for old TV browsers (Chromium 68): no optional chaining / nullish coalescing / class fields.
 */
(function (root) {
  'use strict';

  var INK = '#2b2238';
  var PINK = '#ffb3c6';
  var NOSE = '#e5677f';
  var BEAK = '#ffa62b';

  /* ---------- tiny SVG helpers ---------- */
  var r1 = function r1(n) {
    return Math.round(n * 10) / 10;
  };
  var D = function D(s) {
    for (var _len = arguments.length, v = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
      v[_key - 1] = arguments[_key];
    }
    return s.map(function (t, i) {
      return t + (i < v.length ? typeof v[i] === 'number' ? r1(v[i]) : v[i] : '');
    }).join('');
  };
  var xa = function xa(e) {
    return e || '';
  };
  var C = function C(x, y, r, f, e) {
    return "<circle cx=\"" + r1(x) + "\" cy=\"" + r1(y) + "\" r=\"" + r1(r) + "\" fill=\"" + f + "\"" + xa(e) + "/>";
  };
  var E = function E(x, y, rx, ry, f, e) {
    return "<ellipse cx=\"" + r1(x) + "\" cy=\"" + r1(y) + "\" rx=\"" + r1(rx) + "\" ry=\"" + r1(ry) + "\" fill=\"" + f + "\"" + xa(e) + "/>";
  };
  var P = function P(d, f, e) {
    return "<path d=\"" + d + "\" fill=\"" + f + "\"" + xa(e) + "/>";
  };
  var L = function L(d, s, w, e) {
    return "<path d=\"" + d + "\" fill=\"none\" stroke=\"" + s + "\" stroke-width=\"" + r1(w) + "\" stroke-linecap=\"round\" stroke-linejoin=\"round\"" + xa(e) + "/>";
  };
  var R = function R(x, y, w, h, rx, f, e) {
    return "<rect x=\"" + r1(x) + "\" y=\"" + r1(y) + "\" width=\"" + r1(w) + "\" height=\"" + r1(h) + "\" rx=\"" + r1(rx) + "\" fill=\"" + f + "\"" + xa(e) + "/>";
  };
  var G = function G(inner, e) {
    return "<g" + xa(e) + ">" + inner + "</g>";
  };
  var rot = function rot(a, x, y) {
    return " transform=\"rotate(" + a + " " + x + " " + y + ")\"";
  };
  var op = function op(o) {
    return " opacity=\"" + o + "\"";
  };
  var flip = function flip(s) {
    return s + ("<g transform=\"matrix(-1 0 0 1 100 0)\">" + s + "</g>");
  }; // add mirror copy around x=50
  var R0 = function R0(f) {
    return "<rect width=\"100\" height=\"100\" fill=\"" + f + "\"/>";
  };
  var cos = function cos(a) {
    return Math.cos(a * Math.PI / 180);
  };
  var sin = function sin(a) {
    return Math.sin(a * Math.PI / 180);
  };

  /* ---------- colour helpers ---------- */
  var rgb = function rgb(h) {
    return [1, 3, 5].map(function (i) {
      return parseInt(h.substr(i, 2), 16);
    });
  };
  var mix = function mix(a, b, t) {
    var A = rgb(a),
      B = rgb(b);
    return '#' + A.map(function (v, i) {
      return ('0' + Math.round(v + (B[i] - v) * t).toString(16)).slice(-2);
    }).join('');
  };
  var dk = function dk(c, t) {
    return mix(c, INK, t == null ? 0.25 : t);
  };
  var lt = function lt(c, t) {
    return mix(c, '#ffffff', t == null ? 0.4 : t);
  };
  var lum = function lum(c) {
    var v = rgb(c);
    return (0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2]) / 255;
  };
  var hsl = function hsl(c) {
    var v = rgb(c).map(function (x) {
        return x / 255;
      }),
      mx = Math.max(v[0], v[1], v[2]),
      mn = Math.min(v[0], v[1], v[2]);
    var l = (mx + mn) / 2;
    var h = 0,
      s = 0;
    if (mx !== mn) {
      var d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === v[0] ? (v[1] - v[2]) / d + (v[1] < v[2] ? 6 : 0) : mx === v[1] ? (v[2] - v[0]) / d + 2 : (v[0] - v[1]) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  };

  /* ---------- shape generators ---------- */
  function fuzz(cx, cy, r, n, a) {
    // scalloped circle
    var d = '';
    for (var j = 0; j <= n; j++) {
      var t = j / n * 360,
        m = (j - 0.5) / n * 360;
      var px = cx + r * cos(t),
        py = cy + r * sin(t);
      d += j ? D(_templateObject || (_templateObject = _taggedTemplateLiteralLoose(["Q", " ", " ", " ", ""])), cx + (r + a) * cos(m), cy + (r + a) * sin(m), px, py) : D(_templateObject2 || (_templateObject2 = _taggedTemplateLiteralLoose(["M", " ", ""])), px, py);
    }
    return d + 'Z';
  }
  function starPath(cx, cy, Ro, Ri, n) {
    var d = '';
    for (var j = 0; j < n * 2; j++) {
      var a = -90 + j * 180 / n,
        q = j % 2 ? Ri : Ro;
      d += (j ? 'L' : 'M') + r1(cx + q * cos(a)) + ' ' + r1(cy + q * sin(a));
    }
    return d + 'Z';
  }
  var sparkle = function sparkle(x, y, s, f) {
    return P(D(_templateObject3 || (_templateObject3 = _taggedTemplateLiteralLoose(["M", " ", "Q", " ", " ", " ", "Q", " ", " ", " ", "Q", " ", " ", " ", "Q", " ", " ", " ", "Z"])), x, y - s, x, y, x + s, y, x, y, x, y + s, x, y, x - s, y, x, y, x, y - s), f || '#fff');
  };

  /* ---------- faces ---------- */
  var EXPR = ['happy', 'wink', 'cool', 'sleepy', 'tongue', 'surprised', 'love', 'grin'];
  var ADJ = {
    happy: 'Happy',
    wink: 'Winky',
    cool: 'Cool',
    sleepy: 'Sleepy',
    tongue: 'Cheeky',
    surprised: 'Amazed',
    love: 'Lovey',
    grin: 'Giggly'
  };

  // o: x,y (between the eyes), k scale, sp half eye distance, er eye size factor, my mouth offset,
  //    mw mouth width factor, on (surface colour), ink, eye, blush, bp [dx,dy], noMouth, one, flat, fang, lens
  function face(ex, o) {
    var k = o.k || 1,
      x = o.x,
      y = o.y;
    var darkOn = !!o.on && lum(o.on) < 0.36;
    var ink = o.ink || (darkOn ? '#ffffff' : INK);
    var eye = o.eye || ink;
    var sp = o.sp != null ? o.sp : 11 * k;
    var er = 4 * k * (o.er || 1);
    var my = y + (o.my != null ? o.my : 10 * k);
    var mw = k * (o.mw || 1);
    var sw = 2.6 * k;
    var xs = o.one ? [x] : [x - sp, x + sp];
    var light = lum(eye) > 0.6;
    var s = '';
    if (o.blush !== false && ex !== 'cool') {
      var bp = o.bp || [o.one ? 13 * k : sp + 3.5 * k, 7.5 * k];
      s += [-1, 1].map(function (g) {
        return E(x + g * bp[0], y + bp[1], 4.6 * k, 2.6 * k, o.blush || '#ff6f91', op(0.45));
      }).join('');
    }
    var dot = function dot(cx, r) {
      return light && !o.flat ? C(cx, y, r, eye) + C(cx, y + r * 0.12, r * 0.6, INK) + C(cx + r * 0.22, y - r * 0.18, r * 0.2, '#fff') : C(cx, y, r, eye) + C(cx + r * 0.33, y - r * 0.36, r * 0.34, '#fff', o.flat ? op(0.6) : '');
    };
    var up = function up(cx) {
      return L(D(_templateObject4 || (_templateObject4 = _taggedTemplateLiteralLoose(["M", " ", "Q", " ", " ", " ", ""])), cx - er, y + er * 0.35, cx, y - er * 1.15, cx + er, y + er * 0.35), eye, sw);
    };
    var down = function down(cx) {
      return L(D(_templateObject5 || (_templateObject5 = _taggedTemplateLiteralLoose(["M", " ", "Q", " ", " ", " ", ""])), cx - er, y - er * 0.25, cx, y + er * 0.95, cx + er, y - er * 0.25), eye, sw);
    };
    var heart = function heart(cx, z) {
      return P(D(_templateObject6 || (_templateObject6 = _taggedTemplateLiteralLoose(["M", " ", "C", " ", " ", " ", " ", " ", "C", " ", " ", " ", " ", " ", "Z"])), cx, y + z * 0.95, cx - z * 1.7, y - z * 0.1, cx - z * 0.85, y - z * 1.45, cx, y - z * 0.45, cx + z * 0.85, y - z * 1.45, cx + z * 1.7, y - z * 0.1, cx, y + z * 0.95), '#ff4d6d', darkOn ? ' stroke="#fff" stroke-width="0.8"' : '');
    };
    var smile = function smile() {
      return L(D(_templateObject7 || (_templateObject7 = _taggedTemplateLiteralLoose(["M", " ", "Q", " ", " ", " ", ""])), x - 6 * mw, my, x, my + 5.5 * mw, x + 6 * mw, my), ink, sw);
    };
    var eyes = '',
      mouth = '';
    switch (ex) {
      case 'grin':
        eyes = xs.map(up).join('');
        mouth = P(D(_templateObject8 || (_templateObject8 = _taggedTemplateLiteralLoose(["M", " ", "Q", " ", " ", " ", "Z"])), x - 7 * mw, my - k, x, my + 12 * mw, x + 7 * mw, my - k), darkOn ? INK : ink, darkOn ? " stroke=\"" + ink + "\" stroke-width=\"" + r1(1.4 * k) + "\"" : '') + E(x, my + 3.3 * mw, 3 * mw, 1.7 * mw, '#ff7b93');
        break;
      case 'wink':
        eyes = o.one ? up(x) : dot(xs[0], er) + up(xs[1]);
        mouth = smile();
        break;
      case 'sleepy':
        {
          eyes = xs.map(down).join('');
          mouth = E(x, my + k, 2.2 * mw, 2.6 * mw, ink);
          var zx = o.z ? o.z[0] : x + (o.one ? 15 * k : sp + 8 * k),
            zy = o.z ? o.z[1] : y - 13 * k;
          var z = function z(a, b, q) {
            return D(_templateObject9 || (_templateObject9 = _taggedTemplateLiteralLoose(["M", " ", "h", "l", " ", "h", ""])), a, b, q, -q, q * 1.1, q);
          };
          var zz = z(zx, zy, 5) + z(zx + 7, zy - 9, 3.5);
          mouth += L(zz, '#fff', 3.6) + L(zz, INK, 1.6);
          break;
        }
      case 'surprised':
        eyes = xs.map(function (cx) {
          return dot(cx, er * 1.28);
        }).join('');
        mouth = E(x, my + 1.5 * k, 3.2 * mw, 4 * mw, ink);
        break;
      case 'cool':
        {
          var hw = o.one ? er * 2 : Math.min(er * 1.6, sp - 1.5 * k),
            hh = er * 1.1;
          var lens = o.lens || (darkOn ? '#4fe0ff' : '#1d1b29');
          eyes = xs.map(function (cx) {
            return R(cx - hw, y - hh, hw * 2, hh * 2, hh * 0.8, lens) + L(D(_templateObject0 || (_templateObject0 = _taggedTemplateLiteralLoose(["M", " ", "l", " ", ""])), cx - hw * 0.45, y - hh * 0.15, hw * 0.4, -hh * 0.45), '#fff', 1.2 * k, op(0.75));
          }).join('');
          if (!o.one) eyes += L(D(_templateObject1 || (_templateObject1 = _taggedTemplateLiteralLoose(["M", " ", "H", ""])), x - sp + hw - k, y - hh * 0.35, x + sp - hw + k), lens, 2 * k);
          mouth = L(D(_templateObject10 || (_templateObject10 = _taggedTemplateLiteralLoose(["M", " ", "Q", " ", " ", " ", ""])), x - 5 * mw, my + k, x + mw, my + 4.5 * mw, x + 6 * mw, my - 1.5 * k), ink, sw);
          break;
        }
      case 'tongue':
        eyes = xs.map(function (cx) {
          return dot(cx, er);
        }).join('');
        mouth = P(D(_templateObject11 || (_templateObject11 = _taggedTemplateLiteralLoose(["M", " ", "V", "Q", " ", " ", " ", "Q", " ", " ", " ", "V", "Z"])), x - 3.2 * mw, my + mw, my + 5 * mw, x - 3.2 * mw, my + 8.6 * mw, x, my + 8.6 * mw, x + 3.2 * mw, my + 8.6 * mw, x + 3.2 * mw, my + 5 * mw, my + mw), '#ff6b8a') + L(D(_templateObject12 || (_templateObject12 = _taggedTemplateLiteralLoose(["M", " ", "V", ""])), x, my + 3 * mw, my + 5.6 * mw), '#d9466a', 1.2 * k) + smile();
        break;
      case 'love':
        eyes = xs.map(function (cx) {
          return heart(cx, er * 1.25);
        }).join('');
        mouth = smile();
        break;
      default:
        eyes = xs.map(function (cx) {
          return dot(cx, er);
        }).join('');
        mouth = smile();
    }
    if (o.fang && (ex === 'happy' || ex === 'wink' || ex === 'love' || ex === 'cool')) {
      mouth += flip(P(D(_templateObject13 || (_templateObject13 = _taggedTemplateLiteralLoose(["M", " ", "l", " ", "l", " ", "Z"])), x - 4.3 * mw, my + 1.2 * mw, 1.5 * mw, 3.4 * mw, 1.5 * mw, -2.6 * mw), '#fff'));
    }
    return s + eyes + (o.noMouth ? ex === 'sleepy' ? mouth.slice(mouth.indexOf('<path')) : '' : mouth);
  }
  var F = face;

  /* ---------- subjects ---------- */
  // each: n name, p palettes (p[0] = dominant colour), d(c, ex, ctx) -> markup, optional no: [blocked expressions]
  var S = {};
  S.cat = {
    n: 'Cat',
    p: [['#f6a44c', '#d9782d'], ['#aab3c5', '#7f899e'], ['#3d3b4f', '#26242f']],
    d: function d(c, ex, x) {
      var dark = lum(c[0]) < 0.36;
      var s = flip(P('M17 52L21 11L47 33Z', c[0]) + P('M24 41L26 20L39 32Z', dark ? '#77728e' : PINK));
      s += E(50, 58, 35, 30, c[0]);
      if (x.v === 0) s += L('M50 30v8M42 31.5l1.6 7M58 31.5l-1.6 7', c[1], 3);
      s += flip(E(43, 67, 8.5, 6.5, lt(c[0], 0.45))) + P('M46 61.5h8l-4 4.5Z', NOSE);
      s += flip(L('M29 63L12 60M29 68L13 70', dark ? '#9b97ad' : dk(c[0], 0.35), 1.6));
      return s + F(ex, {
        x: 50,
        y: 51,
        sp: 13,
        my: 17.5,
        mw: 0.8,
        on: c[0],
        eye: dark ? '#d8f25c' : INK,
        ink: INK,
        z: [72, 28]
      });
    }
  };
  S.dog = {
    n: 'Puppy',
    p: [['#d9a066', '#8a5a34'], ['#f3ece2', '#a0704a'], ['#a3a9b8', '#5d6273']],
    d: function d(c, ex, x) {
      var s = E(50, 53, 31, 31, c[0]);
      if (x.v) s += C(63, 43, 10, c[1], op(0.7));
      s += flip(E(21, 50, 11, 22, c[1], rot(16, 21, 50)));
      s += E(50, 69, 17, 13, '#fbeedd') + E(50, 62, 6.5, 4.8, INK) + E(48.3, 60.6, 2, 1.2, '#fff', op(0.6));
      return s + F(ex, {
        x: 50,
        y: 47,
        sp: 12.5,
        my: 25,
        mw: 0.8,
        on: c[0]
      });
    }
  };
  S.fox = {
    n: 'Fox',
    p: [['#f08a3c', '#c4602a'], ['#e9eef7', '#aab6cc'], ['#d9573e', '#a83d2b']],
    d: function d(c, ex) {
      return flip(P('M15 42L21 6L47 28Z', c[0]) + P('M22 33L24.5 15L37 26Z', dk(c[0], 0.45))) + P('M13 38Q17 23 50 23Q83 23 87 38Q85 62 50 85Q15 62 13 38Z', c[0]) + P('M15 47Q24 66 50 62Q76 66 85 47Q82 66 50 85Q18 66 15 47Z', '#fffaf4') + E(50, 79, 4.6, 3.4, INK) + F(ex, {
        x: 50,
        y: 46,
        sp: 14,
        my: 20,
        mw: 0.75,
        on: c[0],
        ink: INK,
        bp: [18, 9]
      });
    }
  };
  S.panda = {
    n: 'Panda',
    p: [['#f8f8fa', '#2e2b3a']],
    d: function d(c, ex) {
      return flip(C(24, 30, 12, c[1])) + C(50, 57, 33, c[0]) + flip(E(36, 55, 9, 12.5, c[1], rot(32, 36, 55))) + E(50, 67, 5.5, 3.8, c[1]) + F(ex, {
        x: 50,
        y: 54,
        sp: 14,
        my: 18,
        mw: 0.8,
        eye: '#ffffff',
        ink: c[1],
        lens: '#ff6fa8',
        bp: [20, 10]
      });
    }
  };
  S.bear = {
    n: 'Bear',
    p: [['#a8693d', '#e7c096'], ['#e2a253', '#f8ddb0'], ['#f1f1f4', '#dcdce6']],
    d: function d(c, ex) {
      return flip(C(25, 31, 12, c[0]) + C(25, 31, 6.5, c[1])) + C(50, 57, 32, c[0]) + E(50, 68, 14.5, 11.5, c[1]) + E(50, 62.5, 5.8, 4, INK) + F(ex, {
        x: 50,
        y: 50,
        sp: 13,
        my: 22.5,
        mw: 0.75,
        on: c[0]
      });
    }
  };
  S.bunny = {
    n: 'Bunny',
    p: [['#f7f1f5', '#ffb3c7'], ['#cfae8f', '#f7c6c9'], ['#b9bdcc', '#ffc2d1']],
    d: function d(c, ex, x) {
      var ear = function ear(cx) {
        return E(cx, 27, 8.5, 22, c[0]) + E(cx, 29, 4.2, 16, c[1]);
      };
      return G(ear(37), rot(-8, 37, 48)) + G(ear(63), rot(x.v === 1 ? 62 : 8, 63, 48)) + E(50, 64, 31, 27, c[0]) + P('M46.5 64h7l-3.5 3.8Z', NOSE) + F(ex, {
        x: 50,
        y: 57,
        sp: 12.5,
        my: 13,
        mw: 0.75,
        on: c[0]
      });
    }
  };
  S.lion = {
    n: 'Lion',
    p: [['#f6c25b', '#d9772b'], ['#f3d58e', '#9c4f2d'], ['#f7c873', '#e0563a']],
    d: function d(c, ex) {
      var s = C(50, 54, 36, c[1]);
      for (var a = 0; a < 360; a += 30) s += C(50 + 34 * cos(a), 54 + 34 * sin(a), 12, c[1]);
      s += C(50, 56, 30, dk(c[1], 0.12)) + flip(C(31, 35, 7.5, c[0]) + C(31, 35, 4, dk(c[0], 0.25))) + C(50, 58, 26, c[0]);
      s += E(50, 68, 12.5, 9.5, lt(c[0], 0.55)) + P('M45 61h10l-5 5Z', dk(c[1], 0.3));
      return s + F(ex, {
        x: 50,
        y: 53,
        sp: 10.5,
        my: 18,
        mw: 0.75,
        on: c[0],
        z: [74, 26]
      });
    }
  };
  S.koala = {
    n: 'Koala',
    p: [['#a1aabb', '#ece3ee'], ['#8e8a9e', '#f0d8e4']],
    d: function d(c, ex) {
      return flip(C(20, 40, 17, c[0]) + C(21, 41, 10, c[1])) + E(50, 59, 30, 28, c[0]) + E(50, 64, 8, 11, '#3d3a4b') + E(47.5, 59, 2, 3, '#fff', op(0.35)) + F(ex, {
        x: 50,
        y: 51,
        sp: 16,
        my: 27,
        mw: 0.6,
        on: c[0],
        bp: [18, 9]
      });
    }
  };
  S.monkey = {
    n: 'Monkey',
    p: [['#8a5a3c', '#f2cba3'], ['#6f6878', '#ead2c6'], ['#b7743f', '#f6d7b0']],
    d: function d(c, ex) {
      return flip(C(18, 55, 11, c[0]) + C(18, 55, 6, c[1])) + C(50, 53, 31, c[0]) + P('M41 26Q43 12 55 13Q48 17 52 25Z', c[0]) + flip(C(40, 50, 13.5, c[1])) + E(50, 66, 21, 15, c[1]) + flip(C(46.5, 61, 1.4, dk(c[1], 0.5))) + F(ex, {
        x: 50,
        y: 49,
        sp: 10,
        my: 19,
        mw: 0.75,
        on: c[1],
        ink: INK
      });
    }
  };
  S.pig = {
    n: 'Piggy',
    p: [['#f9b4c4', '#ec8aa2'], ['#f6c7a6', '#e39c78'], ['#f3a9c9', '#df7aa6']],
    d: function d(c, ex) {
      return flip(P('M23 40L17 13L43 28Z', c[1])) + E(50, 57, 34, 30, c[0]) + E(50, 67, 13.5, 9.5, c[1]) + flip(E(45.5, 67, 2.2, 3.3, dk(c[1], 0.35))) + F(ex, {
        x: 50,
        y: 49,
        sp: 15,
        my: 30,
        mw: 0.75,
        on: c[0],
        blush: '#ff5f87'
      });
    }
  };
  S.cow = {
    n: 'Cow',
    p: [['#fbfbfb', '#2f2b38'], ['#fbfbfb', '#8a5a3c'], ['#f2e6d8', '#5b3d2e']],
    d: function d(c, ex) {
      return flip(P('M31 30Q20 22 24 10Q30 20 38 25Z', '#f2dfb8') + E(15, 45, 12, 6.5, c[0], rot(22, 15, 45)) + E(16, 45.5, 7, 3.4, PINK, rot(22, 15, 45))) + E(50, 53, 30, 32, c[0]) + C(64, 31, 7, c[1]) + C(72, 39, 4, c[1]) + C(34, 33, 5, c[1]) + E(50, 73, 22, 13, '#f7b9c4') + flip(E(42, 71, 2.6, 3.6, '#d77d90')) + F(ex, {
        x: 50,
        y: 48,
        sp: 12,
        my: 30,
        mw: 0.7,
        on: c[0],
        bp: [17, 8]
      });
    }
  };
  S.tiger = {
    n: 'Tiger',
    p: [['#f7923a', '#2b2238'], ['#f3f1f6', '#3a3550'], ['#f7a94a', '#5a2e1e']],
    d: function d(c, ex) {
      return flip(C(23, 33, 11, c[0]) + C(23, 33, 6, '#fff3e3')) + E(50, 57, 34, 30, c[0]) + L('M50 29v8M43 30.5l1.5 6M57 30.5l-1.5 6', c[1], 3) + flip(L('M17 52h9M18 61h7', c[1], 3)) + flip(C(43.5, 69, 9.5, '#fffaf2')) + P('M45 62h10l-5 5Z', NOSE) + F(ex, {
        x: 50,
        y: 50,
        sp: 14,
        my: 22,
        mw: 0.75,
        on: c[0],
        bp: [18, 8]
      });
    }
  };
  S.mouse = {
    n: 'Mouse',
    p: [['#b9bac9', '#ffb3c3'], ['#eadccb', '#ffb7c0'], ['#9e8f86', '#f7b0b8']],
    d: function d(c, ex) {
      return flip(C(23, 33, 17, c[0]) + C(23, 33, 11, c[1])) + E(50, 61, 28, 26, c[0]) + C(50, 68, 3.6, NOSE) + flip(L('M33 67L15 64M33 71L16 74', dk(c[0], 0.3), 1.5)) + F(ex, {
        x: 50,
        y: 56,
        sp: 11,
        my: 17,
        mw: 0.7,
        on: c[0]
      });
    }
  };
  S.raccoon = {
    n: 'Raccoon',
    p: [['#9c9cab', '#2f2b3a'], ['#b5a594', '#3b302c']],
    d: function d(c, ex) {
      return flip(P('M17 46L21 13L44 31Z', c[0]) + P('M23 36L25 21L36 30Z', c[1])) + E(50, 58, 35, 29, c[0]) + E(50, 68, 17, 13, '#fbfbfd') + flip(E(37, 41, 8, 3.6, '#fbfbfd', rot(-10, 37, 41))) + P('M15 53Q22 40 38 44Q50 48 62 44Q78 40 85 53Q78 63 62 59Q50 56 38 59Q22 63 15 53Z', c[1]) + E(50, 64, 4.8, 3.4, INK) + F(ex, {
        x: 50,
        y: 51,
        sp: 13,
        my: 21,
        mw: 0.75,
        eye: '#fff',
        ink: INK,
        lens: '#4fe0ff',
        bp: [20, 13]
      });
    }
  };

  /* birds & sea */
  S.owl = {
    n: 'Owl',
    no: ['tongue'],
    p: [['#8c6a50', '#e9d5b7'], ['#7d88ab', '#e2e6f3']],
    d: function d(c, ex) {
      return P('M16 100Q12 52 22 32L17 10L37 24Q50 19 63 24L83 10L78 32Q88 52 84 100Z', c[0]) + E(50, 82, 21, 22, c[1]) + L('M41 74l3 3 3-3M53 74l3 3 3-3M47 82l3 3 3-3M36 82l3 3 3-3M59 82l3 3 3-3', dk(c[1], 0.25), 1.6) + flip(C(35, 47, 14, '#fff8ea')) + P('M45.5 56h9L50 65Z', BEAK) + F(ex, {
        x: 50,
        y: 47,
        sp: 15,
        k: 1.2,
        noMouth: 1,
        on: '#fff8ea',
        blush: false,
        z: [73, 20]
      });
    }
  };
  S.penguin = {
    n: 'Penguin',
    no: ['tongue'],
    p: [['#2f3a56', '#ffffff'], ['#3a3d48', '#ffffff']],
    d: function d(c, ex, x) {
      return flip(E(13, 78, 7, 18, c[0], rot(18, 13, 78))) + E(50, 66, 37, 44, c[0]) + flip(C(40, 50, 15, c[1])) + E(50, 72, 25, 28, c[1]) + (x.v ? flip(E(25, 47, 3.5, 7, '#ffcf4a', rot(15, 25, 47))) : '') + P('M43 58Q50 53 57 58Q50 66 43 58Z', BEAK) + F(ex, {
        x: 50,
        y: 49,
        sp: 10,
        noMouth: 1,
        on: '#fff',
        z: [68, 18]
      });
    }
  };
  S.chick = {
    n: 'Chick',
    no: ['tongue'],
    p: [['#ffd23f', '#f0a81c'], ['#fff0a6', '#f5c84a']],
    d: function d(c, ex) {
      return C(50, 54, 30, c[0]) + L('M48 25Q45 16 51 13M52 25Q55 17 61 18', c[1], 3) + flip(E(22, 66, 7, 10, c[1], rot(30, 22, 66))) + P('M14 72L22 64L30 72L38 64L46 72L54 64L62 72L70 64L78 72L86 64V78Q86 98 50 98Q14 98 14 78Z', '#fffdf8') + C(30, 84, 3, '#efe7d8') + C(68, 88, 2.4, '#efe7d8') + C(58, 79, 1.8, '#efe7d8') + P('M44 57L50 52L56 57Z', BEAK) + P('M45 57.5h10L50 62Z', dk(BEAK, 0.15)) + F(ex, {
        x: 50,
        y: 46,
        sp: 12,
        noMouth: 1,
        on: c[0],
        bp: [17, 9]
      });
    }
  };
  S.frog = {
    n: 'Frog',
    p: [['#6cc04a', '#4c9a33'], ['#4fc7b4', '#2f9a89']],
    d: function d(c, ex) {
      return flip(C(30, 37, 15, c[0]) + C(30, 37, 10, '#fff')) + E(50, 63, 39, 27, c[0]) + E(50, 81, 24, 9, lt(c[0], 0.35)) + flip(C(46, 57, 1.4, dk(c[0], 0.4))) + F(ex, {
        x: 50,
        y: 37.5,
        sp: 20,
        k: 1.1,
        my: 28,
        mw: 1.5,
        bp: [26, 25],
        on: '#fff',
        ink: INK,
        z: [76, 14]
      });
    }
  };
  S.octopus = {
    n: 'Octopus',
    p: [['#b06ad8', '#8a49b8'], ['#ff7a6b', '#d9534a']],
    d: function d(c, ex) {
      var s = '';
      [[22, -1], [36, 1], [50, -1], [64, 1], [78, -1]].forEach(function (q) {
        var lx = q[0],
          g = q[1];
        s += L(D(_templateObject14 || (_templateObject14 = _taggedTemplateLiteralLoose(["M", " 60Q", " 74 ", " 84Q", " 92 ", " 99"])), lx, lx + 7 * g, lx, lx - 6 * g, lx + 2 * g), c[1], 9);
      });
      return s + P('M15 60Q13 13 50 13Q87 13 85 60Q85 72 50 72Q15 72 15 60Z', c[0]) + C(29, 30, 4, lt(c[0], 0.3)) + C(70, 26, 2.8, lt(c[0], 0.3)) + C(74, 36, 2, lt(c[0], 0.3)) + F(ex, {
        x: 50,
        y: 45,
        sp: 13,
        my: 12,
        on: c[0]
      });
    }
  };
  S.shark = {
    n: 'Shark',
    p: [['#7fa0c6', '#5a7aa3'], ['#8d9aae', '#66748c']],
    d: function d(c, ex) {
      return P('M38 32L56 5L66 32Z', c[1]) + flip(P('M16 72L3 90L24 84Z', c[1])) + P('M14 70Q14 29 50 28Q86 29 86 70Q86 97 50 97Q14 97 14 70Z', c[0]) + P('M16 70Q50 84 84 70Q83 96 50 96Q17 96 16 70Z', '#f4f7fb') + flip(L('M21 50l3 7M26 48l3 7', c[1], 2)) + F(ex, {
        x: 50,
        y: 55,
        sp: 13,
        my: 24,
        on: c[0],
        ink: INK,
        bp: [18, 8]
      });
    }
  };
  S.whale = {
    n: 'Whale',
    p: [['#4a8fd8', '#cfe6fb'], ['#6b7fb0', '#e1e7f5']],
    d: function d(c, ex) {
      return L('M38 28Q38 18 30 12M38 28Q38 18 46 12M38 28V9', '#e3f5ff', 3.2) + P('M70 62Q86 58 87 40Q84 28 92 26Q97 34 99 46Q92 47 90 50Q88 68 72 74Z', c[0]) + P('M6 62Q6 30 44 30Q80 30 82 62Q82 90 44 90Q6 90 6 62Z', c[0]) + P('M8 70Q44 82 80 70Q76 90 44 90Q12 90 8 70Z', c[1]) + L('M28 81v5M38 83v6M48 83v6M58 81v5', dk(c[1], 0.15), 1.6) + F(ex, {
        x: 38,
        y: 55,
        sp: 10,
        my: 12,
        on: c[0],
        z: [60, 34]
      });
    }
  };
  S.crab = {
    n: 'Crab',
    p: [['#ef5a4a', '#c43e31'], ['#ff8a3d', '#d4661f']],
    d: function d(c, ex) {
      return flip(L('M26 72L10 80M28 78L14 90', c[1], 4) + L('M28 62L17 47', c[0], 6) + P('M17 53Q3 47 6 33Q9 24 19 25L15 35L25 33Q27 47 17 53Z', c[0]) + L('M41 52V37', c[0], 4) + C(41, 31, 8.5, '#fff')) + E(50, 66, 32, 20, c[0]) + C(28, 60, 2.2, lt(c[0], 0.35)) + C(73, 58, 1.8, lt(c[0], 0.35)) + F(ex, {
        x: 50,
        y: 31.5,
        sp: 9,
        k: 0.9,
        my: 36,
        mw: 1.2,
        bp: [19, 34],
        on: '#fff',
        ink: INK,
        z: [64, 14]
      });
    }
  };

  /* fantasy */
  S.unicorn = {
    n: 'Unicorn',
    p: [['#fbf7ff', '#f9d3e6'], ['#e7dcff', '#ffd6ea']],
    d: function d(c, ex) {
      return C(29, 36, 12, '#ff8fc7') + C(23, 52, 11, '#b49bff') + C(26, 67, 10, '#7fd6ff') + C(31, 80, 8, '#ffd166') + flip(P('M31 36L28 15L43 29Z', c[0]) + P('M33 30L31.5 20L39 27Z', '#ffc2dc')) + E(50, 57, 28, 31, c[0]) + P('M44.5 29L50 2L55.5 29Z', '#ffd166') + L('M46 21.5l8-3M47.5 13.5l5-2', '#f0a92b', 1.6) + C(42, 30, 8, '#ff8fc7') + C(52, 28.5, 6.5, '#b49bff') + E(50, 75, 18, 11.5, c[1]) + flip(E(44, 74, 1.8, 2.6, dk(c[1], 0.3))) + F(ex, {
        x: 50,
        y: 51,
        sp: 12,
        my: 29,
        mw: 0.6,
        bp: [16, 8],
        on: c[0],
        z: [70, 40]
      });
    }
  };
  S.dragon = {
    n: 'Dragon',
    p: [['#5dbb7a', '#c9f2b6', '#ffb347'], ['#e86a5d', '#ffd8b8', '#ffd166'], ['#8e6bdc', '#e4d8ff', '#7ee0d0']],
    d: function d(c, ex) {
      return flip(P('M31 38Q17 22 24 5Q29 23 40 31Z', '#fff1d0') + P('M21 52L4 42L9 62Z', c[2])) + P('M40 31L44 16L50 28L56 16L60 31Z', c[2]) + E(50, 58, 32, 29, c[0]) + E(50, 75, 21, 12.5, c[1]) + flip(E(43, 72, 2.2, 1.6, dk(c[1], 0.45)) + C(25, 44, 2, dk(c[0], 0.2)) + C(22, 51, 1.6, dk(c[0], 0.2))) + F(ex, {
        x: 50,
        y: 51,
        sp: 13,
        my: 28,
        mw: 0.8,
        on: c[0]
      });
    }
  };
  S.fuzzy = {
    n: 'Monster',
    p: [['#59c3ff'], ['#ff8a5c'], ['#a5dd4d']],
    d: function d(c, ex) {
      return flip(P('M27 34Q17 16 27 7Q28 22 37 30Z', '#fff4d6')) + P(fuzz(50, 60, 32, 22, 8), c[0]) + F(ex, {
        x: 50,
        y: 54,
        sp: 12,
        k: 1.1,
        fang: 1,
        on: c[0]
      });
    }
  };
  S.cyclops = {
    n: 'Blob',
    p: [['#a78bfa'], ['#ff6fae'], ['#3ddc97']],
    d: function d(c, ex) {
      return L('M50 18V9', dk(c[0], 0.2), 3) + C(50, 8, 4.5, '#ffd166') + P('M14 62Q14 17 50 17Q86 17 86 62V88Q81 96 75 89Q69 82 63 90Q56 98 49 90Q43 83 37 91Q30 98 25 90Q19 84 14 88Z', c[0]) + E(28, 38, 4.5, 9, '#fff', op(0.3) + rot(25, 28, 38)) + C(50, 46, 14, '#fff') + F(ex, {
        x: 50,
        y: 46,
        one: 1,
        k: 1.55,
        my: 18,
        mw: 0.8,
        on: '#fff',
        ink: INK
      });
    }
  };
  S.ghost = {
    n: 'Ghost',
    p: [['#f7f5ff'], ['#e6fbf3']],
    d: function d(c, ex) {
      return flip(E(18, 60, 6, 10, c[0], rot(40, 18, 60))) + P('M19 92V46Q19 12 50 12Q81 12 81 46V92L70.7 84L60.3 92L50 84L39.7 92L29.3 84Z', c[0]) + F(ex, {
        x: 50,
        y: 44,
        sp: 11,
        my: 13,
        on: c[0]
      });
    }
  };
  S.alien = {
    n: 'Alien',
    p: [['#8ee06a', '#5fae44'], ['#c3a6ff', '#8f6fe0'], ['#79e3dc', '#3fb3aa']],
    d: function d(c, ex) {
      return flip(L('M39 22L30 12', c[1], 3) + C(30, 11, 4.5, '#ffe066')) + P('M50 16Q87 16 85 49Q83 77 50 90Q17 77 15 49Q13 16 50 16Z', c[0]) + F(ex, {
        x: 50,
        y: 49,
        sp: 15,
        er: 1.5,
        my: 20,
        mw: 0.8,
        on: c[0]
      });
    }
  };
  S.robot = {
    n: 'Robot',
    no: ['cool'],
    p: [['#c7d1e0', '#8f9db3'], ['#ffad66', '#d9813c'], ['#8fe3cb', '#56b39a']],
    d: function d(c, ex) {
      return L('M50 27V13', c[1], 3) + C(50, 11, 5, '#ff5d73') + flip(R(9, 46, 11, 18, 4, c[1])) + R(14, 88, 72, 30, 14, c[0]) + R(40, 80, 20, 10, 2, c[1]) + R(16, 26, 68, 58, 14, c[0]) + R(25, 36, 50, 37, 10, '#23304a') + flip(C(22, 32, 1.8, c[1]) + C(22, 78, 1.8, c[1])) + F(ex, {
        x: 50,
        y: 51,
        sp: 11,
        my: 11,
        eye: '#6ff7ff',
        ink: '#6ff7ff',
        flat: 1,
        blush: '#ff6fa8',
        on: '#23304a',
        z: [65, 41]
      });
    }
  };
  S.yeti = {
    n: 'Yeti',
    p: [['#f4f8ff', '#a9d2f7'], ['#fff3e6', '#f0c29b']],
    d: function d(c, ex) {
      return flip(P('M24 36Q14 22 20 10Q24 22 33 30Z', '#cfd8e6')) + P(fuzz(50, 58, 35, 24, 8), c[0]) + E(50, 62, 23, 21, c[1]) + F(ex, {
        x: 50,
        y: 57,
        sp: 10,
        my: 12,
        fang: 1,
        on: c[1],
        bp: [14, 8],
        z: [72, 30]
      });
    }
  };

  /* food */
  S.taco = {
    n: 'Taco',
    p: [['#f6c445', '#d99a2b'], ['#f2b35a', '#c98535']],
    d: function d(c, ex) {
      var s = '';
      var cols = ['#7ed957', '#ef4b4b', '#7ed957', '#ffd166', '#7ed957', '#8a4b2f'];
      for (var j = 0; j <= 12; j++) {
        var a = 180 + j * 15;
        s += C(50 + 40 * cos(a), 77 + 45 * sin(a), j % 2 ? 6 : 7.5, cols[j % 6]);
      }
      s += P('M11 78Q11 33 50 33Q89 33 89 78Z', c[0]);
      [[24, 68], [72, 63], [68, 74], [33, 53], [80, 72]].forEach(function (q) {
        s += C(q[0], q[1], 1.8, c[1]);
      });
      return s + F(ex, {
        x: 50,
        y: 57,
        sp: 13,
        my: 10,
        on: c[0]
      });
    }
  };
  S.donut = {
    n: 'Donut',
    p: [['#ff8fc0'], ['#9ff0d0'], ['#c8a6ff']],
    d: function d(c, ex, x) {
      var s = C(50, 53, 37, '#e8ab62') + P(fuzz(50, 51, 29, 11, 7), c[0]) + C(50, 51, 10.5, '#c98a45') + C(50, 52, 8.5, x.bg);
      var cl = ['#ffffff', '#ffd166', '#5ac8fa', '#ff5d73', '#7ed957'];
      [[38, 28, 30], [56, 25, -25], [70, 34, 60], [29, 37, -50], [77, 51, 20], [65, 75, -40], [35, 75, 30], [50, 34, 80], [21, 52, 70]].forEach(function (q, j) {
        s += R(q[0] - 3.2, q[1] - 1.2, 6.4, 2.4, 1.2, cl[j % 5], rot(q[2], q[0], q[1]));
      });
      return s + F(ex, {
        x: 50,
        y: 51,
        sp: 19,
        my: 19,
        mw: 0.9,
        bp: [16, 12],
        on: c[0],
        z: [74, 18]
      });
    }
  };
  S.pizza = {
    n: 'Pizza',
    p: [['#ffd25e', '#d9453b'], ['#ffd25e', '#3b3346']],
    d: function d(c, ex, x) {
      var s = P('M12 20Q50 10 88 20L52.5 91Q50 96 47.5 91Z', c[0]);
      if (x.v === 0) {
        [[29, 34, 5.5], [71, 34, 5.5], [50, 68, 6], [50, 81, 3.2]].forEach(function (q) {
          s += C(q[0], q[1], q[2], c[1]) + C(q[0] - q[2] * 0.3, q[1] - q[2] * 0.3, q[2] * 0.25, '#ff8a7a');
        });
      } else {
        [[29, 34], [71, 34], [50, 80]].forEach(function (q) {
          s += C(q[0], q[1], 4, c[1]) + C(q[0], q[1], 1.6, c[0]);
        });
        s += L('M42 68q8-7 16 0', '#3fae5a', 3) + L('M24 27q4 3 8 0', '#3fae5a', 2.4);
      }
      s += P('M8 20Q50 3 92 20Q94 29 86 29Q50 15 14 29Q6 29 8 20Z', '#e39a4f');
      return s + F(ex, {
        x: 50,
        y: 45,
        sp: 10,
        k: 0.9,
        my: 9,
        on: c[0],
        z: [66, 36]
      });
    }
  };
  S.sushi = {
    n: 'Sushi',
    p: [['#ff8a5b'], ['#e5484d']],
    d: function d(c, ex) {
      return R(13, 46, 74, 41, 17, '#fbfaf3') + E(24, 78, 2.6, 1.3, '#e8e4d4', rot(30, 24, 78)) + E(76, 76, 2.6, 1.3, '#e8e4d4', rot(-30, 76, 76)) + E(66, 82, 2.4, 1.2, '#e8e4d4') + P('M9 51Q11 26 50 28Q89 26 91 51Q89 61 50 56Q11 61 9 51Z', c[0]) + L('M30 32Q35 42 28 55M50 30Q55 42 48 56M70 32Q75 42 68 55', '#fff', 2.4, op(0.55)) + F(ex, {
        x: 50,
        y: 68,
        sp: 13,
        my: 9,
        on: '#fbfaf3',
        z: [70, 50]
      });
    }
  };
  S.avocado = {
    n: 'Avocado',
    p: [['#3f7a3a', '#cfe58a']],
    d: function d(c, ex, x) {
      return P('M50 7Q73 7 77 39Q92 63 82 82Q70 99 50 99Q30 99 18 82Q8 63 23 39Q27 7 50 7Z', c[0]) + P('M50 13Q68 13 71 41Q85 63 77 79Q67 93 50 93Q33 93 23 79Q15 63 29 41Q32 13 50 13Z', c[1]) + (x.v ? E(50, 72, 11, 12, dk(c[1], 0.1)) : C(50, 72, 13, '#8a5a3c') + E(45, 67, 4, 2.6, '#fff', op(0.3) + rot(-30, 45, 67))) + F(ex, {
        x: 50,
        y: 40,
        sp: 10,
        k: 0.9,
        my: 9,
        on: c[1],
        z: [66, 26]
      });
    }
  };
  S.cupcake = {
    n: 'Cupcake',
    p: [['#ffb3d1', '#7cc6fe'], ['#c9a6ff', '#7ee0b5'], ['#fff2e0', '#ff9f6b']],
    d: function d(c, ex) {
      var s = P('M17 56H83L73 96H27Z', c[1]) + L('M30 59l3 35M42 59l1 35M58 59l-1 35M70 59l-3 35', dk(c[1], 0.2), 1.6, op(0.6));
      s += E(50, 54, 34, 12, c[0]) + E(50, 42, 26, 11, c[0]) + E(50, 31, 16, 9, c[0]) + E(40, 39, 7, 2.6, '#fff', op(0.4));
      var cl = ['#ff5d73', '#ffd166', '#5ac8fa', '#7ed957'];
      [[30, 52, 20], [44, 46, -30], [62, 44, 40], [72, 54, -20], [54, 33, 70], [38, 34, -60], [56, 56, 10]].forEach(function (q, j) {
        s += R(q[0] - 2.6, q[1] - 1, 5.2, 2, 1, cl[j % 4], rot(q[2], q[0], q[1]));
      });
      s += L('M53 14Q54 8 60 5', '#6b3e2a', 1.6) + C(53, 19, 6.5, '#e63946') + E(51, 16.5, 2, 1.3, '#fff', op(0.6));
      return s + F(ex, {
        x: 50,
        y: 75,
        sp: 11,
        k: 0.9,
        my: 9,
        on: c[1],
        ink: INK,
        z: [72, 64]
      });
    }
  };
  S.icecream = {
    n: 'Ice Cream',
    p: [['#ff9ec4'], ['#a6e8cc'], ['#f8e7c4']],
    d: function d(c, ex, x) {
      var id = x.id + 'k';
      return "<clipPath id=\"" + id + "\"><path d=\"M27 56H73L50 99Z\"/></clipPath>" + P('M27 56H73L50 99Z', '#e7a75a') + G(L('M20 50L70 100M34 50L84 100M48 50L98 100M80 50L30 100M66 50L16 100M52 50L2 100', '#c98a43', 1.8), " clip-path=\"url(#" + id + ")\"") + C(50, 40, 26, c[0]) + P('M24 42Q23 62 30 60Q34 68 40 60Q46 70 52 60Q58 68 64 60Q71 64 76 42Z', c[0]) + E(38, 27, 6, 3.5, '#fff', op(0.4) + rot(-30, 38, 27)) + L('M50 14Q51 8 56 6', '#6b3e2a', 1.5) + C(50, 15, 5, '#e63946') + F(ex, {
        x: 50,
        y: 40,
        sp: 10,
        my: 10,
        on: c[0],
        z: [70, 22]
      });
    }
  };
  S.burger = {
    n: 'Burger',
    p: [['#f2a65a'], ['#e9b46c']],
    d: function d(c, ex) {
      var s = P('M15 75H85Q85 91 70 91H30Q15 91 15 75Z', c[0]) + R(11, 62, 78, 14, 7, '#7a4a32') + P('M14 58H86L80 66L74 62L67 70L60 62H40L33 70L26 62L20 66Z', '#ffc93c') + L('M12 58Q18 52 24 58T36 58T48 58T60 58T72 58T84 58T90 57', '#6ccf4f', 5) + P('M13 52Q13 15 50 15Q87 15 87 52Q87 57 82 57H18Q13 57 13 52Z', c[0]);
      [[30, 27, -30], [44, 21, 10], [60, 22, -10], [72, 30, 30], [22, 40, -50], [79, 42, 50]].forEach(function (q) {
        s += E(q[0], q[1], 2.6, 1.3, '#fff3d6', rot(q[2], q[0], q[1]));
      });
      return s + F(ex, {
        x: 50,
        y: 38,
        sp: 12,
        my: 8,
        on: c[0],
        z: [70, 24]
      });
    }
  };
  S.egg = {
    n: 'Egg',
    p: [['#ffffff', '#ffc531']],
    d: function d(c, ex) {
      return P('M20 50Q12 26 37 22Q52 9 70 21Q91 29 85 52Q91 76 68 81Q51 93 33 83Q11 76 20 50Z', c[0]) + C(51, 52, 21, c[1]) + E(43, 43, 5.5, 3.5, '#fff', op(0.55) + rot(-30, 43, 43)) + F(ex, {
        x: 51,
        y: 51,
        sp: 8.5,
        k: 0.85,
        my: 9,
        on: c[1],
        z: [66, 32]
      });
    }
  };
  S.strawberry = {
    n: 'Berry',
    p: [['#ff4d5e', '#5cc46e']],
    d: function d(c, ex) {
      var s = P('M50 29Q80 20 85 42Q87 66 50 95Q13 66 15 42Q20 20 50 29Z', c[0]);
      [[30, 39], [70, 39], [22, 52], [78, 52], [38, 76], [62, 76], [50, 86], [28, 64], [72, 64]].forEach(function (q) {
        s += E(q[0], q[1], 1.4, 2.2, '#ffe08a');
      });
      [-70, -35, 0, 35, 70].forEach(function (a) {
        s += E(50, 20, 5, 11, c[1], rot(a, 50, 29));
      });
      return s + L('M50 20V10', '#3f8f4f', 3) + F(ex, {
        x: 50,
        y: 52,
        sp: 12,
        my: 11,
        on: c[0],
        z: [72, 36]
      });
    }
  };

  /* space & nature */
  S.planet = {
    n: 'Planet',
    p: [['#ff9f6b', '#ffd2a6', '#7c5cff'], ['#6ec6ff', '#d4f0ff', '#ffd166']],
    d: function d(c, ex, x) {
      var id = x.id + 'p';
      return sparkle(14, 16, 4) + sparkle(86, 82, 3.5) + G("<ellipse cx=\"50\" cy=\"52\" rx=\"45\" ry=\"11\" fill=\"none\" stroke=\"" + c[2] + "\" stroke-width=\"5\"/>", rot(-16, 50, 52)) + ("<clipPath id=\"" + id + "\"><circle cx=\"50\" cy=\"52\" r=\"29\"/></clipPath>") + C(50, 52, 29, c[0]) + G(E(50, 28, 40, 6, c[1]) + E(50, 78, 40, 6, c[1]) + E(28, 64, 9, 3, c[1]), " clip-path=\"url(#" + id + ")\"") + F(ex, {
        x: 50,
        y: 45,
        sp: 11,
        my: 9,
        on: c[0],
        z: [72, 22]
      }) + G(L('M5 52A45 11 0 0 0 95 52', c[2], 5), rot(-16, 50, 52));
    }
  };
  S.moon = {
    n: 'Moon',
    p: [['#f6edc8', '#e2d49e'], ['#e4e9fb', '#c4cde8']],
    d: function d(c, ex) {
      return sparkle(14, 15, 5) + sparkle(87, 86, 4) + sparkle(88, 14, 2.5) + C(50, 51, 34, c[0]) + C(31, 33, 6, c[1]) + C(71, 68, 7, c[1]) + C(67, 29, 4, c[1]) + C(28, 69, 3.5, c[1]) + F(ex, {
        x: 50,
        y: 49,
        sp: 12,
        my: 11,
        on: c[0],
        z: [74, 32]
      });
    }
  };
  S.star = {
    n: 'Star',
    p: [['#ffd23f'], ['#ff9ad5']],
    d: function d(c, ex) {
      return "<path d=\"" + starPath(50, 55, 40, 19, 5) + "\" fill=\"" + c[0] + "\" stroke=\"" + c[0] + "\" stroke-width=\"9\" stroke-linejoin=\"round\"/>" + F(ex, {
        x: 50,
        y: 56,
        sp: 9,
        k: 0.95,
        my: 9,
        on: c[0],
        z: [74, 18]
      });
    }
  };
  S.rocket = {
    n: 'Rocket',
    p: [['#f4f6fb', '#ff5d5d'], ['#f4f6fb', '#4f8cff']],
    d: function d(c, ex) {
      return P('M39 78Q50 106 61 78Z', '#ff9f43') + P('M44 78Q50 96 56 78Z', '#ffe066') + flip(P('M31 52L14 76L33 74Z', c[1])) + P('M50 5Q74 24 72 60Q72 74 64 80H36Q28 74 28 60Q26 24 50 5Z', c[0]) + P('M50 5Q61 14 66 25H34Q39 14 50 5Z', c[1]) + C(50, 47, 15, c[1]) + C(50, 47, 12, '#c8eeff') + L('M50 70V78', dk(c[0], 0.15), 2) + F(ex, {
        x: 50,
        y: 46,
        sp: 6,
        k: 0.72,
        my: 7,
        on: '#c8eeff',
        blush: false,
        z: [80, 28]
      });
    }
  };
  S.sun = {
    n: 'Sunny',
    p: [['#ffd23f', '#ff9f1c'], ['#ffe066', '#ff7a45']],
    d: function d(c, ex) {
      var s = '';
      for (var a = 0; a < 360; a += 30) s += L(D(_templateObject15 || (_templateObject15 = _taggedTemplateLiteralLoose(["M", " ", "L", " ", ""])), 50 + 34 * cos(a), 50 + 34 * sin(a), 50 + 44 * cos(a), 50 + 44 * sin(a)), c[1], 7);
      return s + C(50, 50, 31, c[0]) + F(ex, {
        x: 50,
        y: 48,
        sp: 11,
        my: 11,
        on: c[0],
        z: [68, 32]
      });
    }
  };
  S.cloud = {
    n: 'Cloud',
    p: [['#ffffff', '#7cc6ff'], ['#ecebff', '#a3a0ff']],
    d: function d(c, ex) {
      var s = '';
      [[32, 86], [50, 91], [68, 86]].forEach(function (q) {
        var dx = q[0],
          dy = q[1];
        s += P(D(_templateObject16 || (_templateObject16 = _taggedTemplateLiteralLoose(["M", " ", "C", " ", " ", " ", " ", " ", "A4 4 0 0 1 ", " ", "C", " ", " ", " ", " ", " ", "Z"])), dx, dy - 6, dx + 1, dy - 4, dx + 4, dy - 1, dx + 4, dy + 1, dx - 4, dy + 1, dx - 4, dy - 1, dx - 1, dy - 4, dx, dy - 6), c[1]);
      });
      return s + C(31, 58, 17, c[0]) + C(52, 45, 22, c[0]) + C(71, 57, 16, c[0]) + R(14, 56, 73, 20, 10, c[0]) + F(ex, {
        x: 50,
        y: 56,
        sp: 11,
        my: 9,
        on: c[0],
        z: [74, 28]
      });
    }
  };
  S.cactus = {
    n: 'Cactus',
    p: [['#5fbf6a', '#3e9b51'], ['#7fcfb0', '#4fa98a']],
    d: function d(c, ex) {
      return L('M36 58H27Q21 58 21 52V40', c[0], 11) + L('M64 50H73Q79 50 79 44V31', c[0], 11) + R(33, 17, 34, 60, 17, c[0]) + L('M33 30l-3-1M33 50l-3 1M67 38l3-1M67 58l3 1M21 40l-3-1M79 31l3-1M27 58l0 3M73 50l0-3', '#fff', 1.4, op(0.8)) + C(45, 16, 4, '#ff6fa8') + C(55, 16, 4, '#ff6fa8') + C(50, 12, 4, '#ff6fa8') + C(50, 16, 2.4, '#ffd166') + R(22, 68, 56, 10, 4, '#c9643c') + P('M26 77H74L68 97H32Z', '#e07a4f') + F(ex, {
        x: 50,
        y: 41,
        sp: 8.5,
        k: 0.9,
        my: 9,
        on: c[0],
        z: [76, 18]
      });
    }
  };
  S.sprout = {
    n: 'Sprout',
    p: [['#e07a4f', '#c9643c'], ['#7c8cff', '#5f6ee0'], ['#ffd166', '#f2b632']],
    d: function d(c, ex) {
      return L('M50 46V30', '#4caf50', 3.5) + P('M50 34Q30 36 22 16Q44 12 50 34Z', '#6cc04a') + P('M50 30Q62 10 82 12Q78 32 50 30Z', '#58b046') + L('M49 33Q36 26 28 19M51 29Q63 20 76 15', '#3f8f3a', 1.4) + P('M20 52H80L72 95H28Z', c[0]) + R(15, 44, 70, 13, 6, c[1]) + F(ex, {
        x: 50,
        y: 69,
        sp: 12,
        my: 10,
        on: c[0],
        z: [74, 60]
      });
    }
  };
  S.mushroom = {
    n: 'Mushroom',
    p: [['#ff5d5d', '#fbf0dc'], ['#8f6bff', '#fbf0dc']],
    d: function d(c, ex) {
      return R(36, 50, 28, 44, 12, c[1]) + R(41, 66, 6, 22, 3, '#fff', op(0.6)) + P('M7 57Q7 13 50 13Q93 13 93 57Q93 63 85 63H15Q7 63 7 57Z', c[0]) + C(21, 44, 5, '#fff') + C(79, 44, 5, '#fff') + C(50, 22, 5.5, '#fff') + C(31, 26, 3.5, '#fff') + C(69, 26, 3.5, '#fff') + F(ex, {
        x: 50,
        y: 42,
        sp: 13,
        my: 9,
        on: c[0],
        z: [64, 30]
      });
    }
  };
  S.flower = {
    n: 'Flower',
    p: [['#ff8fc7', '#ffe08a'], ['#8ec9ff', '#fff1b8'], ['#ffffff', '#ffd23f']],
    d: function d(c, ex) {
      var s = L('M50 70V100', '#4caf50', 5) + E(63, 89, 9, 4.5, '#5cbf60', rot(-30, 63, 89));
      for (var a = 0; a < 360; a += 45) s += C(50 + 27 * cos(a), 46 + 27 * sin(a), 14, c[0]);
      return s + C(50, 46, 23, c[1]) + F(ex, {
        x: 50,
        y: 44,
        sp: 9,
        my: 9,
        on: c[1],
        z: [80, 12]
      });
    }
  };

  /* movie night */
  S.tv = {
    n: 'TV',
    p: [['#ff7a59', '#c8f3ff'], ['#5cc8a8', '#fff2c2'], ['#9b7bea', '#ffd6e8']],
    d: function d(c, ex) {
      return L('M50 22L35 7M50 22L65 7', INK, 2.6) + C(35, 7, 3, INK) + C(65, 7, 3, INK) + L('M28 84l-4 10M72 84l4 10', dk(c[0], 0.35), 5) + R(9, 21, 82, 65, 14, c[0]) + R(17, 29, 54, 49, 10, c[1]) + C(81, 40, 4, dk(c[0], 0.3)) + C(81, 53, 4, dk(c[0], 0.3)) + L('M77 65h8M77 70h8', dk(c[0], 0.3), 2) + E(27, 37, 6, 2.6, '#fff', op(0.6) + rot(-35, 27, 37)) + F(ex, {
        x: 44,
        y: 51,
        sp: 10,
        my: 11,
        on: c[1],
        z: [60, 34]
      });
    }
  };
  S.popcorn = {
    n: 'Popcorn',
    p: [['#e63946'], ['#3a86ff']],
    d: function d(c, ex) {
      var s = '';
      [[22, 40, 9], [32, 29, 11], [47, 22, 12], [62, 24, 11], [74, 32, 10], [80, 42, 8], [40, 36, 10], [56, 34, 10], [67, 40, 9]].forEach(function (q) {
        s += C(q[0], q[1], q[2], '#fff6d6') + C(q[0] + q[2] * 0.35, q[1] + q[2] * 0.3, q[2] * 0.4, '#ffe39a');
      });
      for (var j = 0; j < 6; j++) {
        var a = 16 + j * 68 / 6,
          b = 16 + (j + 1) * 68 / 6,
          e = 26 + j * 8,
          f = 26 + (j + 1) * 8;
        s += P(D(_templateObject17 || (_templateObject17 = _taggedTemplateLiteralLoose(["M", " 46H", "L", " 97H", "Z"])), a, b, f, e), j % 2 ? '#ffffff' : c[0]);
      }
      return s + R(12, 42, 76, 8, 4, dk(c[0], 0.15)) + F(ex, {
        x: 50,
        y: 66,
        sp: 12,
        my: 11,
        on: '#fff',
        z: [72, 56]
      });
    }
  };
  S.controller = {
    n: 'Gamepad',
    p: [['#4a4e69', '#ffffff'], ['#f2f2f7', '#4a4e69']],
    d: function d(c, ex) {
      return P('M22 33Q50 27 78 33Q91 37 94 62Q96 81 84 82Q76 83 70 73Q64 66 50 66Q36 66 30 73Q24 83 16 82Q4 81 6 62Q9 37 22 33Z', c[0]) + R(17, 45.5, 15, 5, 1.5, dk(c[0], 0.4)) + R(22, 40.5, 5, 15, 1.5, dk(c[0], 0.4)) + C(76, 42, 3.2, '#ff5d73') + C(82, 48, 3.2, '#ffd166') + C(70, 48, 3.2, '#3ddc97') + C(76, 54, 3.2, '#4fa3ff') + F(ex, {
        x: 50,
        y: 46,
        sp: 7.5,
        k: 0.8,
        my: 9,
        on: c[0],
        z: [60, 28]
      });
    }
  };
  S.reel = {
    n: 'Film Reel',
    p: [['#c9ced8', '#8b93a5'], ['#ffc65c', '#d99a2b']],
    d: function d(c, ex) {
      var s = P('M62 74Q80 92 100 85V97Q78 103 56 82Z', '#2b2238');
      [[74, 88], [84, 91], [94, 90]].forEach(function (q) {
        s += R(q[0] - 1.5, q[1] - 1.5, 3, 3, 0.6, '#fff', op(0.8));
      });
      s += C(50, 46, 37, c[1]) + C(50, 46, 32, c[0]);
      [-90, 30, 150].forEach(function (a) {
        s += C(50 + 22 * cos(a), 46 + 22 * sin(a), 7.5, dk(c[1], 0.3));
      });
      return s + F(ex, {
        x: 50,
        y: 44,
        sp: 9,
        k: 0.85,
        my: 9,
        on: c[0],
        blush: false,
        z: [72, 18]
      });
    }
  };
  S.clapper = {
    n: 'Clapper',
    p: [['#2f2b3a', '#ffffff'], ['#3b3f6e', '#ffd166']],
    d: function d(c, ex) {
      var bar = function bar(y) {
        var s = R(12, y, 76, 11, 3, c[1]);
        for (var j = 0; j < 5; j++) s += P(D(_templateObject18 || (_templateObject18 = _taggedTemplateLiteralLoose(["M", " ", "h8l-6 11h-8Z"])), 18 + j * 15, y), c[0]);
        return s;
      };
      return R(14, 42, 72, 50, 7, c[0]) + bar(40) + G(bar(23), rot(-14, 13, 34)) + C(14, 37, 3.2, '#9aa0b5') + F(ex, {
        x: 50,
        y: 66,
        sp: 12,
        my: 10,
        on: c[0],
        z: [72, 58]
      });
    }
  };
  S.soda = {
    n: 'Soda',
    p: [['#ffb703', '#ffffff'], ['#2ec4b6', '#ffffff']],
    d: function d(c, ex) {
      return G(R(55, 1, 6, 26, 3, '#ff5d73') + L('M56 6h4M56 12h4M56 18h4', '#fff', 1.6), rot(14, 58, 26)) + P('M23 31H77L70 96H30Z', c[0]) + P('M25.5 47H74.5L73.8 54H26.2Z', '#fff', op(0.85)) + R(19, 25, 62, 9, 4.5, '#f4f6fb') + P('M27 25Q50 11 73 25Z', '#e3e8f3') + F(ex, {
        x: 50,
        y: 68,
        sp: 11,
        my: 10,
        on: c[0],
        z: [70, 60]
      });
    }
  };

  /* ---------- abstract patterns (no face) ---------- */
  var PALS = [['Sunset', '#2b2d6e', '#ff6b6b', '#ffa94d', '#ffd43b'], ['Ocean', '#0b3d5c', '#1c7c9c', '#3fb8c9', '#a7e8e0'], ['Berry', '#3d1e4a', '#9b2c7a', '#e05297', '#ffb3d1'], ['Mint', '#dff7ec', '#7ee0b5', '#2bb38a', '#126b5a'], ['Citrus', '#fff1c9', '#ffcb47', '#ff8c42', '#e85d3f'], ['Candy', '#ffe3f1', '#ff8fc7', '#9d8bff', '#6fd6ff'], ['Forest', '#1b3a2f', '#2f6b4f', '#7fb069', '#e6c79c'], ['Retro', '#f4e9d8', '#e76f51', '#2a9d8f', '#264653']];
  var PATS = [['Rings', function (a, b, c, d) {
    return R0(a) + C(28, 72, 72, b) + C(28, 72, 56, c) + C(28, 72, 40, d) + C(28, 72, 24, b) + C(28, 72, 9, c);
  }], ['Stripes', function (a, b, c, d) {
    return R0(a) + G([0, 1, 2, 3, 4, 5, 6, 7].map(function (j) {
      return R(-40 + j * 22, -40, j % 2 ? 7 : 12, 180, 0, [b, c, d][j % 3]);
    }).join(''), rot(35, 50, 50));
  }], ['Rainbow', function (a, b, c, d) {
    return R0(a) + C(78, 24, 10, d) + [48, 37, 26, 15].map(function (r, j) {
      return C(50, 100, r, [b, c, d, a][j]);
    }).join('');
  }], ['Tiles', function (a, b, c, d) {
    return R(0, 0, 50, 50, 0, b) + P('M50 50H0A50 50 0 0 1 50 0Z', d) + R(50, 0, 50, 50, 0, a) + C(75, 25, 17, c) + R(0, 50, 50, 50, 0, c) + P('M0 100V50A50 50 0 0 1 50 100Z', a) + R(50, 50, 50, 50, 0, d) + P('M50 50H100A50 50 0 0 1 50 100Z', b);
  }], ['Waves', function (a, b, c, d) {
    return R0(a) + C(74, 20, 9, d) + [[34, b], [52, c], [70, d], [87, b]].map(function (q) {
      return P(D(_templateObject19 || (_templateObject19 = _taggedTemplateLiteralLoose(["M-5 ", "Q7.5 ", " 20 ", "T45 ", "T70 ", "T95 ", "T120 ", "V105H-5Z"])), q[0], q[0] - 9, q[0], q[0], q[0], q[0], q[0]), q[1]);
    }).join('');
  }], ['Burst', function (a, b, c, d) {
    var s = R0(a),
      w = '';
    for (var j = 0; j < 16; j += 2) {
      var a0 = j * 22.5,
        a1 = a0 + 22.5;
      w += D(_templateObject20 || (_templateObject20 = _taggedTemplateLiteralLoose(["M50 50L", " ", "L", " ", "Z"])), 50 + 80 * cos(a0), 50 + 80 * sin(a0), 50 + 80 * cos(a1), 50 + 80 * sin(a1));
    }
    return s + P(w, b) + C(50, 50, 24, c) + C(50, 50, 12, d);
  }], ['Bubbles', function (a, b, c, d) {
    return R0(a) + C(28, 30, 21, b) + C(70, 64, 27, c) + C(77, 21, 11, d) + C(27, 79, 13, d) + C(50, 47, 7, b) + C(16, 57, 5, c) + C(22, 24, 6, '#fff', op(0.35)) + C(62, 54, 7, '#fff', op(0.3));
  }], ['Peaks', function (a, b, c, d) {
    return R0(a) + C(70, 30, 12, d) + P('M-5 100L33 40L56 74L72 52L106 100Z', b) + P('M33 40L41 52L36 49L31 54L26 50Z', '#fff', op(0.85)) + P('M-5 100L20 66L46 100Z', c) + P('M50 100L76 70L104 100Z', c);
  }]];

  /* ---------- backgrounds ---------- */
  var BGS = [['#ff9a8b', '#ff6a88'], ['#7f8cff', '#5a63d8'], ['#4fd1b5', '#2a9d8f'], ['#ffd56b', '#f7a53b'], ['#8ec5fc', '#5f9cf2'], ['#c98bf7', '#9257d6'], ['#2f3d73', '#1b2448'], ['#9be15d', '#4fb06d'], ['#ff9f5a', '#f0663e'], ['#ffc3d8', '#ff8fb8'], ['#5ad1e6', '#3b8fd9'], ['#4a2f6b', '#2a1a45'], ['#ffe29f', '#ffa99f'], ['#6dd5a0', '#2e9e78'], ['#f76d6d', '#c33b4f'], ['#1f5a54', '#16302e']];
  var RAYS = function () {
    var d = '';
    for (var j = 0; j < 12; j++) {
      var a0 = j * 30,
        a1 = a0 + 15;
      d += D(_templateObject21 || (_templateObject21 = _taggedTemplateLiteralLoose(["M50 55L", " ", "L", " ", "Z"])), 50 + 90 * cos(a0), 55 + 90 * sin(a0), 50 + 90 * cos(a1), 55 + 90 * sin(a1));
    }
    return d;
  }();
  var OVER = ['', P(RAYS, '#fff', op(0.1)), "<g fill=\"none\" stroke=\"#fff\" stroke-width=\"6\" opacity=\"0.1\">" + C(50, 55, 26, 'none') + C(50, 55, 44, 'none') + C(50, 55, 62, 'none') + "</g>", G([[10, 12, 5], [88, 10, 3.5], [91, 80, 6], [8, 88, 3], [20, 50, 2.5], [84, 46, 2.5], [70, 94, 2.5], [30, 95, 4]].map(function (q) {
    return C(q[0], q[1], q[2], '#fff');
  }).join(''), op(0.22)), L('M-10 30L30 -10M-10 60L60 -10M-10 90L90 -10M20 110L110 20M50 110L110 50M80 110L110 80', '#fff', 7, op(0.09)), C(88, 10, 32, '#fff', op(0.13)) + C(6, 96, 22, '#fff', op(0.1))];
  var bgMid = BGS.map(function (b) {
    return mix(b[0], b[1], 0.5);
  });
  function pickBg(i, main, prev) {
    var hm = hsl(main),
      lm = lum(main);
    for (var t = 0; t < BGS.length; t++) {
      var j = (i * 7 + t * 3) % BGS.length;
      if (j === prev) continue;
      var hb = hsl(bgMid[j]);
      var dh = Math.abs(hm[0] - hb[0]);
      dh = Math.min(dh, 360 - dh);
      var dl = Math.abs(lm - lum(bgMid[j]));
      if (dl > 0.26 || dh > 55 && hm[1] > 0.3 && dl > 0.06) return j;
    }
    return i * 7 % BGS.length;
  }
  function background(i, j, ov) {
    var id = 'av' + i + 'g',
      b = BGS[j];
    return "<defs><linearGradient id=\"" + id + "\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"100\" y2=\"100\">" + ("<stop offset=\"0\" stop-color=\"" + b[0] + "\"/><stop offset=\"1\" stop-color=\"" + b[1] + "\"/></linearGradient></defs>") + ("<rect width=\"100\" height=\"100\" fill=\"url(#" + id + ")\"/>") + OVER[ov];
  }

  /* ---------- catalogue ---------- */
  var CATS = [['Animals', 3, ['cat', 'dog', 'fox', 'panda', 'bear', 'bunny', 'lion', 'koala', 'monkey', 'pig', 'cow', 'tiger', 'mouse', 'raccoon']], ['Birds & Sea', 2, ['owl', 'penguin', 'chick', 'frog', 'octopus', 'shark', 'whale', 'crab']], ['Fantasy', 2, ['unicorn', 'dragon', 'fuzzy', 'cyclops', 'ghost', 'alien', 'robot', 'yeti']], ['Food', 2, ['taco', 'donut', 'pizza', 'sushi', 'avocado', 'cupcake', 'icecream', 'burger', 'egg', 'strawberry']], ['Space & Nature', 2, ['planet', 'moon', 'star', 'rocket', 'sun', 'cloud', 'cactus', 'sprout', 'mushroom', 'flower']], ['Movie Night', 2, ['tv', 'popcorn', 'controller', 'reel', 'clapper', 'soda']]];
  var LIST = [],
    categories = [];
  var gs = 0,
    prevBg = -1;
  CATS.forEach(function (cat, ci) {
    var from = LIST.length,
      subs = cat[2].map(function (k) {
        return S[k];
      }),
      used = subs.map(function () {
        return {};
      });
    var _loop = function _loop(v) {
      subs.forEach(function (sub, si) {
        var t = ((gs + si) * 3 + v * 5) % 8;
        var bad = function bad(e) {
          return used[si][e] || sub.no && sub.no.indexOf(e) >= 0;
        };
        while (bad(EXPR[t])) t = (t + 1) % 8;
        var ex = EXPR[t];
        used[si][ex] = 1;
        var i = LIST.length,
          pal = sub.p[v % sub.p.length];
        var bg = pickBg(i, pal[0], prevBg);
        prevBg = bg;
        LIST.push({
          c: ci,
          sub: sub,
          v: v,
          ex: ex,
          pal: pal,
          bg: bg,
          ov: (i * 5 + 1) % OVER.length,
          name: ADJ[ex] + ' ' + sub.n
        });
      });
    };
    for (var v = 0; v < cat[1]; v++) {
      _loop(v);
    }
    gs += subs.length;
    categories.push({
      name: cat[0],
      from: from,
      to: LIST.length - 1,
      count: LIST.length - from
    });
  });
  (function () {
    var from = LIST.length;
    var _loop2 = function _loop2(v) {
      PATS.forEach(function (pt, p) {
        var pal = PALS[(p * 3 + v * 5) % PALS.length];
        LIST.push({
          c: CATS.length,
          pat: pt[1],
          pal: pal.slice(1),
          name: pal[0] + ' ' + pt[0]
        });
      });
    };
    for (var v = 0; v < 2; v++) {
      _loop2(v);
    }
    categories.push({
      name: 'Patterns',
      from: from,
      to: LIST.length - 1,
      count: LIST.length - from
    });
  })();
  var N = LIST.length,
    cache = {};
  var norm = function norm(i) {
    i = Math.floor(+i) || 0;
    return (i % N + N) % N;
  };
  function svg(i) {
    i = norm(i);
    if (cache[i]) return cache[i];
    var e = LIST[i];
    var body;
    if (e.pat) body = e.pat.apply(null, e.pal);else body = background(i, e.bg, e.ov) + e.sub.d(e.pal, e.ex, {
      i: i,
      id: 'av' + i,
      v: e.v,
      bg: 'url(#av' + i + 'g)'
    });
    // (Decoration: the name next to it, or the button's label, says who it is.)
    return cache[i] = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  root.AVATARS = {
    count: N,
    svg: svg,
    name: function name(i) {
      return LIST[norm(i)].name;
    },
    category: function category(i) {
      return categories[LIST[norm(i)].c].name;
    },
    categories: categories
  };
})(typeof window !== 'undefined' ? window : this);