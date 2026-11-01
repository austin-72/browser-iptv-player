'use strict';
/**
 * langs.js - work out the language of IPTV playlist items.
 *
 *   const L = require('./langs');
 *   L.detect({ name, group, tvgLanguage, tvgCountry, tvgId, category, type })
 *     -> { langs: ['en'], source: 'prefix', clean: 'BBC One HD', cleanGroup: 'News' }
 *   L.matches(langs, ['en','fr'], { unknown: true, multi?: bool }) -> boolean
 *   L.fromCountry('CH') -> ['de','fr','it'];  L.fromCountry('US') -> 'en'
 *   L.names / L.native / L.list() / L.code('English') -> 'en'
 *
 * Returned `langs` arrays are frozen and shared between results: copy before mutating.
 * Code 'mul' means "multiple / unspecified languages" (MULTI, MULTI-SUB, DUAL AUDIO ...).
 *
 * Plain CommonJS, no dependencies.
 */

// ---------------------------------------------------------------------------
// Language names
// ---------------------------------------------------------------------------
const LANGS = [
  ['af', 'Afrikaans', 'Afrikaans'], ['am', 'Amharic', 'አማርኛ'], ['ar', 'Arabic', 'العربية'],
  ['as', 'Assamese', 'অসমীয়া'], ['az', 'Azerbaijani', 'Azərbaycanca'], ['be', 'Belarusian', 'Беларуская'],
  ['bg', 'Bulgarian', 'Български'], ['bn', 'Bengali', 'বাংলা'], ['bo', 'Tibetan', 'བོད་ཡིག'],
  ['bs', 'Bosnian', 'Bosanski'], ['ca', 'Catalan', 'Català'], ['cs', 'Czech', 'Čeština'],
  ['cy', 'Welsh', 'Cymraeg'], ['da', 'Danish', 'Dansk'], ['de', 'German', 'Deutsch'],
  ['dv', 'Dhivehi', 'ދިވެހި'], ['el', 'Greek', 'Ελληνικά'], ['en', 'English', 'English'],
  ['es', 'Spanish', 'Español'], ['et', 'Estonian', 'Eesti'], ['eu', 'Basque', 'Euskara'],
  ['fa', 'Persian', 'فارسی'], ['fi', 'Finnish', 'Suomi'], ['fo', 'Faroese', 'Føroyskt'],
  ['fr', 'French', 'Français'], ['ga', 'Irish', 'Gaeilge'], ['gl', 'Galician', 'Galego'],
  ['gu', 'Gujarati', 'ગુજરાતી'], ['ha', 'Hausa', 'Hausa'], ['he', 'Hebrew', 'עברית'],
  ['hi', 'Hindi', 'हिन्दी'], ['hr', 'Croatian', 'Hrvatski'], ['ht', 'Haitian Creole', 'Kreyòl ayisyen'],
  ['hu', 'Hungarian', 'Magyar'], ['hy', 'Armenian', 'Հայերեն'], ['id', 'Indonesian', 'Bahasa Indonesia'],
  ['ig', 'Igbo', 'Igbo'], ['is', 'Icelandic', 'Íslenska'], ['it', 'Italian', 'Italiano'],
  ['ja', 'Japanese', '日本語'], ['ka', 'Georgian', 'ქართული'], ['kk', 'Kazakh', 'Қазақ тілі'],
  ['km', 'Khmer', 'ខ្មែរ'], ['kn', 'Kannada', 'ಕನ್ನಡ'], ['ko', 'Korean', '한국어'],
  ['ku', 'Kurdish', 'Kurdî'], ['ky', 'Kyrgyz', 'Кыргызча'], ['lb', 'Luxembourgish', 'Lëtzebuergesch'],
  ['lo', 'Lao', 'ລາວ'], ['lt', 'Lithuanian', 'Lietuvių'], ['lv', 'Latvian', 'Latviešu'],
  ['mg', 'Malagasy', 'Malagasy'], ['mk', 'Macedonian', 'Македонски'], ['ml', 'Malayalam', 'മലയാളം'],
  ['mn', 'Mongolian', 'Монгол'], ['mr', 'Marathi', 'मराठी'], ['ms', 'Malay', 'Bahasa Melayu'],
  ['mt', 'Maltese', 'Malti'], ['my', 'Burmese', 'မြန်မာ'], ['ne', 'Nepali', 'नेपाली'],
  ['nl', 'Dutch', 'Nederlands'], ['no', 'Norwegian', 'Norsk'], ['or', 'Odia', 'ଓଡ଼ିଆ'],
  ['pa', 'Punjabi', 'ਪੰਜਾਬੀ'], ['pl', 'Polish', 'Polski'], ['ps', 'Pashto', 'پښتو'],
  ['pt', 'Portuguese', 'Português'], ['ro', 'Romanian', 'Română'], ['ru', 'Russian', 'Русский'],
  ['rw', 'Kinyarwanda', 'Ikinyarwanda'], ['sd', 'Sindhi', 'سنڌي'], ['si', 'Sinhala', 'සිංහල'],
  ['sk', 'Slovak', 'Slovenčina'], ['sl', 'Slovenian', 'Slovenščina'], ['so', 'Somali', 'Soomaali'],
  ['sq', 'Albanian', 'Shqip'], ['sr', 'Serbian', 'Српски'], ['sv', 'Swedish', 'Svenska'],
  ['sw', 'Swahili', 'Kiswahili'], ['ta', 'Tamil', 'தமிழ்'], ['te', 'Telugu', 'తెలుగు'],
  ['tg', 'Tajik', 'Тоҷикӣ'], ['th', 'Thai', 'ไทย'], ['ti', 'Tigrinya', 'ትግርኛ'],
  ['tl', 'Filipino', 'Filipino'], ['tr', 'Turkish', 'Türkçe'], ['uk', 'Ukrainian', 'Українська'],
  ['ur', 'Urdu', 'اردو'], ['uz', 'Uzbek', 'Oʻzbekcha'], ['vi', 'Vietnamese', 'Tiếng Việt'],
  ['xh', 'Xhosa', 'isiXhosa'], ['yo', 'Yoruba', 'Yorùbá'], ['zh', 'Chinese', '中文'],
  ['zu', 'Zulu', 'isiZulu'], ['mul', 'Multiple languages', 'Multilingual'],
];

const names = Object.create(null);
const native = Object.create(null);
for (const [c, n, nat] of LANGS) { names[c] = n; native[c] = nat; }
Object.freeze(names); Object.freeze(native);

const LANG1 = Object.create(null); // code -> frozen [code]
for (const [c] of LANGS) LANG1[c] = Object.freeze([c]);
const EMPTY = Object.freeze([]);
const MUL = LANG1.mul;
const INTERN = new Map();
function intern(arr) {
  // dedupe + freeze + share
  if (arr.length === 1) return LANG1[arr[0]] || Object.freeze([arr[0]]);
  if (arr.length === 0) return EMPTY;
  const out = [];
  for (let i = 0; i < arr.length; i++) if (out.indexOf(arr[i]) < 0) out.push(arr[i]);
  if (out.length === 1) return LANG1[out[0]];
  const key = out.join(',');
  let v = INTERN.get(key);
  if (!v) { v = Object.freeze(out); INTERN.set(key, v); }
  return v;
}
function langsOf(spec) { return intern(spec.split(',')); }

// ---------------------------------------------------------------------------
// Countries: ISO 3166 alpha-2 -> languages (primary first) + names used as tags
// ---------------------------------------------------------------------------
// [cc, langs, names (| separated; first-class names, may be multiword)]
const COUNTRIES = [
  ['US', 'en', 'USA|UNITED STATES|AMERICA|AMERICAN|ESTADOS UNIDOS|ETATS UNIS'],
  ['GB', 'en', 'UNITED KINGDOM|GREAT BRITAIN|BRITAIN|BRITISH|ENGLAND|SCOTLAND|SCOTTISH|WALES|NORTHERN IRELAND'],
  ['IE', 'en', 'IRELAND|IRISH|EIRE'],
  ['CA', 'en', 'CANADA|CANADIAN'],
  ['QC', 'fr', 'QUEBEC|QUÉBEC|QUEBECOIS|QUÉBÉCOIS'],
  ['AU', 'en', 'AUSTRALIA|AUSTRALIAN'],
  ['NZ', 'en', 'NEW ZEALAND'],
  ['ZA', 'en,af,zu', 'SOUTH AFRICA'],
  ['NG', 'en', 'NIGERIA|NIGERIAN|NOLLYWOOD'],
  ['GH', 'en', 'GHANA'], ['KE', 'en,sw', 'KENYA'], ['UG', 'en', 'UGANDA'], ['TZ', 'sw', 'TANZANIA'],
  ['ZW', 'en', 'ZIMBABWE'], ['ZM', 'en', 'ZAMBIA'], ['JM', 'en', 'JAMAICA'], ['TT', 'en', 'TRINIDAD'],
  ['ET', 'am', 'ETHIOPIA|ETHIOPIAN'], ['ER', 'ti', 'ERITREA'], ['SO', 'so', 'SOMALIA'],
  ['RW', 'rw', 'RWANDA'], ['MG', 'mg,fr', 'MADAGASCAR'],
  ['SN', 'fr', 'SENEGAL|SÉNÉGAL'], ['CI', 'fr', 'IVORY COAST|COTE D\'IVOIRE|CÔTE D\'IVOIRE'],
  ['CM', 'fr,en', 'CAMEROON|CAMEROUN'], ['CD', 'fr', 'CONGO|RDC'], ['CG', 'fr', ''],
  ['ML', 'fr', 'MALI'], ['BF', 'fr', 'BURKINA FASO'], ['GN', 'fr', 'GUINEA|GUINÉE'], ['BJ', 'fr', 'BENIN|BÉNIN'],
  ['TG', 'fr', 'TOGO'], ['HT', 'ht,fr', 'HAITI|HAÏTI'],
  ['FR', 'fr', 'FRANCE'],
  ['BE', 'nl,fr', 'BELGIUM|BELGIQUE|BELGIE|BELGIË|BELGIEN|BELGIAN'],
  ['CH', 'de,fr,it', 'SWITZERLAND|SUISSE|SCHWEIZ|SVIZZERA|SWISS'],
  ['LU', 'lb,fr,de', 'LUXEMBOURG'], ['MC', 'fr', 'MONACO'],
  ['DE', 'de', 'GERMANY|DEUTSCHLAND|ALLEMAGNE|ALEMANIA|GERMANIA'],
  ['AT', 'de', 'AUSTRIA|ÖSTERREICH|OSTERREICH|AUSTRIAN'], ['LI', 'de', 'LIECHTENSTEIN'],
  ['ES', 'es', 'SPAIN|ESPAÑA|ESPANA|ESPAGNE|SPANIEN|SPAGNA'],
  ['MX', 'es', 'MEXICO|MÉXICO|MEXICAN|MEXICANO'],
  ['AR', 'es', 'ARGENTINA'], ['CO', 'es', 'COLOMBIA'], ['PE', 'es', 'PERU|PERÚ'], ['CL', 'es', 'CHILE'],
  ['VE', 'es', 'VENEZUELA'], ['EC', 'es', 'ECUADOR'], ['BO', 'es', 'BOLIVIA'], ['PY', 'es', 'PARAGUAY'],
  ['UY', 'es', 'URUGUAY'], ['CR', 'es', 'COSTA RICA'], ['PA', 'es', 'PANAMA|PANAMÁ'],
  ['GT', 'es', 'GUATEMALA'], ['HN', 'es', 'HONDURAS'], ['SV', 'es', 'EL SALVADOR'], ['NI', 'es', 'NICARAGUA'],
  ['DO', 'es', 'DOMINICAN REPUBLIC|REPUBLICA DOMINICANA|REPÚBLICA DOMINICANA|DOMINICANA'],
  ['CU', 'es', 'CUBA'], ['PR', 'es', 'PUERTO RICO'],
  ['PT', 'pt', 'PORTUGAL'], ['BR', 'pt', 'BRAZIL|BRASIL|BRAZILIAN|BRASILEIRO|BRASILEIRA'],
  ['AO', 'pt', 'ANGOLA'], ['MZ', 'pt', 'MOZAMBIQUE|MOÇAMBIQUE'], ['CV', 'pt', 'CAPE VERDE|CABO VERDE'],
  ['IT', 'it', 'ITALY|ITALIA'], ['SM', 'it', 'SAN MARINO'],
  ['NL', 'nl', 'NETHERLANDS|HOLLAND|NEDERLAND'],
  ['DK', 'da', 'DENMARK|DANMARK'], ['SE', 'sv', 'SWEDEN|SVERIGE'], ['NO', 'no', 'NORWAY|NORGE'],
  ['FI', 'fi', 'FINLAND'], ['IS', 'is', 'ICELAND'], ['FO', 'fo', 'FAROE'],
  ['EE', 'et', 'ESTONIA'], ['LV', 'lv', 'LATVIA'], ['LT', 'lt', 'LITHUANIA'],
  ['PL', 'pl', 'POLAND|POLSKA'], ['CZ', 'cs', 'CZECHIA|CZECH REPUBLIC|ČESKO|CESKO'],
  ['SK', 'sk', 'SLOVAKIA|SLOVENSKO'], ['HU', 'hu', 'HUNGARY|MAGYARORSZÁG|MAGYARORSZAG'],
  ['RO', 'ro', 'ROMANIA|ROMÂNIA'], ['MD', 'ro', 'MOLDOVA'], ['BG', 'bg', 'BULGARIA|БЪЛГАРИЯ'],
  ['RS', 'sr', 'SERBIA|SRBIJA|СРБИЈА'], ['HR', 'hr', 'CROATIA|HRVATSKA'], ['BA', 'bs', 'BOSNIA|BOSNA|BIH'],
  ['SI', 'sl', 'SLOVENIA|SLOVENIJA'], ['MK', 'mk', 'MACEDONIA|NORTH MACEDONIA|МАКЕДОНИЈА'],
  ['ME', 'sr', 'MONTENEGRO|CRNA GORA'], ['AL', 'sq', 'ALBANIA|SHQIPERIA|SHQIPËRIA'], ['XK', 'sq', 'KOSOVO|KOSOVA'],
  ['YU', 'sr,hr,bs', 'EX-YU|EXYU|EX YU|EX-YUGOSLAVIA|YUGOSLAVIA|JUGOSLAVIJA|BALKAN|BALKANS|BALKANI'],
  ['GR', 'el', 'GREECE|HELLAS|ΕΛΛΑΔΑ'], ['CY', 'el', 'CYPRUS'], ['MT', 'mt,en', 'MALTA'],
  ['TR', 'tr', 'TURKEY|TURKIYE|TÜRKIYE|TÜRKİYE'],
  ['RU', 'ru', 'RUSSIA|РОССИЯ'], ['UA', 'uk', 'UKRAINE|УКРАЇНА'], ['BY', 'ru,be', 'BELARUS'],
  ['KZ', 'kk,ru', 'KAZAKHSTAN'], ['UZ', 'uz', 'UZBEKISTAN'], ['KG', 'ky,ru', 'KYRGYZSTAN'],
  ['TJ', 'tg', 'TAJIKISTAN'], ['GE', 'ka', 'GEORGIA|SAKARTVELO'], ['AM', 'hy', 'ARMENIA'],
  ['AZ', 'az', 'AZERBAIJAN'], ['MN', 'mn', 'MONGOLIA'],
  ['IL', 'he', 'ISRAEL'],
  ['SA', 'ar', 'SAUDI ARABIA|SAUDI'], ['AE', 'ar', 'EMIRATES|UNITED ARAB EMIRATES'], ['QA', 'ar', 'QATAR'],
  ['KW', 'ar', 'KUWAIT'], ['BH', 'ar', 'BAHRAIN'], ['OM', 'ar', 'OMAN'], ['YE', 'ar', 'YEMEN'],
  ['JO', 'ar', 'JORDAN'], ['LB', 'ar', 'LEBANON|LIBAN'], ['SY', 'ar', 'SYRIA'], ['IQ', 'ar', 'IRAQ'],
  ['PS', 'ar', 'PALESTINE'], ['EG', 'ar', 'EGYPT|MASR'], ['LY', 'ar', 'LIBYA'],
  ['TN', 'ar,fr', 'TUNISIA|TUNISIE'], ['DZ', 'ar,fr', 'ALGERIA|ALGERIE|ALGÉRIE'],
  ['MA', 'ar,fr', 'MOROCCO|MAROC'], ['SD', 'ar', 'SUDAN'], ['MR', 'ar', 'MAURITANIA'],
  ['IR', 'fa', 'IRAN'], ['AF', 'fa,ps', 'AFGHANISTAN|AFGHAN'], ['PK', 'ur', 'PAKISTAN|PAKISTANI'],
  ['IN', 'hi', 'INDIA|INDIAN|BHARAT'], ['BD', 'bn', 'BANGLADESH'], ['LK', 'si,ta', 'SRI LANKA'],
  ['NP', 'ne', 'NEPAL'],
  ['CN', 'zh', 'CHINA'], ['TW', 'zh', 'TAIWAN'], ['HK', 'zh', 'HONG KONG'], ['MO', 'zh', 'MACAU|MACAO'],
  ['JP', 'ja', 'JAPAN'], ['KR', 'ko', 'KOREA|SOUTH KOREA'], ['KP', 'ko', 'NORTH KOREA'],
  ['VN', 'vi', 'VIETNAM|VIET NAM'], ['TH', 'th', 'THAILAND'], ['KH', 'km', 'CAMBODIA'], ['LA', 'lo', 'LAOS'],
  ['MM', 'my', 'MYANMAR|BURMA'], ['MY', 'ms,en,zh', 'MALAYSIA'], ['SG', 'en,zh,ms,ta', 'SINGAPORE'],
  ['ID', 'id', 'INDONESIA'], ['PH', 'tl,en', 'PHILIPPINES|PILIPINAS'],
];
const COUNTRY = Object.create(null); // cc -> frozen langs
for (const [cc, l] of COUNTRIES) COUNTRY[cc] = langsOf(l);
COUNTRY.UK = COUNTRY.GB;
// Names that are too ambiguous to match loosely inside a group string
const LOOSE_BLOCK = new Set(['GEORGIA', 'JORDAN', 'AMERICA', 'PANAMA', 'CHILE', 'CONGO', 'GUINEA', 'TOGO',
  'MALI', 'OMAN', 'CUBA', 'WALES', 'DOMINICANA', 'BALKAN', 'MASR', 'TRINIDAD', 'SAUDI', 'BIH', 'RDC']);

// ISO 639-2 (B and T) three-letter codes -> 639-1 (pure language table, used for tvg-language)
const ISO3 = Object.create(null);
(function () {
  const t = {
    en: 'eng', de: 'ger deu', fr: 'fre fra', es: 'spa', pt: 'por', ru: 'rus', it: 'ita', hi: 'hin', tr: 'tur',
    ar: 'ara arb', pl: 'pol', ro: 'rum ron', hu: 'hun', cs: 'cze ces', sk: 'slo slk', bg: 'bul', sr: 'srp',
    hr: 'hrv', bs: 'bos', sl: 'slv', mk: 'mac mkd', sq: 'alb sqi', el: 'gre ell', he: 'heb', nl: 'dut nld',
    sv: 'swe', no: 'nor nob nno', da: 'dan', fi: 'fin', is: 'ice isl', et: 'est', lv: 'lav', lt: 'lit',
    zh: 'chi zho cmn yue', ja: 'jpn', ko: 'kor', vi: 'vie', th: 'tha', id: 'ind', ms: 'may msa zsm', tl: 'tgl fil',
    ka: 'geo kat', hy: 'arm hye', az: 'aze', kk: 'kaz', uz: 'uzb', sw: 'swa', am: 'amh', so: 'som',
    af: 'afr', fa: 'per fas pes prs', ur: 'urd', bn: 'ben', pa: 'pan', ta: 'tam', te: 'tel', ml: 'mal',
    kn: 'kan', gu: 'guj', mr: 'mar', or: 'ori ory', ku: 'kur ckb kmr', uk: 'ukr', ca: 'cat', eu: 'baq eus',
    gl: 'glg', cy: 'wel cym', ga: 'gle', mt: 'mlt', be: 'bel', tg: 'tgk', ky: 'kir', mn: 'mon', ne: 'nep',
    si: 'sin', km: 'khm', lo: 'lao', my: 'bur mya', ps: 'pus', sd: 'snd', as: 'asm', yo: 'yor', ha: 'hau',
    ig: 'ibo', zu: 'zul', xh: 'xho', ti: 'tir', rw: 'kin', mg: 'mlg', ht: 'hat', lb: 'ltz', fo: 'fao',
    dv: 'div', bo: 'tib bod', mul: 'mul',
  };
  for (const k in t) for (const c of t[k].split(' ')) ISO3[c] = k;
})();

// ---------------------------------------------------------------------------
// Token table: UPPERCASE key -> entry
//   k: 'L' language, 'C' country/region with a language, 'A' ambiguous (AR), 'M' multi,
//      'R' region without a language (AFR, ASIA ...), 'Q' quality/noise (HD, 4K, VIP...),
//      'W' category word (MOVIES, SPORTS ...) - only skippable as a whole segment
//   strict: short code -> must be written in UPPERCASE unless inside brackets
//   cn: country name -> in item names must be UPPERCASE (avoids 'Brazil' the film)
// ---------------------------------------------------------------------------
const TOK = new Map();
function normKey(k) {
  k = String(k).toUpperCase().trim();
  if (k.indexOf('.') >= 0) k = k.replace(/\./g, '');
  if (k.indexOf('  ') >= 0) k = k.replace(/\s+/g, ' ');
  return k;
}
function stripMarks(k) { return k.normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function put(key, k, langs, cc, force, cn) {
  key = normKey(key);
  if (!key) return;
  const variants = [key];
  const plain = stripMarks(key);
  if (plain !== key) variants.push(plain);
  for (const v of variants) {
    if (!force && TOK.has(v)) continue;
    const ascii = /^[A-Z]{1,3}$/.test(v);
    TOK.set(v, {
      k, l: langs || EMPTY, cc: cc || '',
      strict: ascii && k !== 'Q' && k !== 'W',
      cn: !!cn,
    });
  }
}

(function buildTokens() {
  // 1. explicit language words (English names, native names, exonyms, IPTV usage)
  const words = {
    en: 'ENGLISH|ENGLISCH|ANGLAIS|INGLES|INGLÉS|INGLÊS|INGLESE|ANGOL|ENG|EN',
    fr: 'FRENCH|FRANCAIS|FRANÇAIS|FRANCES|FRANCÉS|FRANCÊS|FRANZÖSISCH|FRANZOSISCH|FRANCESE|VF|VFF|VFQ|VOSTFR|VOSTF|FRE|FRA|FR',
    de: 'GERMAN|DEUTSCH|ALEMAN|ALEMÁN|ALLEMAND|TEDESCO|ALEMÃO|GER|DEU|DE',
    es: 'SPANISH|ESPAÑOL|ESPANOL|ESPAGNOL|SPANISCH|SPAGNOLO|ESPANHOL|CASTELLANO|CASTILIAN|LATINO|LATINA|LATINOS|LATAM|LATIN|LAT|HISPANIC|HISPANO|LATINOAMERICA|LATIN AMERICA|LATINO AMERICA|LATINOAMÉRICA|DOBLADO|SUBTITULADO|SPA|ESP|ES',
    pt: 'PORTUGUESE|PORTUGUÊS|PORTUGUES|PORTUGAIS|PORTUGUÉS|PORTOGHESE|PORTUGIESISCH|DUBLADO|LEGENDADO|POR|PT',
    it: 'ITALIAN|ITALIANO|ITALIEN|ITALIENISCH|ITA|IT',
    ar: 'ARABIC|ARAB|ARABE|ARABI|ARABISCH|ARABO|ARABIA|ARABIAN|عربي|عربية|العربية|العربي|ARA|ARB',
    ru: 'RUSSIAN|RUSSE|RUSO|RUSSO|RUSSISCH|РУССКИЙ|РУССКОЕ|RUS|RU',
    tr: 'TURKISH|TÜRKÇE|TURKCE|TURC|TURCO|TÜRK|TURK|TÜRKISCH|TURKCE|TUR|TR',
    hi: 'HINDI|हिन्दी|हिंदी|HIN|HI|BOLLYWOOD',
    ur: 'URDU|اردو|URD|UR',
    bn: 'BENGALI|BANGLA|বাংলা|BEN|BAN|BN',
    pa: 'PUNJABI|PANJABI|ਪੰਜਾਬੀ|PAN|PUN|PA',
    ta: 'TAMIL|தமிழ்|TAM|TA|KOLLYWOOD',
    te: 'TELUGU|తెలుగు|TEL|TE|TOLLYWOOD',
    ml: 'MALAYALAM|മലയാളം|MAL|ML|MOLLYWOOD',
    kn: 'KANNADA|ಕನ್ನಡ|KAN|KN|SANDALWOOD',
    gu: 'GUJARATI|ગુજરાતી|GUJ|GU',
    mr: 'MARATHI|मराठी|MAR|MR',
    or: 'ODIA|ORIYA|ORI',
    as: 'ASSAMESE',
    fa: 'PERSIAN|FARSI|DARI|فارسی|IRANIAN|PER|FAS|FAR|FA',
    ps: 'PASHTO|PASHTU|PUSHTO|پښتو|PUS|PAS|PS',
    ku: 'KURDISH|KURDI|KURDÎ|KURD|KURDISTAN|SORANI|KURMANJI|BADINI|کوردی|KUR|KU',
    pl: 'POLISH|POLSKI|POLONAIS|POLACCO|POLNISCH|POL|PL',
    ro: 'ROMANIAN|ROMANA|ROMÂNĂ|ROMÂNA|ROUMAIN|RUMANO|RUM|RON|ROM|RO',
    hu: 'HUNGARIAN|MAGYAR|HONGROIS|HUN|HU',
    cs: 'CZECH|ČESKY|CESKY|ČEŠTINA|CESTINA|CZE|CES|CS',
    sk: 'SLOVAK|SLOVENSKY|SLOVENSKÝ|SLOVENČINA|SLK|SK',
    bg: 'BULGARIAN|БЪЛГАРСКИ|BULGARSKI|BUL|BG',
    sr: 'SERBIAN|SRPSKI|СРПСКИ|SRP|SRB|SR',
    hr: 'CROATIAN|HRVATSKI|HRV|CRO|HR',
    bs: 'BOSNIAN|BOSANSKI|BOS|BS',
    sl: 'SLOVENIAN|SLOVENE|SLOVENSKI|SLOVENŠČINA|SLV|SLO|SL',
    mk: 'MACEDONIAN|МАКЕДОНСКИ|MAKEDONSKI|MKD|MAC|MK',
    sq: 'ALBANIAN|SHQIP|SHQIPTAR|SHQIPTARE|ALB|SQI|SQ',
    el: 'GREEK|ΕΛΛΗΝΙΚΑ|ELLINIKA|GREC|GRIEGO|GRIECHISCH|GRE|ELL|EL',
    he: 'HEBREW|עברית|IVRIT|HEB|HE',
    nl: 'DUTCH|NEDERLANDS|HOLLANDS|NEERLANDAIS|FLEMISH|VLAAMS|DUT|NLD|NED|NL|VL',
    sv: 'SWEDISH|SVENSKA|SVENSK|SWE|SV',
    no: 'NORWEGIAN|NORSK|NOR|NO|NB',
    da: 'DANISH|DANSK|DAN|DA',
    fi: 'FINNISH|SUOMI|SUOMEKSI|FIN|FI',
    is: 'ICELANDIC|ÍSLENSKA|ISLENSKA|ICE|ISL|IS',
    et: 'ESTONIAN|EESTI|EST|ET',
    lv: 'LATVIAN|LATVIEŠU|LATVIESU|LAV|LV',
    lt: 'LITHUANIAN|LIETUVIŲ|LIETUVIU|LIT|LT',
    zh: 'CHINESE|中文|MANDARIN|CANTONESE|普通话|國語|国语|粵語|粤语|华语|華語|CHI|ZHO|ZH',
    ja: 'JAPANESE|日本語|JPN|JAP|JA',
    ko: 'KOREAN|한국어|KDRAMA|K-DRAMA|KOR|KO',
    vi: 'VIETNAMESE|TIẾNG VIỆT|TIENG VIET|VIE|VI',
    th: 'THAI|ไทย|THA|TH',
    id: 'INDONESIAN|BAHASA INDONESIA|INDO|ID',
    ms: 'MALAY|MELAYU|BAHASA MELAYU|BAHASA MALAYSIA|MSA|MS',
    tl: 'FILIPINO|TAGALOG|PINOY|TGL|FIL|TL',
    ka: 'GEORGIAN|ქართული|KARTULI|GEO|KAT|KA',
    hy: 'ARMENIAN|ՀԱՅԵՐԵՆ|HAYEREN|ARM|HYE|HY',
    az: 'AZERBAIJANI|AZERI|AZƏRBAYCAN|AZERBAYCAN|AZE|AZ',
    kk: 'KAZAKH|ҚАЗАҚ|QAZAQ|KAZ|KK',
    uz: 'UZBEK|OʻZBEK|O\'ZBEK|OZBEK|UZB|UZ',
    sw: 'SWAHILI|KISWAHILI|SWA|SW',
    am: 'AMHARIC|አማርኛ|AMH',
    so: 'SOMALI|SOOMAALI|SOM|SO',
    af: 'AFRIKAANS',
    uk: 'UKRAINIAN|УКРАЇНСЬКА|UKRAINSKA|UKR',
    ca: 'CATALAN|CATALÀ|CATALA|CAT',
    eu: 'BASQUE|EUSKARA|EUSKERA|BAQ|EUS',
    gl: 'GALICIAN|GALEGO|GLG|GL',
    cy: 'WELSH|CYMRAEG|WEL|CYM',
    ga: 'GAEILGE|GAELIC|GLE|GA',
    mt: 'MALTESE|MALTI|MLT|MT',
    be: 'BELARUSIAN|БЕЛАРУСКАЯ|BYELORUSSIAN',
    tg: 'TAJIK|TOJIKI|TGK|TG',
    ky: 'KYRGYZ|KIRGHIZ|KIR|KY',
    mn: 'MONGOLIAN|MON|MN',
    ne: 'NEPALI|नेपाली|NEP|NE',
    si: 'SINHALA|SINHALESE|SIN|SI',
    km: 'KHMER|KHM|KM',
    lo: 'LAO|LAOTIAN',
    my: 'BURMESE|BUR|MYA',
    sd: 'SINDHI|SND|SD',
    yo: 'YORUBA|YOR|YO',
    ha: 'HAUSA|HAU|HA',
    ig: 'IGBO|IBO|IG',
    zu: 'ZULU|ISIZULU|ZUL|ZU',
    xh: 'XHOSA|ISIXHOSA|XHO|XH',
    ti: 'TIGRINYA|TIGRIGNA|TIR|TI',
    rw: 'KINYARWANDA|KIN|RW',
    mg: 'MALAGASY|MLG|MG',
    ht: 'HAITIAN|CREOLE|KREYOL|KREYÒL|HAT|HT',
    lb: 'LUXEMBOURGISH|LËTZEBUERGESCH|LETZEBUERGESCH|LTZ|LB',
    fo: 'FAROESE|FØROYSKT|FAO|FO',
    dv: 'DHIVEHI|DIVEHI|DIV|DV',
    bo: 'TIBETAN|TIB|BOD|BO',
  };
  // Country codes that win over the identical ISO 639-1 code (IPTV prefixes are usually countries)
  const countryWins = new Set(['AF', 'BE', 'CA', 'CY', 'LB', 'MY', 'PS', 'SE', 'SI', 'BO', 'UK']);
  // 2/3-letter codes that are never treated as languages/countries (noise or English words)
  const banned = new Set(['AM', 'AS', 'OR', 'TO', 'LA', 'MAY', 'AN']);

  // country codes / names first (so explicit language words below can override where intended)
  for (const [cc, l, nm] of COUNTRIES) {
    const langs = COUNTRY[cc];
    if (!banned.has(cc) && cc !== 'QC' && cc !== 'AR') put(cc, 'C', langs, cc);
    if (nm) for (const n of nm.split('|')) put(n, 'C', langs, cc, false, true);
    void l;
  }
  put('UK', 'C', COUNTRY.GB, 'GB', true);
  put('QC', 'C', COUNTRY.QC, 'QC');
  // three-letter country abbreviations used by providers (ISO alpha-3 + sports/IPTV style)
  const abbr = {
    US: 'USA', GB: 'GBR', CA: 'CAN', AU: 'AUS', IE: 'IRL', NZ: 'NZL', ZA: 'RSA ZAF', NG: 'NGA NGR NIG',
    KE: 'KEN', GH: 'GHA', ET: 'ETH', ER: 'ERI', BE: 'BEL', CH: 'SUI CHE SWI', LU: 'LUX', AT: 'AUT',
    MX: 'MEX', AR: 'ARG', CO: 'COL', CL: 'CHL', VE: 'VEN', EC: 'ECU', BO: 'BOL', PY: 'PRY PAR',
    UY: 'URY URU', CR: 'CRC CRI', GT: 'GUA GTM', HN: 'HON HND', NI: 'NCA NIC', DO: 'DOM', CU: 'CUB',
    PR: 'PUR PRI', PT: 'PRT', BR: 'BRA', NL: 'HOL', DK: 'DNK DEN', LV: 'LVA', LT: 'LTU', SK: 'SVK',
    RO: 'ROU', MD: 'MDA', BG: 'BGR', RS: 'SRB SER', HR: 'CRO', BA: 'BIH', SI: 'SVN SLO', XK: 'KOS',
    GR: 'GRC', CY: 'CYP', BY: 'BLR', KG: 'KGZ', TJ: 'TJK', IL: 'ISR', SA: 'KSA SAU', AE: 'UAE ARE',
    QA: 'QAT', KW: 'KUW KWT', BH: 'BHR', OM: 'OMA OMN', YE: 'YEM', JO: 'JOR', LB: 'LBN', SY: 'SYR',
    IQ: 'IRQ', PS: 'PLE PSE', EG: 'EGY', LY: 'LBY', TN: 'TUN', DZ: 'ALG DZA', MA: 'MOR', IR: 'IRN IRI',
    AF: 'AFG', PK: 'PAK', IN: 'IND', BD: 'BGD', LK: 'LKA SRI', NP: 'NPL', CN: 'CHN', TW: 'TWN', HK: 'HKG',
    KP: 'PRK', VN: 'VNM', MM: 'MMR', MY: 'MYS MAS', SG: 'SGP', ID: 'IDN INA', PH: 'PHL PHI', SN: 'SEN',
    CI: 'CIV', CM: 'CMR', HT: 'HTI', AO: 'AGO', MZ: 'MOZ', JM: 'JAM', YU: 'YUG',
  };
  for (const cc in abbr) for (const a of abbr[cc].split(' ')) put(a, 'C', COUNTRY[cc], cc, true);

  // language words: override a country entry only when the country speaks it, or the language wins
  for (const code in words) {
    const langs = LANG1[code];
    for (const w of words[code].split('|')) {
      const key = normKey(w);
      const prev = TOK.get(key);
      if (prev && prev.k === 'C') {
        if (countryWins.has(key)) continue;
        // e.g. FR (France/French): same language -> language token, keeps cc for 'CA FR' style refinement
        if (prev.l[0] === code || key.length >= 3 || /^(BN|BS|ET|GA|GL|GU|KM|KN|KY|ML|MR|MS|NE|PA|SL|SR|SV|TG|TL|VI|SO|HI)$/.test(key)) {
          put(key, 'L', langs, prev.l[0] === code ? prev.cc : '', true);
        }
        continue;
      }
      put(key, 'L', langs, '', true);
    }
  }
  // 'IND' = India here (Indonesian is spelled out), 'SLO' = Slovenia (sports style), 'BEL' = Belgium
  put('IND', 'C', COUNTRY.IN, 'IN', true);
  put('SLO', 'C', COUNTRY.SI, 'SI', true);
  put('BEL', 'C', COUNTRY.BE, 'BE', true);
  put('IRISH', 'C', COUNTRY.IE, 'IE', true); // IPTV "IRISH" groups = Irish channels, broadcast in English
  put('KOREA', 'C', COUNTRY.KR, 'KR', true, true);
  // AR: Arabic vs Argentina, resolved per item from context
  put('AR', 'A', LANG1.ar, '', true);

  // multi-language markers
  for (const m of ['MULTI', 'MULTISUB', 'MULTI-SUB', 'MULTI SUB', 'MULTI SUBS', 'MULTIAUDIO', 'MULTI-AUDIO', 'MULTI AUDIO',
    'MULTILANG', 'MULTI-LANG', 'MULTI LANG', 'MULTILANGUAGE', 'MULTI-LANGUAGE', 'MULTI LANGUAGE', 'MULTILINGUAL',
    'MULTIPLE', 'MULTIPLE LANGUAGES', 'MUL', 'DUAL AUDIO', 'DUAL-AUDIO', 'DUAL', 'MULTI-AUDIO-SUB']) put(m, 'M', MUL, '', true);

  // regions without one language
  for (const r of ['AFR', 'AFRICA', 'AFRIQUE', 'AFRICAN', 'AFRICAINE', 'ASIA', 'ASIAN', 'ASIE', 'EU', 'EUR', 'EUROPE',
    'EUROPEAN', 'INT', 'INTL', 'INTERNATIONAL', 'WORLD', 'WORLDWIDE', 'GLOBAL', 'MIDDLE EAST', 'ME-NA', 'CARIBBEAN',
    'OTHERS', 'OTHER', 'MIXED', 'MISC', 'NORDIC', 'SCANDINAVIA', 'SCANDINAVIAN']) put(r, 'R', EMPTY, '', true);

  // quality / noise tokens (may appear inside a language segment: 'UK HD | ...')
  for (const q of ['4K', '8K', 'UHD', 'FHD', 'HD', 'SD', 'HQ', 'LQ', 'HEVC', 'H265', 'H264', 'X265', 'X264', '10BIT',
    'HDR', 'HDR10', '3D', '50FPS', '60FPS', '1080P', '720P', '2160P', '4K UHD', 'VIP', 'PREMIUM', '24/7', '24-7',
    '24X7', 'PPV', 'NBA', 'NFL', 'UFC', 'MLB', 'NHL', 'NCAA', 'WWE', 'F1', 'EPL', 'MLS', 'BACKUP', 'RAW', 'SUB', 'SUBS',
    'SUBBED', 'DUB', 'DUBBED', 'VO', 'VOST', 'NEW', 'TOP', 'PLUS', 'HOT', 'ALL', 'FHD+', 'HD+', 'UHD+']) {
    put(q, 'Q', EMPTY, '', true);
  }
  // category words (only skippable as a whole segment: 'VOD - FRENCH', 'MOVIES | EN')
  for (const w of ['VOD', 'LIVE', 'TV', 'MOVIES', 'MOVIE', 'FILMS', 'FILM', 'CINEMA', 'SERIES', 'SERIE', 'SERIALS',
    'SHOWS', 'SPORT', 'SPORTS', 'NEWS', 'KIDS', 'MUSIC', 'DOCS', 'DOCUMENTARY', 'DOCUMENTARIES', 'ENTERTAINMENT',
    'GENERAL', 'RELIGIOUS', 'ADULT', 'XXX', 'CHANNELS', 'CHANNEL', 'RADIO', 'EVENTS', 'EVENT', 'CHAÎNES', 'CHAINES',
    'NETFLIX', 'TV SHOWS', 'TV SERIES', 'ANIME', 'CARTOONS', 'LOCAL', 'LOCALS']) put(w, 'W', EMPTY, '', true);
  for (const b of banned) if (TOK.has(b) && TOK.get(b).k !== 'Q' && TOK.get(b).k !== 'W' && TOK.get(b).k !== 'R') TOK.delete(b);
  // English names + native names from the language table (adds anything not yet covered)
  for (const [c, n, nat] of LANGS) {
    if (c === 'mul') continue;
    put(n, 'L', LANG1[c]); put(nat, 'L', LANG1[c]);
  }
})();

// First word of every multi-word / joined key ('UNITED' for 'UNITED KINGDOM', 'EX' for 'EX-YU', '24' for '24/7')
const MULTI_FIRST = new Set();
for (const key of TOK.keys()) {
  const m = /^[^\s\-\/&+,'_]+(?=[\s\-\/&+,'_])/.exec(key);
  if (m) MULTI_FIRST.add(m[0]);
}

// Loose words matched anywhere inside group / category strings ('ENGLISH MOVIES', 'Movies Arabic', 'Sports USA')
const LOOSE = new Map();
for (const [key, e] of TOK) {
  if (e.k !== 'L' && e.k !== 'C' && e.k !== 'A') continue;
  if (/^[A-Z]{1,3}$/.test(key)) continue; // short codes only in tag positions
  if (key === 'LAT' || key === 'TURK' || key === 'INDO' || key === 'DUAL' || key === 'CREOLE' || key === 'HAITIAN') continue;
  const first = key.split(' ')[0];
  if (LOOSE_BLOCK.has(key) || LOOSE_BLOCK.has(first)) continue;
  LOOSE.set(key, e);
}
for (const k of ['USA', 'UAE', 'KSA']) LOOSE.set(k, TOK.get(k));

// Codes accepted as a bare trailing word in an item NAME ('Avatar ENG'); countries never ('The Office US')
const NAME_TRAIL = new Set(['EN', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'RU', 'TR', 'AR', 'SV', 'DA', 'FI', 'RO', 'HU',
  'HR', 'SR', 'BG', 'HE', 'ZH', 'JA', 'FA', 'UR', 'KU', 'SQ', 'MK', 'SL', 'SK',
  'ENG', 'GER', 'DEU', 'FRE', 'FRA', 'SPA', 'ESP', 'POR', 'RUS', 'ITA', 'HIN', 'TUR', 'ARA', 'POL', 'DUT', 'NLD',
  'NED', 'SWE', 'GRE', 'HEB', 'JPN', 'KOR', 'CHI', 'UKR', 'CZE', 'HUN', 'RUM', 'RON', 'SRB', 'HRV', 'CRO', 'BUL',
  'ALB', 'PER', 'URD', 'VIE', 'THA', 'MULTI', 'MULTISUB', 'VOSTFR', 'VF', 'VFF', 'LATINO', 'CASTELLANO', 'DUBLADO',
  'LEGENDADO']);
// Full language names accepted as the last word of an item NAME ('Al Jazeera English', 'RT Español'),
// unless preceded by an article/possessive ('Pardon My French', 'The English')
const NAME_TRAIL_WORD = new Map();
for (const [c, n, nat] of LANGS) {
  if (c === 'mul') continue;
  for (const w of [n, nat]) {
    if (w.indexOf(' ') >= 0 || w.length < 4) continue;
    const k = w.toUpperCase();
    NAME_TRAIL_WORD.set(k, LANG1[c]); NAME_TRAIL_WORD.set(stripMarks(k), LANG1[c]);
  }
}
for (const [w, c] of [['ESPANOL', 'es'], ['CASTELLANO', 'es'], ['LATINO', 'es'], ['FRANCAIS', 'fr'], ['FARSI', 'fa'],
  ['BANGLA', 'bn'], ['ARABE', 'ar'], ['TURKCE', 'tr'], ['ESPAÑOL', 'es'], ['PORTUGUES', 'pt'], ['DUBLADO', 'pt'],
  ['LEGENDADO', 'pt'], ['TAGALOG', 'tl'], ['KURDI', 'ku'], ['SORANI', 'ku'], ['MANDARIN', 'zh'], ['CANTONESE', 'zh']]) {
  NAME_TRAIL_WORD.set(w, LANG1[c]);
}
NAME_TRAIL_WORD.delete('IRISH'); // 'Irish' channels are English; handled as a country elsewhere
const NAME_TRAIL_PREV = /(?:^|\s)(?:the|my|a|an|of|your|his|her|our|their|in)\s+$/i;

// Codes NOT accepted as a bare (space separated) group prefix: they are English words ('IT Crowd', 'NO Limit')
const GROUP_BARE_BLOCK = new Set(['IT', 'NO', 'BE', 'ME', 'DO', 'IS', 'AT', 'SO', 'MY', 'HE', 'HI', 'ID', 'PA',
  'TO', 'GO', 'UP', 'ON', 'CAN', 'ICE', 'ARM', 'FIN', 'MAR', 'PER', 'CAT', 'BAN', 'PAN', 'TEL', 'MAL',
  'SIN', 'DAN', 'EST', 'LIT', 'BEN', 'TAM', 'KAN', 'POR', 'NOR', 'BOS', 'GEO', 'DUAL', 'ALL', 'LAT']);
// Codes NOT accepted as a bare trailing word of a group ('Let it BE')
const GROUP_TRAIL_BLOCK = new Set(['IS', 'ME', 'DO', 'AT', 'SO', 'MY', 'HE', 'HI', 'TO', 'GO', 'UP', 'ON', 'ID', 'PA',
  'BE', 'CAN', 'ICE', 'ARM', 'FIN', 'MAR', 'PER', 'CAT', 'BAN', 'PAN', 'TEL', 'MAL', 'SIN', 'DAN', 'EST', 'LIT', 'BEN',
  'TAM', 'KAN', 'BOS', 'GEO', 'DUAL', 'ALL']);

// ---------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------
const C_W = 0, C_S = 1, C_P = 2, C_J = 3, C_D = 4;
const ASCII = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  let t = C_P;
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) t = C_W;
  else if (c === 32 || (c >= 9 && c <= 13)) t = C_S;
  else if (c === 47 || c === 38 || c === 43 || c === 44 || c === 46 || c === 39 || c === 95) t = C_J; // / & + , . ' _
  else if (c === 45) t = C_D;
  ASCII[c] = t;
}
function cls(c) {
  if (c < 128) return ASCII[c];
  if (c === 0xA0) return C_S;
  if (c < 0xC0) return C_P;
  if (c === 0xD7 || c === 0xF7) return C_P;
  if (c < 0x2000) return c === 0x2BB || c === 0x2BC ? C_J : C_W;
  if (c <= 0x200F || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F) return C_S;
  if (c === 0x2010 || c === 0x2011) return C_D;
  if (c === 0x2019) return C_J;
  if (c < 0x2C00) return C_P;
  if (c < 0x2E00) return C_W;
  if (c < 0x3040) return c === 0x3000 ? C_S : (c >= 0x3005 && c <= 0x3007) ? C_W : C_P;
  if (c < 0xD800) return C_W;
  if (c < 0xF900) return C_P;
  if (c < 0xFE00) return C_W;
  if (c < 0xFE70) return C_P;
  if (c < 0xFF00) return c === 0xFEFF ? C_S : C_W;
  if (c <= 0xFF0F || (c >= 0xFF1A && c <= 0xFF20) || (c >= 0xFF3B && c <= 0xFF40) || (c >= 0xFF5B && c <= 0xFF65)) return C_P;
  return C_W;
}
// a '-' acts as a separator when next to whitespace/punctuation ('US - CNN'), not inside words ('EX-YU')
function dashSep(s, i, len) {
  if (i === 0 || i + 1 >= len) return true;
  const p = cls(s.charCodeAt(i - 1)), n = cls(s.charCodeAt(i + 1));
  return p === C_S || n === C_S || p === C_D || n === C_D || p === C_P || n === C_P;
}
function isOpenBr(c) { return c === 40 || c === 91 || c === 123 || c === 124 || c === 0xFF08 || c === 0x3010; }
function isCloseBr(c) { return c === 41 || c === 93 || c === 125 || c === 124 || c === 0xFF09 || c === 0x3011; }
// characters trimmed from the ends of a cleaned string (never closing brackets or '+')
function isTrimChar(c) {
  if (c < 128) return c <= 32 || c === 124 || c === 58 || c === 45 || c === 61 || c === 126 || c === 62 || c === 47 ||
    c === 44 || c === 59 || c === 42 || c === 35 || c === 95 || c === 60 || c === 46;
  return c === 0xA0 || c === 0xA6 || c === 0xB7 || c === 0xBB || c === 0xAB || (c >= 0x2000 && c <= 0x206F) ||
    (c >= 0x2190 && c <= 0x2BFF) || c === 0x3000 || c === 0xFEFF || (c >= 0xD800 && c <= 0xDFFF) || c === 0xFE0F;
}

// ---------------------------------------------------------------------------
// Segment classification (scratch state, single threaded)
// ---------------------------------------------------------------------------
const K_NONE = 0, K_L = 1, K_C = 2, K_A = 3, K_M = 4, K_R = 5;
const SEG_REJECT = 0, SEG_LANG = 1, SEG_NOISE = 2;
const AR_MARK = '\u0000ar';
// segment scratch
const sL = [], sC = [];
let sCC = '', sA = false, sM = false, sR = false, sQ = 0, sW = 0, sN = 0;
// parse scratch
const pL = [], pC = [];
let pCC = '', pA = false, pM = false, pR = false;

function applyEntry(e) {
  sN++;
  switch (e.k) {
    case 'L': for (let i = 0; i < e.l.length; i++) sL.push(e.l[i]); if (e.cc && !sCC) sCC = e.cc; break;
    case 'C': for (let i = 0; i < e.l.length; i++) sC.push(e.l[i]); if (!sCC) sCC = e.cc; break;
    case 'A': sA = true; sL.push(AR_MARK); break;
    case 'M': sM = true; break;
    case 'R': sR = true; break;
    case 'Q': sQ++; break;
    default: sW++;
  }
}
function caseOk(e, tok, up, bracketed, isGroup) {
  if (bracketed) return true;
  if (e.strict && tok !== up) return false;
  if (e.cn && !isGroup && tok !== up) return false;
  return true;
}
function classify(s, a, b, bracketed, isGroup) {
  sL.length = 0; sC.length = 0; sCC = ''; sA = sM = sR = false; sQ = sW = sN = 0;
  if (b <= a || b - a > 40) return SEG_REJECT;
  let simple = true;
  for (let p = a; p < b; p++) if (cls(s.charCodeAt(p)) !== C_W) { simple = false; break; }
  const raw = s.slice(a, b);
  if (!simple) {
    let q = a;
    while (q < b && cls(s.charCodeAt(q)) === C_W) q++;
    const fu = raw.slice(0, q - a).toUpperCase();
    if (q > a && !TOK.has(fu) && !MULTI_FIRST.has(fu)) return SEG_REJECT;
  }
  const up = simple ? raw.toUpperCase() : normKey(raw);
  let e = TOK.get(up);
  if (e !== undefined) {
    const caseTok = simple ? raw : raw.replace(/\./g, '').replace(/\s+/g, ' ');
    if (!caseOk(e, caseTok, up, bracketed, isGroup)) return SEG_REJECT;
    applyEntry(e);
  } else {
    if (simple) return SEG_REJECT;
    let p = a;

    while (p < b) {
      while (p < b && cls(s.charCodeAt(p)) !== C_W) p++;
      if (p >= b) break;
      const st = p;
      while (p < b && cls(s.charCodeAt(p)) === C_W) p++;
      if (sN >= 5) return SEG_REJECT;
      const tok = s.slice(st, p), tu = tok.toUpperCase();
      e = TOK.get(tu);
      if (e === undefined || !caseOk(e, tok, tu, bracketed, isGroup)) return SEG_REJECT;
      applyEntry(e);
    }
    if (sW > 0 && sN > 1) return SEG_REJECT;
  }
  if (sL.length || sC.length || sM || sR) return SEG_LANG;
  if (sQ || sW) return SEG_NOISE;
  return SEG_REJECT;
}
function commitSeg() {
  for (let i = 0; i < sL.length; i++) pL.push(sL[i]);
  for (let i = 0; i < sC.length; i++) pC.push(sC[i]);
  if (sCC && !pCC) pCC = sCC;
  if (sA) pA = true; if (sM) pM = true; if (sR) pR = true;
}
function strongFound() { return pL.length > 0 || pC.length > 0; }

// removal ranges
const remA = [], remB = [];
function addRem(a, b) {
  for (let i = 0; i < remA.length; i++) {
    if (a <= remB[i] && b >= remA[i]) { if (a < remA[i]) remA[i] = a; if (b > remB[i]) remB[i] = b; return; }
  }
  remA.push(a); remB.push(b);
}
function insideRem(a, b) {
  for (let i = 0; i < remA.length; i++) if (a >= remA[i] && b <= remB[i]) return true;
  return false;
}
function buildClean(s) {
  if (remA.length === 0) return s;
  let out;
  if (remA.length === 1) out = s.slice(0, remA[0]) + s.slice(remB[0]);
  else {
    const idx = remA.map((x, i) => i).sort((x, y) => remA[x] - remA[y]);
    out = ''; let pos = 0;
    for (const i of idx) { if (remA[i] > pos) out += s.slice(pos, remA[i]); if (remB[i] > pos) pos = remB[i]; }
    out += s.slice(pos);
  }
  let a = 0, b = out.length;
  while (a < b && isTrimChar(out.charCodeAt(a))) a++;
  while (b > a && isTrimChar(out.charCodeAt(b - 1))) b--;
  out = out.slice(a, b);
  if (/\s\s/.test(out)) out = out.replace(/\s{2,}/g, ' ');
  // unbalanced leftovers like 'Movies (' or ') News'
  if (out.length === 0) return s.trim();
  return out;
}

const BR_RE = /[\[({（【]\s*([^\[\](){}（）【】]{1,30}?)\s*[\])}）】]/g;

/**
 * Parse tags out of a name or group string.
 * Returns null (names only, nothing found) or { langs, kind, cc, clean, how }.
 */
function hasTagChars(s, len) {
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      const t = ASCII[c];
      if (t === C_P) return true;
      if (t === C_D && dashSep(s, i, len)) return true;
    } else {
      const t = cls(c);
      if (t === C_P || (t === C_D && dashSep(s, i, len))) return true;
    }
  }
  return false;
}
function parseText(s, isGroup) {
  const len = s.length;
  if (!isGroup && !hasTagChars(s, len)) return trailingWordOnly(s, len);
  pL.length = 0; pC.length = 0; pCC = ''; pA = pM = pR = false;
  remA.length = 0; remB.length = 0;
  let how = '';

  // ---- 1. leading segments: 'UK: ', '|UK| ', '[UK] ', 'CA EN | ', 'VIP | UK | ', 'VOD - FRENCH'
  let i = 0, seg = 0, keptAny = false, prevKeptEnd = 0;
  while (seg < 4 && i < len) {
    while (i < len) { const c = cls(s.charCodeAt(i)); if (c === C_W) break; i++; }
    if (i >= len) break;
    const a = i;
    while (i < len) {
      const c = cls(s.charCodeAt(i));
      if (c === C_W || c === C_J || c === C_S) i++;
      else if (c === C_D) { if (dashSep(s, i, len)) break; i++; } else break;
      if (i - a > 40) break;
    }
    if (i - a > 40) break;
    let b = i;
    while (b > a) { const c = cls(s.charCodeAt(b - 1)); if (c === C_S || c === C_J) b--; else break; }
    let j = i;
    while (j < len) {
      const c = cls(s.charCodeAt(j));
      if (c === C_S || c === C_P) j++; else if (c === C_D && dashSep(s, j, len)) j++; else break;
    }
    const hadSep = i < len;
    if (!hadSep && !isGroup && seg === 0) break; // a whole bare name is never a tag ('IT Crowd', 'Brazil')
    const bracketed = a > 0 && isOpenBr(s.charCodeAt(a - 1)) && i < len && isCloseBr(s.charCodeAt(i));
    const r = classify(s, a, b, bracketed, isGroup);
    if (r === SEG_REJECT) break;
    if (r === SEG_NOISE) { keptAny = true; prevKeptEnd = b; seg++; i = j; continue; }
    commitSeg();
    if (!keptAny) addRem(0, j);
    else if (j >= len) addRem(prevKeptEnd, len);
    else addRem(a, j);
    if (!how) how = keptAny && j >= len ? 'tag' : 'prefix';
    seg++; i = j;
  }

  // ---- 2. bracketed tags anywhere: 'Movies (EN)', 'Series [ITA]', 'Sky Sports [UK] HD'
  if (!strongFound() && (s.indexOf('(') >= 0 || s.indexOf('[') >= 0 || s.indexOf('{') >= 0 || s.indexOf('（') >= 0 || s.indexOf('【') >= 0)) {
    BR_RE.lastIndex = 0;
    let m;
    while ((m = BR_RE.exec(s)) !== null) {
      const st = m.index + m[0].indexOf(m[1]);
      if (insideRem(m.index, m.index + m[0].length)) continue;
      const r = classify(s, st, st + m[1].length, true, isGroup);
      if (r === SEG_LANG) {
        commitSeg(); addRem(m.index, m.index + m[0].length);
        if (!how) how = 'tag';
        if (strongFound()) { how = how === 'prefix' && remA.length === 1 ? 'prefix' : 'tag'; break; }
      }
    }
  }

  // ---- 3. trailing segment after a separator: 'News | EN', 'Game of Thrones - DE'
  if (!strongFound()) {
    let e = len;
    while (e > 0 && cls(s.charCodeAt(e - 1)) === C_S) e--;
    let q = e;
    while (q > 0 && e - q <= 32) {
      const c = cls(s.charCodeAt(q - 1));
      if (c === C_W || c === C_J || c === C_S) q--;
      else if (c === C_D && !dashSep(s, q - 1, len)) q--;
      else break;
    }
    if (q > 0 && q < e && e - q <= 32) {
      let a2 = q;
      while (a2 < e && cls(s.charCodeAt(a2)) !== C_W) a2++;
      let r0 = q;
      while (r0 > 0) { const c = s.charCodeAt(r0 - 1); if (isTrimChar(c) || cls(c) === C_P) r0--; else break; }
      if (r0 > 0 && a2 < e && !insideRem(a2, e) && !isCloseBr(s.charCodeAt(q - 1))) {
        const r = classify(s, a2, e, false, isGroup);
        if (r === SEG_LANG) { commitSeg(); addRem(r0, len); if (!how) how = 'tag'; }
      }
    }
  }

  // ---- 4. trailing bare word: 'Netflix EN' (groups), 'Avatar ENG' (names, whitelist only)
  if (!strongFound()) {
    let e = len;
    while (e > 0 && cls(s.charCodeAt(e - 1)) === C_S) e--;
    let q = e;
    while (q > 0 && cls(s.charCodeAt(q - 1)) === C_W && e - q <= 16) q--;
    if (q > 0 && e - q >= 2 && e - q <= 16 && cls(s.charCodeAt(q - 1)) === C_S && !insideRem(q, e)) {
      const tok = s.slice(q, e);
      let e2;
      if (isGroup) {
        const tu = tok.toUpperCase();
        e2 = TOK.get(tu);
        if (e2 !== undefined && (e2.k === 'Q' || e2.k === 'W' || e2.k === 'R' || !caseOk(e2, tok, tu, false, true) ||
          (tu.length <= 3 && GROUP_TRAIL_BLOCK.has(tu)))) e2 = undefined;
      } else if (NAME_TRAIL.has(tok)) e2 = TOK.get(tok);
      else if (tok.length >= 4) {
        const l = NAME_TRAIL_WORD.get(tok.toUpperCase());
        if (l !== undefined && !NAME_TRAIL_PREV.test(s.slice(Math.max(0, q - 8), q))) e2 = { k: 'L', l, cc: '' };
      }
      if (e2 !== undefined) {
        sL.length = 0; sC.length = 0; sCC = ''; sA = sM = sR = false; sQ = sW = sN = 0;
        applyEntry(e2); commitSeg();
        let r0 = q; while (r0 > 0 && cls(s.charCodeAt(r0 - 1)) === C_S) r0--;
        addRem(r0, len); if (!how) how = 'tag';
      }
    }
  }

  // ---- 5. groups: bare leading code followed by a space ('UK Sports', 'FR Cinema')
  if (isGroup && !strongFound()) {
    let q = 0;
    while (q < len && cls(s.charCodeAt(q)) === C_W && q < 4) q++;
    if ((q === 2 || q === 3) && q < len && cls(s.charCodeAt(q)) === C_S) {
      const tok = s.slice(0, q);
      const e2 = TOK.get(tok);
      if (e2 !== undefined && (e2.k === 'L' || e2.k === 'C' || e2.k === 'A') && !GROUP_BARE_BLOCK.has(tok)) {
        sL.length = 0; sC.length = 0; sCC = ''; sA = sM = sR = false; sQ = sW = sN = 0;
        applyEntry(e2); commitSeg();
        let r1 = q; while (r1 < len && cls(s.charCodeAt(r1)) === C_S) r1++;
        addRem(0, r1); how = 'prefix';
      }
    }
  }

  // ---- 6. groups: language / country words anywhere ('ENGLISH MOVIES', 'Movies Arabic', 'Sports USA')
  if (isGroup && !strongFound()) looseScan(s);

  // ---- result
  let langs, kind;
  if (pL.length && (pL.length > countMarks() || pC.length)) {
    for (let k = 0; k < pL.length; k++) if (pL[k] === AR_MARK) pL[k] = 'ar';
    langs = intern(pL); kind = K_L;
  } else if (pA) { langs = LANG1.ar; kind = K_A; }
  else if (pC.length) { langs = intern(pC); kind = K_C; }
  else if (pM) { langs = MUL; kind = K_M; }
  else if (pR) { langs = EMPTY; kind = K_R; }
  else { langs = EMPTY; kind = K_NONE; }
  if (kind === K_NONE && remA.length === 0) {
    if (!isGroup) return null;
    return { langs: EMPTY, kind: K_NONE, cc: '', clean: s, how: '' };
  }
  return { langs, kind, cc: pCC, clean: buildClean(s), how };
}
// names without any separator/bracket: only 'Avatar ENG' / 'Al Jazeera English' style tags are possible
function trailingWordOnly(s, len) {
  let e = len;
  while (e > 0 && cls(s.charCodeAt(e - 1)) === C_S) e--;
  let q = e;
  while (q > 0 && cls(s.charCodeAt(q - 1)) === C_W && e - q <= 16) q--;
  if (q === 0 || e - q < 2 || e - q > 16 || cls(s.charCodeAt(q - 1)) !== C_S) return null;
  const tok = s.slice(q, e);
  let langs = null, kind = K_L;
  if (NAME_TRAIL.has(tok)) {
    const e2 = TOK.get(tok);
    if (e2 === undefined) return null;
    kind = e2.k === 'A' ? K_A : e2.k === 'M' ? K_M : e2.k === 'C' ? K_C : K_L;
    langs = e2.k === 'M' ? MUL : e2.l;
  } else if (tok.length >= 4) {
    const l = NAME_TRAIL_WORD.get(tok.toUpperCase());
    if (l !== undefined && !NAME_TRAIL_PREV.test(s.slice(Math.max(0, q - 8), q))) langs = l;
  }
  if (langs === null) return null;
  remA.length = 0; remB.length = 0;
  let r0 = q; while (r0 > 0 && cls(s.charCodeAt(r0 - 1)) === C_S) r0--;
  addRem(r0, len);
  return { langs, kind, cc: '', clean: buildClean(s), how: 'tag' };
}
function countMarks() { let n = 0; for (let k = 0; k < pL.length; k++) if (pL[k] === AR_MARK) n++; return n; }

const WORD_RE = /[\p{L}\p{N}'ʻ’]+/gu;
function looseScan(s) {
  WORD_RE.lastIndex = 0;
  let m, prev = '', prevIdx = -1, firstL = -1, lastEnd = 0, nWords = 0;
  const hitsL = [], hitsLpos = [];
  let hitC = null;
  const len = s.length;
  // word end of string (ignoring trailing spaces)
  let tailEnd = len; while (tailEnd > 0 && cls(s.charCodeAt(tailEnd - 1)) === C_S) tailEnd--;
  while ((m = WORD_RE.exec(s)) !== null) {
    nWords++;
    const w = m[0], up = w.toUpperCase();
    let e = prev ? LOOSE.get(prev + ' ' + up) : undefined;
    let st = m.index;
    if (e !== undefined) st = prevIdx;
    else {
      e = LOOSE.get(up);
      if (e === undefined && up.length >= 4) e = LOOSE.get(stripMarks(up));
      if (e !== undefined && up.length <= 3 && w !== up) e = undefined;
    }
    if (e !== undefined) {
      if (e.k === 'L' || e.k === 'A') {
        for (const l of e.l) { hitsL.push(l); }
        hitsLpos.push(st, m.index + w.length);
        if (firstL < 0) firstL = st;
      } else if (hitC === null) hitC = e;
    }
    prev = up; prevIdx = m.index; lastEnd = m.index + w.length;
  }
  if (hitsL.length) {
    for (const l of hitsL) pL.push(l);
    // strip a language word only when it sits at the very start or end of the string
    if (nWords > 1) {
      for (let k = 0; k < hitsLpos.length; k += 2) {
        const a = hitsLpos[k], b = hitsLpos[k + 1];
        if (a === 0 || /^\W*$/u.test(s.slice(0, a))) addRem(0, b);
        else if (b >= tailEnd) addRem(a, len);
      }
    }
  } else if (hitC !== null) {
    for (const l of hitC.l) pC.push(l);
    if (!pCC) pCC = hitC.cc;
  }
  void firstL; void lastEnd;
}

// ---------------------------------------------------------------------------
// Script detection
// ---------------------------------------------------------------------------
const S_ARAB = 1, S_CYR = 2, S_GREEK = 3, S_HEB = 4, S_THAI = 5, S_LAO = 6, S_DEVA = 7, S_BENG = 8, S_GURU = 9,
  S_GUJR = 10, S_ORYA = 11, S_TAML = 12, S_TELU = 13, S_KNDA = 14, S_MLYM = 15, S_SINH = 16, S_MYMR = 17,
  S_GEOR = 18, S_HANG = 19, S_ETHI = 20, S_KHMR = 21, S_MONG = 22, S_KANA = 23, S_HAN = 24, S_ARMN = 25,
  S_THAA = 26, S_TIBT = 27, S_VI = 28, S_N = 29;
const SCRIPT_LANG = [];
SCRIPT_LANG[S_GREEK] = 'el'; SCRIPT_LANG[S_HEB] = 'he'; SCRIPT_LANG[S_THAI] = 'th'; SCRIPT_LANG[S_LAO] = 'lo';
SCRIPT_LANG[S_DEVA] = 'hi'; SCRIPT_LANG[S_BENG] = 'bn'; SCRIPT_LANG[S_GURU] = 'pa'; SCRIPT_LANG[S_GUJR] = 'gu';
SCRIPT_LANG[S_ORYA] = 'or'; SCRIPT_LANG[S_TAML] = 'ta'; SCRIPT_LANG[S_TELU] = 'te'; SCRIPT_LANG[S_KNDA] = 'kn';
SCRIPT_LANG[S_MLYM] = 'ml'; SCRIPT_LANG[S_SINH] = 'si'; SCRIPT_LANG[S_MYMR] = 'my'; SCRIPT_LANG[S_GEOR] = 'ka';
SCRIPT_LANG[S_HANG] = 'ko'; SCRIPT_LANG[S_ETHI] = 'am'; SCRIPT_LANG[S_KHMR] = 'km'; SCRIPT_LANG[S_MONG] = 'mn';
SCRIPT_LANG[S_KANA] = 'ja'; SCRIPT_LANG[S_HAN] = 'zh'; SCRIPT_LANG[S_ARMN] = 'hy'; SCRIPT_LANG[S_THAA] = 'dv';
SCRIPT_LANG[S_TIBT] = 'bo'; SCRIPT_LANG[S_VI] = 'vi';

function scriptOf(c) {
  if (c < 0x0370) return 0;
  if (c < 0x0400) return S_GREEK;
  if (c < 0x0530) return S_CYR;
  if (c < 0x0590) return S_ARMN;
  if (c < 0x0600) return S_HEB;
  if (c < 0x0700) return S_ARAB;
  if (c < 0x0750) return 0;
  if (c < 0x0780) return S_ARAB;
  if (c < 0x07C0) return S_THAA;
  if (c < 0x08A0) return 0;
  if (c < 0x0900) return S_ARAB;
  if (c < 0x0980) return S_DEVA;
  if (c < 0x0A00) return S_BENG;
  if (c < 0x0A80) return S_GURU;
  if (c < 0x0B00) return S_GUJR;
  if (c < 0x0B80) return S_ORYA;
  if (c < 0x0C00) return S_TAML;
  if (c < 0x0C80) return S_TELU;
  if (c < 0x0D00) return S_KNDA;
  if (c < 0x0D80) return S_MLYM;
  if (c < 0x0E00) return S_SINH;
  if (c < 0x0E80) return S_THAI;
  if (c < 0x0F00) return S_LAO;
  if (c < 0x1000) return S_TIBT;
  if (c < 0x10A0) return S_MYMR;
  if (c < 0x1100) return S_GEOR;
  if (c < 0x1200) return S_HANG;
  if (c < 0x13A0) return S_ETHI;
  if (c < 0x1780) return 0;
  if (c < 0x1800) return S_KHMR;
  if (c < 0x18B0) return S_MONG;
  if (c < 0x1C90) return 0;
  if (c < 0x1CC0) return S_GEOR;
  if (c < 0x1EA0) return 0;
  if (c < 0x1EFA) return S_VI;
  if (c < 0x1F00) return 0;
  if (c < 0x2000) return S_GREEK;
  if (c < 0x3040) return 0;
  if (c < 0x3100) return S_KANA;
  if (c < 0x3130) return S_HAN; // bopomofo
  if (c < 0x3190) return S_HANG;
  if (c < 0x31F0) return 0;
  if (c < 0x3200) return S_KANA;
  if (c < 0x3400) return 0;
  if (c < 0x4DC0) return S_HAN;
  if (c < 0x4E00) return 0;
  if (c < 0xA000) return S_HAN;
  if (c < 0xAC00) return 0;
  if (c < 0xD7B0) return S_HANG;
  if (c >= 0xF900 && c < 0xFB00) return S_HAN;
  if (c >= 0xFB50 && c < 0xFE00) return S_ARAB;
  if (c >= 0xFE70 && c < 0xFEFF) return S_ARAB;
  if (c >= 0xFF66 && c < 0xFFA0) return S_KANA;
  return 0;
}

const SCNT = new Int32Array(S_N);
// sub-language flags
const F_FA = 1, F_UR = 2, F_KU = 4, F_PS = 8, F_UK = 16, F_BE = 32, F_KK = 64, F_SR = 128, F_MK = 256,
  F_TG = 512, F_RUONLY = 1024, F_BGCAND = 2048, F_AS = 4096;
// Latin-script distinctive letters
const LAT = new Map([
  [0x0259, 'az'], [0x018F, 'az'],
  [0x0219, 'ro'], [0x0218, 'ro'], [0x021B, 'ro'], [0x021A, 'ro'], [0x0163, 'ro'], [0x0162, 'ro'],
  [0x01A1, 'vi'], [0x01A0, 'vi'], [0x01B0, 'vi'], [0x01AF, 'vi'],
  [0x0131, 'tr'], [0x0130, 'tr'], [0x011F, 'tr'], [0x011E, 'tr'], [0x015F, 'tr'], [0x015E, 'tr'],
  [0x0142, 'pl'], [0x0141, 'pl'], [0x0105, 'pl'], [0x0104, 'pl'], [0x0119, 'pl'], [0x0118, 'pl'], [0x017C, 'pl'],
  [0x017B, 'pl'], [0x017A, 'pl'], [0x0179, 'pl'],
  [0x0159, 'cs'], [0x0158, 'cs'], [0x016F, 'cs'], [0x016E, 'cs'], [0x011B, 'cs'], [0x011A, 'cs'],
  [0x013E, 'sk'], [0x013D, 'sk'], [0x013A, 'sk'], [0x0139, 'sk'], [0x0155, 'sk'], [0x0154, 'sk'],
  [0x0151, 'hu'], [0x0150, 'hu'], [0x0171, 'hu'], [0x0170, 'hu'],
  [0x00F0, 'is'], [0x00D0, 'is'], [0x00FE, 'is'], [0x00DE, 'is'],
  [0x013C, 'lv'], [0x013B, 'lv'], [0x0137, 'lv'], [0x0136, 'lv'], [0x0146, 'lv'], [0x0145, 'lv'], [0x0123, 'lv'], [0x0122, 'lv'],
  [0x0117, 'lt'], [0x0116, 'lt'], [0x012F, 'lt'], [0x012E, 'lt'], [0x0173, 'lt'], [0x0172, 'lt'],
]);
const LAT_PRIO = ['az', 'vi', 'ro', 'tr', 'pl', 'cs', 'sk', 'hu', 'is', 'lv', 'lt'];

function scriptLang(s) {
  const len = s.length;
  let i = 0;
  // fast path: plain ASCII / Latin-1 without Icelandic letters
  for (; i < len; i++) { const c = s.charCodeAt(i); if (c >= 0xC0) break; }
  if (i >= len) return null;
  SCNT.fill(0);
  let flags = 0, latMask = 0, any = false;
  for (; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xC0) continue;
    if (c < 0x0370) {
      const l = LAT.get(c);
      if (l !== undefined) latMask |= 1 << LAT_PRIO.indexOf(l);
      continue;
    }
    const sc = scriptOf(c);
    if (sc === 0) continue;
    any = true;
    SCNT[sc]++;
    if (sc === S_ARAB) {
      if (c === 0x067C || c === 0x0689 || c === 0x0693 || c === 0x0696 || c === 0x069A || c === 0x0681 || c === 0x0685 || c === 0x06CD || c === 0x06D0) flags |= F_PS;
      else if (c === 0x06D5 || c === 0x06C6 || c === 0x06CE || c === 0x06B5 || c === 0x0695 || c === 0x06A4) flags |= F_KU;
      else if (c === 0x0679 || c === 0x0688 || c === 0x0691 || c === 0x06BA || c === 0x06D2 || c === 0x06BE || c === 0x06C1) flags |= F_UR;
      else if (c === 0x067E || c === 0x0686 || c === 0x0698 || c === 0x06AF || c === 0x06CC || c === 0x06A9) flags |= F_FA;
    } else if (sc === S_CYR) {
      if (c === 0x045E || c === 0x040E) flags |= F_BE;
      else if (c === 0x04E3 || c === 0x04E2 || c === 0x04EF || c === 0x04EE || c === 0x04B3 || c === 0x04B2 || c === 0x04B7 || c === 0x04B6) flags |= F_TG;
      else if (c === 0x04D9 || c === 0x04D8 || c === 0x04A3 || c === 0x04A2 || c === 0x04B1 || c === 0x04B0 || c === 0x04BB || c === 0x04BA || c === 0x0493 || c === 0x0492 || c === 0x049B || c === 0x049A) flags |= F_KK;
      else if (c === 0x0453 || c === 0x0403 || c === 0x045C || c === 0x040C || c === 0x0455 || c === 0x0405) flags |= F_MK;
      else if (c === 0x0452 || c === 0x0402 || c === 0x045B || c === 0x040B || c === 0x0458 || c === 0x0408 || c === 0x0459 || c === 0x0409 || c === 0x045A || c === 0x040A || c === 0x045F || c === 0x040F) flags |= F_SR;
      else if (c === 0x0456 || c === 0x0406 || c === 0x0457 || c === 0x0407 || c === 0x0454 || c === 0x0404 || c === 0x0491 || c === 0x0490) flags |= F_UK;
      else if (c === 0x044B || c === 0x042B || c === 0x044D || c === 0x042D || c === 0x0451 || c === 0x0401) flags |= F_RUONLY;
      else if ((c === 0x044A || c === 0x042A) && i + 1 < len) {
        const n = s.charCodeAt(i + 1);
        if (n >= 0x0400 && n < 0x0530) flags |= F_BGCAND;
      }
    } else if (sc === S_BENG) {
      if (c === 0x09F0 || c === 0x09F1) flags |= F_AS;
    }
  }
  if (!any) {
    if (latMask === 0) return null;
    for (let k = 0; k < LAT_PRIO.length; k++) if (latMask & (1 << k)) return LANG1[LAT_PRIO[k]];
    return null;
  }
  let best = 0, bestN = 0;
  for (let k = 1; k < S_N; k++) if (SCNT[k] > bestN) { bestN = SCNT[k]; best = k; }
  if (best === S_HAN && SCNT[S_KANA] > 0) best = S_KANA;
  if (best === S_ARAB) {
    if (flags & F_PS) return LANG1.ps;
    if ((flags & F_KU) || s.indexOf('\u06A9\u0648\u0631\u062F') >= 0) return LANG1.ku; // Sorani letters or 'کورد'
    if (flags & F_UR) return LANG1.ur;
    if (flags & F_FA) return LANG1.fa;
    return LANG1.ar;
  }
  if (best === S_CYR) {
    if (flags & F_BE) return LANG1.be;
    if (flags & F_TG) return LANG1.tg;
    if (flags & F_KK) return LANG1.kk;
    if (flags & F_MK) return LANG1.mk;
    if (flags & F_SR) return LANG1.sr;
    if (flags & F_UK) return LANG1.uk;
    if ((flags & F_BGCAND) && !(flags & F_RUONLY)) return LANG1.bg;
    return LANG1.ru;
  }
  if (best === S_BENG && (flags & F_AS)) return LANG1.as;
  return LANG1[SCRIPT_LANG[best]] || null;
}
function hasArabicScript(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x0600 && c < 0x0700) || (c >= 0xFB50 && c < 0xFEFF)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Context refinements
// ---------------------------------------------------------------------------
// India: regional channels under an 'IN' / 'INDIA' prefix
const INDIA_WORD = /\b(tamil|telugu|malayalam|kannada|bangla|bengali|marathi|punjabi|gujarati|odia|oriya|urdu|bhojpuri|english|assamese)\b/i;
const INDIA_WORD_MAP = { tamil: 'ta', telugu: 'te', malayalam: 'ml', kannada: 'kn', bangla: 'bn', bengali: 'bn',
  marathi: 'mr', punjabi: 'pa', gujarati: 'gu', odia: 'or', oriya: 'or', urdu: 'ur', bhojpuri: 'hi', english: 'en', assamese: 'as' };
const INDIA_CH = [
  ['ta', /\b(sun (?:tv|music|news|life)|ktv|vijay|kalaignar|jaya (?:tv|max|plus|movies)|polimer|puthiya thalaimurai|thanthi|raj (?:tv|digital|news)|adithya|chutti|makkal|captain tv|zee thirai|vendhar|isai ?aruvi|sirippoli|kalaignar)\b/i],
  ['te', /\b(gemini|e ?tv(?: (?:plus|abhiruchi|cinema|life|telangana|andhra))?|star maa|maa (?:tv|movies|music|gold)|zee cinemalu|ntv|tv5|sakshi|abn|10 ?tv|hmtv|v6|tv9 telugu)\b/i],
  ['ml', /\b(asianet|surya (?:tv|movies|music|comedy)|mazhavil|kairali|manorama|mathrubhumi|flowers|amrita|zee keralam|media ?one|24 news|reporter tv|jaihind|kappa|kochu tv)\b/i],
  ['kn', /\b(udaya|suvarna|public (?:tv|music|movies)|colors super|zee kannada|kasturi|tv9 kannada|chintu)\b/i],
  ['bn', /\b(jalsha|zee bangla|colors bangla|sony aath|abp ananda|ruposhi|sangeet bangla|aakash aath|enter ?10 bangla)\b/i],
  ['mr', /\b(star pravah|zee (?:marathi|yuva|talkies)|abp majha|saam tv|tv9 marathi|fakt marathi|sony marathi|colors marathi)\b/i],
  ['pa', /\b(ptc|chardikla|zee punjabi|jus punjabi|mh ?1|9x tashan)\b/i],
  ['gu', /\b(colors gujarati|gstv|sandesh news|zee 24 kalak|tv9 gujarati|vtv gujarati)\b/i],
  ['or', /\b(tarang|sidharth|zee sarthak|otv|kanak news)\b/i],
  ['en', /\b(times now|ndtv 24x7|wion|republic tv|mirror now|cnn[- ]news ?18|india today|star movies|sony pix|movies now|romedy now|zee cafe|star world|mn\+|et now)\b/i],
];
function refineIndia(name) {
  if (!name) return null;
  const m = INDIA_WORD.exec(name);
  if (m) return LANG1[INDIA_WORD_MAP[m[1].toLowerCase()]];
  for (let k = 0; k < INDIA_CH.length; k++) if (INDIA_CH[k][1].test(name)) return LANG1[INDIA_CH[k][0]];
  return null;
}
// AR = Arabic (default) or Argentina (Spanish) when the context is Latin American
const LATAM_RE = /\b(argentin\w*|latin\w*|latam|sudam[eé]rica|south america|hispan\w*|deportes|noticias|pel[ií]culas|infantil|novelas|telenovelas|f[uú]tbol)\b/i;
const ARG_CH_RE = /\b(telefe|el ?trece|tyc|tv p[uú]blica|am[eé]rica (?:tv|24)|canal (?:9|13|26)|c5n|todo noticias|tn|cr[oó]nica|a24|ln\+|garra tv|encuentro|pakapaka|net ?tv|quiero m[uú]sica|volver|ciudad magazine)\b/i;
function resolveAR(item, name, g, c) {
  if (hasArabicScript(name)) return LANG1.ar;
  const tc = item.tvgCountry;
  if (tc && /^\s*ar\b/i.test(String(tc))) return LANG1.es;
  const ti = item.tvgId;
  if (ti && /\.ar(?:@[^.]*)?$/i.test(String(ti))) return LANG1.es;
  if (g && g.kind !== K_A && g.kind <= K_C && g.kind > 0 && g.langs[0] === 'es') return LANG1.es;
  if (c && c.kind !== K_A && c.kind <= K_C && c.kind > 0 && c.langs[0] === 'es') return LANG1.es;
  if (item.tvgLanguage) { const t = tvgLang(item.tvgLanguage); if (t.langs[0] === 'es') return LANG1.es; }
  if ((item.group && LATAM_RE.test(item.group)) || (item.category && LATAM_RE.test(item.category))) return LANG1.es;
  if (ARG_CH_RE.test(name)) return LANG1.es;
  return LANG1.ar;
}

// ---------------------------------------------------------------------------
// Caches for repeating strings
// ---------------------------------------------------------------------------
const MAX_CACHE = 50000;
const GROUP_CACHE = new Map();
function groupInfo(s) {
  let r = GROUP_CACHE.get(s);
  if (r !== undefined) return r;
  r = parseText(s, true);
  r.scr = r.kind === K_NONE || r.kind === K_R || r.kind === K_M ? scriptLang(s) : null;
  if (GROUP_CACHE.size >= MAX_CACHE) GROUP_CACHE.clear();
  GROUP_CACHE.set(s, r);
  return r;
}
const NONE_INFO = Object.freeze({ langs: EMPTY, kind: K_NONE, cc: '' });
const TVGL_CACHE = new Map();
const TVGL_SPLIT = /[;,|/]+/;
function tvgLang(v) {
  const key = String(v);
  let r = TVGL_CACHE.get(key);
  if (r !== undefined) return r;
  const out = [];
  let mul = false;
  for (let part of key.split(TVGL_SPLIT)) {
    part = part.trim();
    if (!part) continue;
    const c = code(part, true);
    if (c === 'mul') { mul = true; continue; }
    if (c) { out.push(c); continue; }
    for (const w of part.split(/[\s\-_]+/)) { const c2 = code(w, true); if (c2 && c2 !== 'mul') out.push(c2); }
  }
  if (out.length) r = { langs: intern(out), kind: K_L, cc: '' };
  else if (mul) r = { langs: MUL, kind: K_M, cc: '' };
  else r = NONE_INFO;
  if (TVGL_CACHE.size >= MAX_CACHE) TVGL_CACHE.clear();
  TVGL_CACHE.set(key, r);
  return r;
}
const CC_INFO = Object.create(null);
function ccInfo(cc) {
  let r = CC_INFO[cc];
  if (r === undefined) {
    const l = COUNTRY[cc];
    r = l ? { langs: l, kind: K_C, cc: cc === 'UK' ? 'GB' : cc } : null;
    CC_INFO[cc] = r;
  }
  return r;
}
function tvgCountry(v) {
  let s = String(v).trim();
  if (!s) return null;
  const k = s.search(/[;,|/\s]/);
  if (k > 0) s = s.slice(0, k);
  s = s.toUpperCase();
  if (s.length === 3) { const e = TOK.get(s); if (e && e.k === 'C') return ccInfo(e.cc); return null; }
  if (s.length !== 2) { const e = TOK.get(s); return e && e.k === 'C' ? ccInfo(e.cc) : null; }
  return ccInfo(s);
}
const TVGID_RE = /\.([A-Za-z]{2})(?:@[^.@]*)?$/;
const TVGID_SKIP = new Set(['TV', 'ME', 'AM', 'AS', 'TO', 'SD', 'LA', 'CO', 'FM', 'IO', 'WS', 'CC', 'AI', 'NU', 'EU', 'GG', 'LY', 'SH']);
function tvgIdInfo(v) {
  const m = TVGID_RE.exec(String(v));
  if (m === null) return null;
  const cc = m[1].toUpperCase();
  if (TVGID_SKIP.has(cc)) return null;
  return ccInfo(cc);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/** Normalise a user supplied language ('English', 'eng', 'EN', 'Français', 'pt-BR') to an ISO 639-1 code or null. */
function code(x, tvgMode) {
  if (x == null) return null;
  let s = String(x).trim();
  if (!s) return null;
  const lo = s.toLowerCase();
  if (lo === 'mul' || lo === 'multi') return 'mul';
  if (tvgMode && s === 'UK') return 'en'; // tvg-language="UK" means British, lowercase 'uk' is Ukrainian
  if (lo.length === 2 && names[lo]) return lo;
  if (lo.length === 3 && ISO3[lo]) return ISO3[lo];
  const loc = /^([a-z]{2,3})[-_][a-z0-9]{2,8}$/i.exec(s);
  if (loc) return code(loc[1], tvgMode);
  const e = TOK.get(normKey(s)) || TOK.get(stripMarks(normKey(s)));
  if (e && (e.k === 'L' || e.k === 'A')) return e.l[0];
  if (e && e.k === 'M') return 'mul';
  if (!tvgMode && e && e.k === 'C') return e.l[0];
  return null;
}

function str(v) { return v == null ? '' : typeof v === 'string' ? v : String(v); }

/**
 * Detect the language(s) of an IPTV item.
 * Priority: name tag/prefix > group > category > tvg-language > tvg-country > tvg-id > script.
 */
function detect(item) {
  if (item == null) item = NONE_INFO;
  else if (typeof item === 'string') item = { name: item };
  const name = str(item.name), group = str(item.group), cat = str(item.category);
  const n = name ? parseText(name, false) : null;
  const g = group ? groupInfo(group) : null;
  let res = null, src = null, mul = false, mulSrc = null;
  if (n !== null) {
    if (n.kind >= K_L && n.kind <= K_A) { res = n; src = n.how; }
    else if (n.kind === K_M) { mul = true; mulSrc = n.how; }
  }
  if (g !== null && g.kind !== K_NONE) {
    if (res === null) {
      if (g.kind <= K_A) { res = g; src = 'group'; } else if (g.kind === K_M && !mul) { mul = true; mulSrc = 'group'; }
    } else if (res.kind === K_C && g.kind === K_L && g.cc !== '' && g.cc === res.cc) {
      res = g; src = 'group'; // name 'CA: TVA' in group 'CA FR | ...'
    }
  }
  let c = null;
  if (res === null && cat && cat !== group) {
    c = groupInfo(cat);
    if (c.kind >= K_L && c.kind <= K_A) { res = c; src = 'category'; } else if (c.kind === K_M && !mul) { mul = true; mulSrc = 'category'; }
  }
  if (res === null && item.tvgLanguage) {
    const t = tvgLang(item.tvgLanguage);
    if (t.kind === K_L) { res = t; src = 'tvg-language'; } else if (t.kind === K_M && !mul) { mul = true; mulSrc = 'tvg-language'; }
  }
  if (res === null && item.tvgCountry) { const t = tvgCountry(item.tvgCountry); if (t) { res = t; src = 'country'; } }
  if (res === null && item.tvgId) { const t = tvgIdInfo(item.tvgId); if (t) { res = t; src = 'tvg-id'; } }

  let langs;
  if (res !== null) {
    langs = res.langs;
    if (res.kind === K_A) langs = resolveAR(item, name, g, c);
    else if (res.kind === K_C && res.cc === 'IN') { const r = refineIndia(name); if (r) langs = r; }
  } else {
    let sl = name ? scriptLang(name) : null;
    if (sl === null && g !== null && g.scr) sl = g.scr;
    if (sl !== null) { langs = sl; src = 'script'; }
    else if (mul) { langs = MUL; src = mulSrc; }
    else langs = EMPTY;
  }
  if (mul && res !== null && langs.indexOf('mul') < 0) langs = intern(langs.concat('mul'));
  return {
    langs,
    source: langs.length ? src : null,
    clean: n !== null ? n.clean : name,
    cleanGroup: g !== null ? g.clean : group,
  };
}

/** English (or native) display list, sorted by English name. */
let LIST = null;
function list() {
  if (LIST === null) {
    LIST = Object.keys(names).map(c => Object.freeze({ code: c, name: names[c], native: native[c] }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    Object.freeze(LIST);
  }
  return LIST.slice();
}

/** Country (ISO 3166 alpha-2, also 'UK') -> language code, or array (primary first) for multilingual ones, or null. */
function fromCountry(cc) {
  if (cc == null) return null;
  let k = String(cc).trim().toUpperCase();
  if (k.length === 3) { const e = TOK.get(k); if (e && e.k === 'C') k = e.cc; }
  const l = COUNTRY[k];
  if (!l) return null;
  return l.length === 1 ? l[0] : l;
}

// allowed-set normalisation (cached)
const ALLOW_WEAK = new WeakMap();
const ALLOW_STR = new Map();
const ALL = new Set(['*']);
function allowSet(allowed) {
  if (allowed instanceof Set) {
    let r = ALLOW_WEAK.get(allowed);
    if (r === undefined) { r = normAllowed(Array.from(allowed)); ALLOW_WEAK.set(allowed, r); }
    return r;
  }
  if (Array.isArray(allowed)) {
    let r = ALLOW_WEAK.get(allowed);
    if (r === undefined) { r = normAllowed(allowed); ALLOW_WEAK.set(allowed, r); }
    return r;
  }
  const s = String(allowed);
  let r = ALLOW_STR.get(s);
  if (r === undefined) { r = normAllowed(s.split(/[\s,;|]+/)); if (ALLOW_STR.size > 1000) ALLOW_STR.clear(); ALLOW_STR.set(s, r); }
  return r;
}
function normAllowed(arr) {
  const out = new Set();
  for (const a of arr) {
    if (a === '*' || a === 'all') return ALL;
    const c = code(a);
    if (c) out.add(c);
  }
  return out;
}

/**
 * Is an item with `langs` visible for the `allowed` languages?
 *   allowed: array / Set / 'en,fr' string of codes or names; null/empty/'*' = no filter (everything visible)
 *   opts.unknown (default true): show items whose language is unknown (langs = [])
 *   opts.multi (default = opts.unknown): show items tagged only as multi-language ('mul')
 * An item matches when any of its languages is allowed. 'mul' in allowed shows every multi item.
 */
function matches(langs, allowed, opts) {
  if (allowed == null) return true;
  const set = allowSet(allowed);
  if (set === ALL || set.size === 0) return true;
  const unknown = !(opts && opts.unknown === false);
  if (!langs || langs.length === 0) return unknown;
  let onlyMul = true, hasMul = false;
  for (let i = 0; i < langs.length; i++) {
    const l = langs[i];
    if (l === 'mul') { hasMul = true; continue; }
    onlyMul = false;
    if (set.has(l)) return true;
  }
  if (hasMul && set.has('mul')) return true;
  if (onlyMul) return opts && typeof opts.multi === 'boolean' ? opts.multi : unknown;
  return false;
}

function clearCache() { GROUP_CACHE.clear(); TVGL_CACHE.clear(); ALLOW_STR.clear(); }

module.exports = {
  detect,
  names,
  native,
  list,
  fromCountry,
  matches,
  code: (x) => code(x, false),
  clearCache,
};
