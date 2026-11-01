'use strict';
// Run: node test/langs.test.js
const L = require('../lib/langs');

let pass = 0, fail = 0;
const failures = [];
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function check(label, got, want) {
  if (eq(got, want)) pass++;
  else { fail++; failures.push(`${label}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`); }
}
function ok(label, cond) { check(label, !!cond, true); }

// [item, expected langs, optional { clean, cleanGroup, source }]
const D = (item, langs, extra) => ({ item: typeof item === 'string' ? { name: item } : item, langs, extra: extra || {} });

const cases = [
  // ---- name prefixes, many provider styles
  D('|UK| BBC One HD', ['en'], { clean: 'BBC One HD', source: 'prefix' }),
  D('UK: BBC One', ['en'], { clean: 'BBC One' }),
  D('UK : BBC Two', ['en'], { clean: 'BBC Two' }),
  D('UK:BBC Three', ['en'], { clean: 'BBC Three' }),
  D('[UK] Sky Sports', ['en'], { clean: 'Sky Sports' }),
  D('(UK) ITV 1', ['en'], { clean: 'ITV 1' }),
  D('US - CNN', ['en'], { clean: 'CNN' }),
  D('USA ▎ CNN', ['en'], { clean: 'CNN' }),
  D('US| CNN HD', ['en'], { clean: 'CNN HD' }),
  D('FR: TF1', ['fr'], { clean: 'TF1' }),
  D('FR | France 2 FHD', ['fr'], { clean: 'France 2 FHD' }),
  D('DE - ARD', ['de'], { clean: 'ARD' }),
  D('DE: ZDF HD', ['de'], { clean: 'ZDF HD' }),
  D('ES| La 1', ['es'], { clean: 'La 1' }),
  D('IT ➾ Rai 1', ['it'], { clean: 'Rai 1' }),
  D('TR ✦ TRT 1', ['tr'], { clean: 'TRT 1' }),
  D('NL ▎ NPO 1', ['nl'], { clean: 'NPO 1' }),
  D('BR: Globo', ['pt'], { clean: 'Globo' }),
  D('PT: RTP 1', ['pt'], { clean: 'RTP 1' }),
  D('PL: TVP 1', ['pl'], { clean: 'TVP 1' }),
  D('RO: Pro TV', ['ro'], { clean: 'Pro TV' }),
  D('GR: ERT 1', ['el'], { clean: 'ERT 1' }),
  D('SE: SVT 1', ['sv'], { clean: 'SVT 1' }),
  D('DK: DR1', ['da'], { clean: 'DR1' }),
  D('NO: NRK1', ['no'], { clean: 'NRK1' }),
  D('FI: Yle TV1', ['fi'], { clean: 'Yle TV1' }),
  D('HU: M1', ['hu'], { clean: 'M1' }),
  D('CZ: CT1', ['cs'], { clean: 'CT1' }),
  D('SK: Markiza', ['sk'], { clean: 'Markiza' }),
  D('BG: bTV', ['bg'], { clean: 'bTV' }),
  D('AL: Top Channel', ['sq'], { clean: 'Top Channel' }),
  D('IL: Kan 11', ['he'], { clean: 'Kan 11' }),
  D('IR: IRIB 3', ['fa'], { clean: 'IRIB 3' }),
  D('AF: Tolo TV', ['fa', 'ps'], { clean: 'Tolo TV' }),
  D('RU: Первый канал', ['ru'], { clean: 'Первый канал' }),
  D('UA: 1+1', ['uk'], { clean: '1+1' }),
  D('JP: NHK', ['ja'], { clean: 'NHK' }),
  D('KR: KBS 1', ['ko'], { clean: 'KBS 1' }),
  D('CN: CCTV 1', ['zh'], { clean: 'CCTV 1' }),
  D('VN: VTV1', ['vi'], { clean: 'VTV1' }),
  D('TH: Channel 3', ['th'], { clean: 'Channel 3' }),
  D('PH: GMA', ['tl', 'en'], { clean: 'GMA' }),
  D('ID: RCTI', ['id'], { clean: 'RCTI' }),
  D('IE: RTE One', ['en'], { clean: 'RTE One' }),
  D('AU: Nine', ['en']),
  D('NZ: TVNZ 1', ['en']),
  D('MX: Las Estrellas', ['es'], { clean: 'Las Estrellas' }),
  D('CO: Caracol', ['es']),
  D('CL: TVN', ['es']),
  D('PK: Geo News', ['ur'], { clean: 'Geo News' }),
  D('BD: Channel i', ['bn']),
  D('EX-YU: RTS 1', ['sr', 'hr', 'bs'], { clean: 'RTS 1' }),
  D('EXYU | HRT 1', ['sr', 'hr', 'bs'], { clean: 'HRT 1' }),
  D('BALKAN | Pink', ['sr', 'hr', 'bs'], { clean: 'Pink' }),
  D('HR: HRT 1', ['hr']),
  D('RS: RTS 1', ['sr']),
  D('BA: BHT 1', ['bs']),
  D('SI: TV Slovenija 1', ['sl']),
  D('MK: MRT 1', ['mk']),
  D('LATINO | Telemundo', ['es'], { clean: 'Telemundo' }),
  D('LAT | Canal 5', ['es'], { clean: 'Canal 5' }),
  D('LATAM - Warner', ['es'], { clean: 'Warner' }),
  D('CA EN | CTV', ['en'], { clean: 'CTV' }),
  D('CA FR | TVA', ['fr'], { clean: 'TVA' }),
  D('CA: CBC', ['en']),
  D('QC | Noovo', ['fr']),
  D('BE: VTM', ['nl', 'fr']),
  D('BE NL: VTM', ['nl'], { clean: 'VTM' }),
  D('BE FR: La Une', ['fr'], { clean: 'La Une' }),
  D('CH: SRF 1', ['de', 'fr', 'it']),
  D('CH DE | SRF zwei', ['de'], { clean: 'SRF zwei' }),
  D('CH FR | RTS Un', ['fr'], { clean: 'RTS Un' }),
  D('PT/BR | Record', ['pt'], { clean: 'Record' }),
  D('KU | Rudaw', ['ku'], { clean: 'Rudaw' }),
  D('ENG | The Movie', ['en'], { clean: 'The Movie' }),
  D('GER: Tatort', ['de'], { clean: 'Tatort' }),
  D('SPA - Pelicula', ['es']),
  D('FRE | Film', ['fr']),
  D('POR: Filme', ['pt']),
  D('RUS | Kino', ['ru']),
  D('ITA | Film', ['it']),
  D('HIN | Film', ['hi']),
  D('TUR | Dizi', ['tr']),
  D('ARA | Film', ['ar']),
  D('NED | NPO 2', ['nl']),
  D('ARABIC | MBC 1', ['ar'], { clean: 'MBC 1' }),
  D('Arabic: Rotana', ['ar'], { clean: 'Rotana' }),
  D('ENGLISH | BBC', ['en'], { clean: 'BBC' }),
  D('Deutsch | Das Erste', ['de'], { clean: 'Das Erste' }),
  D('Français - TF1', ['fr'], { clean: 'TF1' }),
  D('Español | Antena 3', ['es']),
  D('Português: SIC', ['pt']),
  D('Italiano | Canale 5', ['it']),
  D('Русский | НТВ', ['ru'], { clean: 'НТВ' }),
  D('العربية | الجزيرة', ['ar'], { clean: 'الجزيرة' }),
  D('Türkçe | Show TV', ['tr']),
  D('Polski | Polsat', ['pl']),
  D('BRAZIL | Globo', ['pt'], { clean: 'Globo' }),
  D('UNITED KINGDOM | BBC Four', ['en'], { clean: 'BBC Four' }),
  D('★ UK ★ Sky One', ['en'], { clean: 'Sky One' }),
  D('UK » Dave', ['en'], { clean: 'Dave' }),
  D('#UK# Channel 4', ['en'], { clean: 'Channel 4' }),
  D('[ES] Movistar', ['es']),
  D('(en) Some Show', ['en'], { clean: 'Some Show' }),
  D('UK HD | BBC One', ['en'], { clean: 'BBC One' }),
  D('UK 4K | Sky Sports Main Event', ['en'], { clean: 'Sky Sports Main Event' }),

  // ---- noise segments before / around the language
  D('VIP | UK: BBC One', ['en'], { clean: 'VIP | BBC One' }),
  D('4K | UK | Sky Cinema', ['en'], { clean: '4K | Sky Cinema' }),
  D('24/7 | Friends', [], { clean: '24/7 | Friends' }),
  D('4K | Avatar', []),
  D('VIP | Some Channel', []),
  D('PPV | UFC 300', []),
  D('HEVC | Movie', []),
  D('SD | Channel 5', []),
  D('NBA: Lakers vs Celtics', []),

  // ---- trailing / bracketed tags in names
  D('Movies (EN)', ['en'], { clean: 'Movies', source: 'tag' }),
  D('Series [ITA]', ['it'], { clean: 'Series' }),
  D('Toy Story (2019) [FR]', ['fr'], { clean: 'Toy Story (2019)' }),
  D('Sky Sports [UK] HD', ['en'], { clean: 'Sky Sports HD' }),
  D('The Office (US)', ['en'], { clean: 'The Office' }),
  D('Avatar ENG', ['en'], { clean: 'Avatar' }),
  D('Netflix EN', ['en'], { clean: 'Netflix' }),
  D('Game of Thrones - DE', ['de'], { clean: 'Game of Thrones' }),
  D('Frozen - Latino', ['es'], { clean: 'Frozen' }),
  D('Dark | GER', ['de'], { clean: 'Dark' }),
  D('Amelie (VOSTFR)', ['fr'], { clean: 'Amelie' }),
  D('Movie [EN/FR]', ['en', 'fr'], { clean: 'Movie' }),
  D('EN/FR | Movie', ['en', 'fr'], { clean: 'Movie' }),
  D('Movie (ENG, GER)', ['en', 'de']),
  D('Inception (2010) (Dual Audio)', ['mul'], { clean: 'Inception (2010)' }),
  D('Movie [MULTI-SUB]', ['mul'], { clean: 'Movie' }),
  D('MULTI | Some Film', ['mul'], { clean: 'Some Film' }),
  D('Film 【FR】', ['fr'], { clean: 'Film' }),
  D('Al Jazeera English', ['en'], { clean: 'Al Jazeera' }),
  D('RT Español', ['es'], { clean: 'RT' }),
  D('Euronews Deutsch', ['de'], { clean: 'Euronews' }),
  D('France 24 Français', ['fr'], { clean: 'France 24' }),
  D('DW Arabic', ['ar']),
  D('Avengers Endgame Hindi', ['hi'], { clean: 'Avengers Endgame' }),
  D('Johnny English', ['en']),
  D('Pardon My French', []),
  D('The English', []),
  D('Lost in Spanish', []),

  // ---- false-positive traps: must stay unknown
  D('IT Crowd', []),
  D('The IT Crowd', []),
  D('IT Chapter Two', []),
  D("Stephen King's IT", []),
  D('The Office US', []),
  D('BE Live', []),
  D('BE Live | Event', []),
  D('NO Limit', []),
  D('NO Time to Die', []),
  D('DE Niro Tribute', []),
  D('10 AM News', []),
  D('Good Morning AM', []),
  D('Canal PLUS', []),
  D('ESPN', []),
  D('TV Land', []),
  D('HD Channel', []),
  D('UFC 300: Main Card', []),
  D('NFL RedZone', []),
  D('MLB Network', []),
  D('NHL Network', []),
  D('Rocky VI', []),
  D('Dr. NO', []),
  D('Fight Night KO', []),
  D('Brazil', []),
  D('Iceland', []),
  D('Australia', []),
  D('France 24', []),
  D('The English Patient', []),
  D('French Kiss', []),
  D('Mission: Impossible', []),
  D('Spider-Man: No Way Home', []),
  D('Star Wars: Episode IV - A New Hope', []),
  D('Mamma Mia! Here We Go Again', []),
  D('TRT World', []),
  D('PLUTO TV', []),
  D('Animal Planet', []),

  // ---- plain titles: unknown, not guessed
  D('The Matrix (1999)', []),
  D('Breaking Bad S01E01', []),
  D('CNN', []),
  D({ name: 'Inception', group: 'Movies' }, [], { cleanGroup: 'Movies' }),
  D({ name: 'Friends S01E01', group: 'Series', type: 'series' }, []),

  // ---- group / category handling and priority
  D({ name: 'BBC One', group: 'UK | Entertainment' }, ['en'], { source: 'group', cleanGroup: 'Entertainment', clean: 'BBC One' }),
  D({ name: 'News 24', group: 'EN | News' }, ['en'], { cleanGroup: 'News' }),
  D({ name: 'UK| BBC One', group: 'FR | Divers' }, ['en'], { source: 'prefix', cleanGroup: 'Divers' }),
  D({ name: 'Film', group: 'ENGLISH MOVIES' }, ['en'], { cleanGroup: 'MOVIES' }),
  D({ name: 'Film', group: 'Movies English' }, ['en'], { cleanGroup: 'Movies' }),
  D({ name: 'Film', group: 'Movies (EN)' }, ['en'], { cleanGroup: 'Movies' }),
  D({ name: 'Film', group: 'VOD - FRENCH' }, ['fr'], { cleanGroup: 'VOD' }),
  D({ name: 'Film', group: 'Series [ITA]' }, ['it'], { cleanGroup: 'Series' }),
  D({ name: 'Film', group: 'Netflix EN' }, ['en'], { cleanGroup: 'Netflix' }),
  D({ name: 'Film', group: 'ARABIC' }, ['ar'], { cleanGroup: 'ARABIC' }),
  D({ name: 'Film', group: 'Arabic Series' }, ['ar'], { cleanGroup: 'Series' }),
  D({ name: 'X', group: 'BE FR' }, ['fr']),
  D({ name: 'X', group: 'CH DE' }, ['de']),
  D({ name: 'X', group: 'PT/BR' }, ['pt']),
  D({ name: 'X', group: 'KU' }, ['ku']),
  D({ name: 'X', group: '|EN| MOVIES' }, ['en'], { cleanGroup: 'MOVIES' }),
  D({ name: 'X', group: '★ UK ★ Sports' }, ['en'], { cleanGroup: 'Sports' }),
  D({ name: 'X', group: 'UK Sports' }, ['en'], { cleanGroup: 'Sports' }),
  D({ name: 'X', group: 'FR Cinema' }, ['fr'], { cleanGroup: 'Cinema' }),
  D({ name: 'X', group: 'Sports USA' }, ['en']),
  D({ name: 'X', group: 'Bollywood' }, ['hi']),
  D({ name: 'X', group: 'Indian Movies' }, ['hi']),
  D({ name: 'X', group: 'Deutsch' }, ['de']),
  D({ name: 'X', group: 'Français' }, ['fr']),
  D({ name: 'X', group: 'Español | Cine' }, ['es'], { cleanGroup: 'Cine' }),
  D({ name: 'X', group: 'Türkçe' }, ['tr']),
  D({ name: 'X', group: 'العربية' }, ['ar']),
  D({ name: 'X', group: 'Русский' }, ['ru']),
  D({ name: 'X', group: 'MULTI-SUB' }, ['mul']),
  D({ name: 'X', group: 'VIP | UK | Sports' }, ['en'], { cleanGroup: 'VIP | Sports' }),
  D({ name: 'X', group: 'CA EN | News' }, ['en'], { cleanGroup: 'News' }),
  D({ name: 'X', group: 'US LATINO' }, ['es']),
  D({ name: 'X', group: '4K | Movies' }, [], { cleanGroup: '4K | Movies' }),
  D({ name: 'X', group: '24/7' }, []),
  D({ name: 'X', group: 'Let it BE' }, []),
  D({ name: 'X', group: 'Movies' }, []),
  ...['Premier League', 'Champions League', 'Christmas Movies', 'Marvel', 'Classic Movies', 'Action', 'Comedy', 'Horror',
    'Netflix', 'Disney+', 'HBO Max', 'Apple TV+', 'Amazon Prime', 'Paramount+', 'Sports | Football', 'Religious',
    'Music Videos', 'Radio', 'Formula 1', 'Boxing', 'Cricket', 'WWE', 'Pluto TV', 'Local News', 'Kids Zone',
    'Documentaries', '4K UHD', 'VIP Sports', 'PPV Events', 'NBA League Pass', 'NFL Sunday Ticket', 'HEVC Movies',
    'TV Shows', 'Top 100', 'New Releases', 'Series 2024', 'Live Events', 'IT Crowd Collection', 'NO Limit Wrestling',
  ].map(gr => D({ name: 'Some Item', group: gr }, [], { cleanGroup: gr })),
  D({ name: 'X', group: 'AFR | Nollywood Movies' }, ['en']),
  D({ name: 'Canal', group: 'AFR | Divers' }, [], { cleanGroup: 'Divers' }),
  D({ name: 'X', group: 'ASIA | Mix' }, [], { cleanGroup: 'Mix' }),
  D({ name: 'X', group: 'قنوات رياضية' }, ['ar'], { source: 'script' }),
  D({ name: 'CNN', group: 'Movies', category: 'EN - Movies' }, ['en'], { source: 'category', cleanGroup: 'Movies' }),
  D({ name: 'X', category: 'FR | Films' }, ['fr'], { source: 'category' }),
  D({ name: 'CA: TVA', group: 'CA FR | Quebec' }, ['fr'], { source: 'group' }),
  D({ name: 'US: Univision', group: 'LATINO' }, ['en'], { source: 'prefix' }),
  D({ name: 'MULTI | Movie', group: 'EN | Movies' }, ['en', 'mul'], { source: 'group' }),
  D({ name: 'Rotana', group: 'AR | Movies' }, ['ar']),

  // ---- AR: Arabic vs Argentina
  D('AR | MBC', ['ar'], { clean: 'MBC' }),
  D('AR: الجزيرة', ['ar']),
  D('AR | Telefe', ['es']),
  D('AR | TyC Sports', ['es']),
  D({ name: 'AR | TV Publica', group: 'LATINO' }, ['es']),
  D({ name: 'AR | Canal', tvgCountry: 'AR' }, ['es']),
  D({ name: 'AR | Canal', tvgId: 'canal.ar' }, ['es']),
  D({ name: 'TyC', group: 'AR | Deportes' }, ['es']),
  D({ name: 'Film', group: 'AR | Movies' }, ['ar']),
  D('ARG | Telefe', ['es']),
  D('[AR] Rotana Cinema', ['ar']),
  D('AR/EN | Movie', ['ar', 'en']),

  // ---- India regional refinement
  D('IN | Star Plus', ['hi'], { clean: 'Star Plus' }),
  D('IN: Sun TV', ['ta']),
  D('IN | Asianet', ['ml']),
  D('IN | Gemini TV', ['te']),
  D('IN | Udaya TV', ['kn']),
  D('IN | Star Jalsha', ['bn']),
  D('IN | Zee Marathi', ['mr']),
  D('IN | PTC Punjabi', ['pa']),
  D('IN | Times Now', ['en']),
  D({ name: 'Zee Tamil', group: 'IN | Entertainment' }, ['ta']),
  D({ name: 'Colors TV', group: 'INDIA' }, ['hi']),
  D('INDIA | Colors Kannada', ['kn']),

  // ---- tvg attributes
  D({ name: 'X', tvgLanguage: 'English' }, ['en'], { source: 'tvg-language' }),
  D({ name: 'X', tvgLanguage: 'Spanish;English' }, ['es', 'en']),
  D({ name: 'X', tvgLanguage: 'Arabic' }, ['ar']),
  D({ name: 'X', tvgLanguage: 'eng' }, ['en']),
  D({ name: 'X', tvgLanguage: 'pt-BR' }, ['pt']),
  D({ name: 'X', tvgLanguage: 'Français' }, ['fr']),
  D({ name: 'X', tvgLanguage: 'uk' }, ['uk']),
  D({ name: 'X', tvgLanguage: 'Brazilian Portuguese' }, ['pt']),
  D({ name: 'X', tvgCountry: 'US' }, ['en'], { source: 'country' }),
  D({ name: 'X', tvgCountry: 'UK' }, ['en']),
  D({ name: 'X', tvgCountry: 'GB' }, ['en']),
  D({ name: 'X', tvgCountry: 'FR' }, ['fr']),
  D({ name: 'X', tvgCountry: 'AR' }, ['es']),
  D({ name: 'X', tvgCountry: 'US;CA' }, ['en']),
  D({ name: 'X', tvgId: 'cnn.us' }, ['en'], { source: 'tvg-id' }),
  D({ name: 'X', tvgId: 'BBCOne.uk' }, ['en']),
  D({ name: 'X', tvgId: 'CNN.us@East' }, ['en']),
  D({ name: 'X', tvgId: 'tf1.fr' }, ['fr']),
  D({ name: 'X', tvgId: 'something.tv' }, []),
  D({ name: 'X', tvgId: 'cnn' }, []),
  D({ name: 'UK: BBC', tvgLanguage: 'French' }, ['en'], { source: 'prefix' }),
  D({ name: 'X', group: 'FR | News', tvgLanguage: 'English' }, ['fr'], { source: 'group' }),
  D({ name: 'X', tvgLanguage: 'English', tvgCountry: 'FR' }, ['en'], { source: 'tvg-language' }),
  D({ name: 'X', tvgCountry: 'FR', tvgId: 'x.de' }, ['fr'], { source: 'country' }),
  D({ name: 'Первый канал', tvgId: 'x.de' }, ['de'], { source: 'tvg-id' }),

  // ---- script detection
  D('Русский канал', ['ru'], { source: 'script' }),
  D('Перший канал україни', ['uk']),
  D('ДТВ Србија', ['sr']),
  D('БНТ България', ['bg']),
  D('МРТ Ѕвезда', ['mk']),
  D('Қазақстан', ['kk']),
  D('Беларусь 1 — тэлеканал Ўсход', ['be']),
  D('ΕΡΤ 1', ['el']),
  D('ערוץ 12', ['he']),
  D('MBC مصر', ['ar']),
  D('شبکه سه', ['fa']),
  D('جیو نیوز ٹی وی', ['ur']),
  D('کوردستان ٢٤', ['ku']),
  D('ڕووداو', ['ku']),
  D('ช่อง 7', ['th']),
  D('जी टीवी', ['hi']),
  D('স্টার জলসা', ['bn']),
  D('ਪੀਟੀਸੀ ਪੰਜਾਬੀ', ['pa']),
  D('சன் டிவி', ['ta']),
  D('ఈటీవీ', ['te']),
  D('ഏഷ്യാനെറ്റ്', ['ml']),
  D('ಉದಯ ಟಿವಿ', ['kn']),
  D('કલર્સ ગુજરાતી', ['gu']),
  D('KBS 한국', ['ko']),
  D('NHK ワールド', ['ja']),
  D('東京テレビ', ['ja']),
  D('中央电视台', ['zh']),
  D('იმედი', ['ka']),
  D('Հ1 Հանրային', ['hy']),
  D('ETV አማርኛ', ['am']),
  D('Halk TV Haber Kanalı', ['tr']),
  D('Kanał Sportowy łódź', ['pl']),
  D('Kênh Thời sự', ['vi']),
  D('Pokémon Café', []),

  // ---- robustness
  D('', []),
  D('   ', []),
  D({ name: null, group: undefined }, []),
  D({}, []),
];

for (const c of cases) {
  const r = L.detect(c.item);
  const label = `detect(${JSON.stringify(c.item)})`;
  check(label + ' langs', r.langs, c.langs);
  if ('clean' in c.extra) check(label + ' clean', r.clean, c.extra.clean);
  if ('cleanGroup' in c.extra) check(label + ' cleanGroup', r.cleanGroup, c.extra.cleanGroup);
  if ('source' in c.extra) check(label + ' source', r.source, c.extra.source);
  if (!r.langs.length) check(label + ' source null when unknown', r.source, null);
}
// string input == { name }
check('detect(string)', L.detect('UK: BBC One').langs, ['en']);
// results are stable (cache returns same answer)
check('group cache stable', L.detect({ name: 'X', group: 'UK | Entertainment' }).cleanGroup, 'Entertainment');
// returned arrays are frozen
ok('langs frozen', Object.isFrozen(L.detect('UK: BBC').langs));

// ---- names / native / list / code
const required = 'ar hi ur bn pa ta te ml fa tr ku ru uk pl ro hu cs sk bg sr hr bs sl mk sq el he nl de fr es pt it sv no da fi is et lv lt zh ja ko vi th id ms tl ka hy az kk uz sw am so af en'.split(' ');
for (const c of required) {
  ok(`names.${c}`, typeof L.names[c] === 'string' && L.names[c].length > 1);
  ok(`native.${c}`, typeof L.native[c] === 'string' && L.native[c].length > 0);
}
ok('>= 60 languages', Object.keys(L.names).length >= 60);
check('names.en', L.names.en, 'English');
check('native.es', L.native.es, 'Español');
check('native.fr', L.native.fr, 'Français');
check('native.de', L.native.de, 'Deutsch');
const lst = L.list();
ok('list length', lst.length === Object.keys(L.names).length);
ok('list sorted', lst.every((x, i) => i === 0 || lst[i - 1].name.localeCompare(x.name, 'en') <= 0));
check('list item shape', lst.find(x => x.code === 'fr'), { code: 'fr', name: 'French', native: 'Français' });
check('code(English)', L.code('English'), 'en');
check('code(eng)', L.code('eng'), 'en');
check('code(EN)', L.code('EN'), 'en');
check('code(Français)', L.code('Français'), 'fr');
check('code(pt-BR)', L.code('pt-BR'), 'pt');
check('code(Deutsch)', L.code('Deutsch'), 'de');
check('code(nonsense)', L.code('Klingonish'), null);

// every code the module can produce has a display name: sweep 2- and 3-letter prefixes
const seen = new Set();
const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
for (const a of AZ) for (const b of AZ) {
  for (const l of L.detect(`${a}${b} | x`).langs) seen.add(l);
  const fc = L.fromCountry(a + b);
  if (fc) for (const l of [].concat(fc)) seen.add(l);
  for (const c of AZ) for (const l of L.detect(`${a}${b}${c} | x`).langs) seen.add(l);
}
const missing = [...seen].filter(c => !L.names[c] || !L.native[c]);
check('all producible codes have names', missing, []);

// ---- fromCountry
check('fromCountry US', L.fromCountry('US'), 'en');
check('fromCountry UK', L.fromCountry('UK'), 'en');
check('fromCountry gb', L.fromCountry('gb'), 'en');
check('fromCountry BR', L.fromCountry('BR'), 'pt');
check('fromCountry MX', L.fromCountry('MX'), 'es');
check('fromCountry AR', L.fromCountry('AR'), 'es');
check('fromCountry CH', L.fromCountry('CH'), ['de', 'fr', 'it']);
check('fromCountry BE', L.fromCountry('BE'), ['nl', 'fr']);
check('fromCountry CA', L.fromCountry('CA'), 'en');
check('fromCountry IN', L.fromCountry('IN'), 'hi');
check('fromCountry PK', L.fromCountry('PK'), 'ur');
check('fromCountry UA', L.fromCountry('UA'), 'uk');
check('fromCountry USA', L.fromCountry('USA'), 'en');
check('fromCountry XX', L.fromCountry('XX'), null);
check('fromCountry null', L.fromCountry(null), null);

// ---- matches
const EN = ['en'];
check('matches en/en', L.matches(['en'], EN), true);
check('matches fr/en', L.matches(['fr'], EN), false);
check('matches multi-item en,fr / fr', L.matches(['en', 'fr'], ['fr']), true);
check('matches unknown default shown', L.matches([], EN), true);
check('matches unknown true', L.matches([], EN, { unknown: true }), true);
check('matches unknown false', L.matches([], EN, { unknown: false }), false);
check('matches null allowed = no filter', L.matches(['fr'], null), true);
check('matches empty allowed = no filter', L.matches(['fr'], []), true);
check('matches * = all', L.matches(['fr'], ['*']), true);
check('matches Set', L.matches(['de'], new Set(['de', 'fr'])), true);
check('matches string list', L.matches(['de'], 'en, de'), true);
check('matches names in allowed', L.matches(['de'], ['English', 'German']), true);
check('matches uppercase allowed', L.matches(['en'], ['EN']), true);
check('matches mul-only follows unknown (true)', L.matches(['mul'], EN, { unknown: true }), true);
check('matches mul-only follows unknown (false)', L.matches(['mul'], EN, { unknown: false }), false);
check('matches mul-only multi override', L.matches(['mul'], EN, { unknown: false, multi: true }), true);
check('matches mul allowed explicitly', L.matches(['mul'], ['mul'], { unknown: false }), true);
check('matches en+mul vs fr', L.matches(['en', 'mul'], ['fr'], { unknown: true }), false);
check('matches en+mul vs en', L.matches(['en', 'mul'], EN, { unknown: false }), true);
check('matches combo', L.matches(['es'], ['en', 'es', 'pt']), true);
check('matches undefined langs', L.matches(undefined, EN, { unknown: false }), false);
// end-to-end: "only English" hides everything else
const only = (item, opts) => L.matches(L.detect(item).langs, ['en'], opts);
check('e2e UK shown', only({ name: 'UK: BBC' }, { unknown: false }), true);
check('e2e FR hidden', only({ name: 'FR: TF1' }), false);
check('e2e CA FR hidden', only({ name: 'CA FR | TVA' }), false);
check('e2e plain title shown when unknown=true', only({ name: 'The Matrix (1999)' }, { unknown: true }), true);
check('e2e plain title hidden when unknown=false', only({ name: 'The Matrix (1999)' }, { unknown: false }), false);

// ---- performance
function perf() {
  const groups = [];
  const pre = ['UK | ', 'US | ', 'FR: ', 'DE - ', 'ES| ', '|AR| ', 'IN | ', 'EX-YU: ', '', 'VIP | ', 'LATINO | ', 'CA FR | ', '[IT] '];
  const cats = ['News', 'Sports', 'Movies', 'Kids', 'Entertainment', 'Music', 'Documentary', 'Series', 'Religious'];
  for (let i = 0; i < 600; i++) groups.push(pre[i % pre.length] + cats[i % cats.length] + (i > 100 ? ' ' + i : ''));
  const names = ['BBC One HD', 'CNN International', 'The Matrix (1999)', 'Breaking Bad S01E01', 'Sky Sports Main Event FHD',
    'Русский канал', 'MBC مصر', 'Rai 1', 'NHK ワールド', 'Avatar ENG', 'Movie [MULTI-SUB]', 'Game of Thrones - DE'];
  const npre = ['UK: ', '|US| ', '', '', '', 'FR | ', '', '[DE] ', 'AR | ', ''];
  const items = new Array(200000);
  for (let i = 0; i < items.length; i++) {
    items[i] = {
      name: npre[i % npre.length] + names[(i * 7) % names.length] + (i % 3 ? ' ' + (i % 997) : ''),
      group: groups[(i * 13) % groups.length],
      tvgId: i % 4 === 0 ? 'chan' + (i % 50) + '.us' : '',
      tvgLanguage: i % 9 === 0 ? 'English' : '',
      type: i % 2 ? 'live' : 'movie',
    };
  }
  L.clearCache();
  let t0 = process.hrtime.bigint();
  let n = 0;
  for (let i = 0; i < items.length; i++) n += L.detect(items[i]).langs.length;
  const cold = Number(process.hrtime.bigint() - t0) / 1e3 / items.length;
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    t0 = process.hrtime.bigint();
    for (let i = 0; i < items.length; i++) n += L.detect(items[i]).langs.length;
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e3 / items.length);
  }
  const allowed = ['en', 'fr'];
  t0 = process.hrtime.bigint();
  let vis = 0;
  for (let i = 0; i < items.length; i++) if (L.matches(L.detect(items[i]).langs, allowed, { unknown: true })) vis++;
  const both = Number(process.hrtime.bigint() - t0) / 1e3 / items.length;
  console.log(`perf: 200k items  first pass ${cold.toFixed(3)} µs/item (incl. group parsing), ` +
    `warm ${best.toFixed(3)} µs/item, detect+matches ${both.toFixed(3)} µs/item (visible ${vis}, checksum ${n})`);
  ok(`perf warm < 2 µs/item (got ${best.toFixed(3)})`, best < 2);
}
perf();

console.log(`\n${pass} passed, ${fail} failed (${cases.length} detect cases)`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
