'use strict';
/**
 * Smarter categories (Admin → Categories): instead of each provider's own categories ("VOD - NEW ADDED", "|EN| ✪
 * COMEDY", "Local - NBC"), every channel, film and series is put in categories worked out from what it is:
 *   • networks and streaming services — Netflix, Disney+, Hulu, ABC, ESPN… (channel names; providers' categories and
 *     "NF -" style labels; TMDB's streaming services in the household's country, TV networks)
 *   • genres — Comedy, Horror, Sports, News, Kids… (TMDB's genres, providers' categories, what the guide says is on)
 *   • sports — Soccer, Football, Basketball, Fighting, Motorsport…
 *   • holidays — Christmas, Halloween, Thanksgiving… (TMDB keywords, titles, providers' categories, plots)
 *   • themes and studios — Superheroes, Zombies, True stories; Marvel, Pixar, Studio Ghibli… (TMDB keywords, studios)
 *   • countries, events and pay-per-view, and the admin's own categories
 * A title can be in several. Each item gets them as `sc` (ids); devices group by those when the switch is on.
 * Also here: what's trending and popular worldwide (TMDB's charts, not what the household watches), matched to the
 * catalogue.
 */

const KINDS = [
  { k: 'top', n: 'Popular worldwide', types: ['movie', 'show'] },
  { k: 'net', n: 'Networks & streaming' },
  { k: 'genre', n: 'Genres' },
  { k: 'sport', n: 'Sports' },
  { k: 'hol', n: 'Holidays' },
  { k: 'theme', n: 'Themes', types: ['movie', 'show'] },
  { k: 'studio', n: 'Studios & franchises', types: ['movie', 'show'] },
  { k: 'country', n: 'Countries', types: ['live', 'radio'] },
  { k: 'event', n: 'Events', types: ['live'] },
  { k: 'own', n: 'Your categories' },
];
const KIND_IDS = KINDS.map((x) => x.k);

/** Text as the phrase tables are written: lower case, plain letters, "+" → " plus", single spaces. */
function plain(s) {
  return ' ' + String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\+/g, ' plus ').replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

/**
 * A table of phrases → category ids, as one expression. rows: [[id, label, [phrases]], …]. Phrases are matched as
 * whole words; the longest one at a place wins ("fox sports" before "fox").
 */
class Phrases {
  constructor(rows) {
    this.of = new Map();
    for (const [id, , phrases] of rows) for (const p of phrases) { const q = plain(p).trim(); if (!q) continue; const l = this.of.get(q) || []; if (!l.includes(id)) l.push(id); this.of.set(q, l); }
    const list = [...this.of.keys()].sort((a, b) => b.length - a.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.re = list.length ? new RegExp(` (${list.join('|')})(?= )`, 'g') : null;
  }
  /** Ids found in already plain() text, added to out (a Set). */
  find(text, out) {
    if (!this.re || !text) return out;
    this.re.lastIndex = 0;
    let m;
    while ((m = this.re.exec(text))) {
      for (const id of this.of.get(m[1]) || []) out.add(id);
      this.re.lastIndex = m.index + m[0].length; // (the next one starts at the space after it)
    }
    return out;
  }
}

// ---------------------------------------------------------------- networks and streaming services
// [id, label, phrases in channel names and providers' categories, phrases only for films and series (categories,
//  TMDB's services and networks)]. Brands with no channels of their own (Netflix…) still have "Netflix 24/7" ones.
const NETS = [
  ['netflix', 'Netflix', ['netflix', 'nflx'], ['netflix basic with ads']],
  ['disneyplus', 'Disney+', ['disney plus', 'disneyplus', 'dsnp'], ['disney', 'disney plus kids']],
  ['disney', 'Disney Channel', ['disney channel', 'disney junior', 'disney jr', 'disney xd', 'disney'], ['disney xd', 'disney junior', 'disney channel']],
  ['hulu', 'Hulu', ['hulu'], []],
  ['prime', 'Prime Video', ['prime video', 'amazon prime', 'amazon', 'prime plus'], ['prime', 'amazon prime video', 'amazon video original']],
  ['max', 'Max & HBO', ['hbo', 'hbo max', 'hbomax', 'hbo family', 'hbo signature', 'hbo comedy', 'hbo zone', 'hbo latino', 'max originals'], ['max', 'hbo max', 'max amazon channel']],
  ['apple', 'Apple TV+', ['apple tv plus', 'apple tv', 'apple plus', 'atv plus'], ['apple', 'apple tv plus']],
  ['paramount', 'Paramount+', ['paramount plus', 'paramount network', 'paramount', 'cbs all access'], ['paramount plus with showtime', 'paramount plus premium', 'paramount plus essential']],
  ['peacock', 'Peacock', ['peacock'], ['peacock premium', 'peacock premium plus']],
  ['showtime', 'Showtime', ['showtime', 'sho'], []],
  ['starz', 'Starz', ['starz', 'starz encore', 'encore'], []],
  ['cinemax', 'Cinemax', ['cinemax', 'max prime', 'moremax', 'actionmax', 'thrillermax', 'moviemax'], []],
  ['mgm', 'MGM+', ['mgm plus', 'mgm', 'epix'], []],
  ['amc', 'AMC', ['amc', 'amc plus', 'sundance tv', 'ifc', 'we tv', 'bbc america'], ['amc plus']],
  ['hallmark', 'Hallmark', ['hallmark', 'hallmark movies', 'hallmark mystery', 'hallmark family'], ['hallmark movies now', 'hallmark plus']],
  ['bet', 'BET', ['bet', 'bet plus', 'bet her', 'bet jams', 'allblk', 'all blk'], []],
  ['crunchyroll', 'Crunchyroll', ['crunchyroll', 'funimation'], []],
  ['discovery', 'Discovery', ['discovery', 'discovery plus', 'tlc', 'investigation discovery', 'id discovery', 'animal planet', 'science channel', 'own', 'oprah'], ['discovery plus']],
  ['hgtv', 'HGTV & Food Network', ['hgtv', 'food network', 'cooking channel', 'travel channel', 'magnolia'], []],
  ['natgeo', 'National Geographic', ['nat geo', 'natgeo', 'national geographic', 'nat geo wild'], []],
  ['history', 'History, A&E & Lifetime', ['history', 'history channel', 'h2', 'a and e', 'aande', 'lifetime', 'lmn', 'fyi'], []],
  ['abc', 'ABC', ['abc', 'abc news', 'abc family'], []],
  ['cbs', 'CBS', ['cbs', 'cbs news'], []],
  ['nbc', 'NBC', ['nbc', 'nbc news'], []],
  ['fox', 'FOX', ['fox'], []],
  ['pbs', 'PBS', ['pbs', 'pbs kids'], []],
  ['cw', 'The CW', ['cw', 'the cw'], []],
  ['fx', 'FX', ['fx', 'fxx', 'fxm', 'fx movie'], []],
  ['usa', 'USA, Syfy & Bravo', ['usa network', 'syfy', 'bravo', 'oxygen', 'e entertainment', 'e network'], []],
  ['tnt', 'TNT, TBS & truTV', ['tnt', 'tbs', 'trutv', 'tru tv'], []],
  ['comedycentral', 'Comedy Central', ['comedy central'], []],
  ['mtv', 'MTV, VH1 & CMT', ['mtv', 'vh1', 'cmt', 'logo tv'], []],
  ['nick', 'Nickelodeon', ['nick', 'nickelodeon', 'nick jr', 'nick junior', 'nicktoons', 'teennick', 'nick at nite'], ['nick jr']],
  ['cartoon', 'Cartoon Network', ['cartoon network', 'cartoon netwrk', 'cartoonito', 'boomerang', 'adult swim'], []],
  ['espn', 'ESPN', ['espn', 'espn2', 'espnu', 'espn plus', 'espnews', 'espn deportes', 'espn play', 'sec network', 'acc network', 'longhorn network'], []],
  ['foxsports', 'FOX Sports', ['fox sports', 'fs1', 'fs2', 'fox soccer', 'fox soccer plus', 'big ten network', 'btn', 'btn plus', 'b1g plus', 'fox deportes'], []],
  ['nbcsports', 'NBC Sports', ['nbc sports', 'nbcsn', 'golf channel', 'nbc sports network'], []],
  ['cbssports', 'CBS Sports', ['cbs sports', 'cbs sports network', 'cbssn'], []],
  ['dazn', 'DAZN', ['dazn'], []],
  ['bein', 'beIN Sports', ['bein', 'bein sports'], []],
  ['flo', 'FloSports', ['flo', 'flosports', 'flsp', 'flo network', 'flo college'], []],
  ['sky', 'Sky', ['sky', 'sky sports', 'sky cinema', 'sky news', 'sky atlantic', 'sky one', 'sky max', 'sky showcase', 'sky witness', 'sky comedy', 'sky arts', 'sky crime', 'sky history', 'sky documentaries', 'sky nature', 'sky kids', 'sky racing', 'sky sport'], ['sky go', 'now tv']],
  ['bbc', 'BBC', ['bbc', 'bbc one', 'bbc two', 'bbc three', 'bbc four', 'bbc news', 'cbbc', 'cbeebies', 'bbc iplayer', 'bbci'], ['bbc iplayer']],
  ['itv', 'ITV', ['itv', 'itvx', 'itv2', 'itv3', 'itv4', 'itvbe'], []],
  ['ch4', 'Channel 4 & 5', ['channel 4', 'e4', 'more4', 'film4', 'channel 5', '5star', '5usa', 'my5', 'all 4'], []],
  ['tsn', 'TSN', ['tsn', 'tsn plus'], []],
  ['sportsnet', 'Sportsnet', ['sportsnet', 'sn plus', 'sportsnet plus'], []],
  ['cbc', 'CBC', ['cbc', 'cbc news', 'cbc gem'], []],
  ['ctv', 'CTV', ['ctv', 'ctv drama', 'ctv comedy', 'ctv sci fi'], []],
  ['crave', 'Crave', ['crave'], []],
  ['cnn', 'CNN', ['cnn', 'hln', 'cnn international'], []],
  ['foxnews', 'Fox News', ['fox news', 'fox business', 'fox weather'], []],
  ['msnbc', 'MSNBC & CNBC', ['msnbc', 'ms now', 'cnbc'], []],
  ['telemundo', 'Telemundo', ['telemundo', 'universo'], []],
  ['univision', 'Univision', ['univision', 'unimas', 'galavision', 'vix', 'tudn'], []],
  ['canal', 'Canal+', ['canal plus', 'canal plus sport', 'canalplus'], []],
  ['viaplay', 'Viaplay', ['viaplay'], []],
  ['stan', 'Stan', ['stan'], []],
  ['shudder', 'Shudder', ['shudder'], []],
  ['tubi', 'Tubi', ['tubi', 'tubi tv'], []],
  ['pluto', 'Pluto TV', ['pluto', 'pluto tv'], []],
  ['roku', 'The Roku Channel', ['roku channel', 'the roku channel'], []],
  ['criterion', 'Criterion & MUBI', ['criterion', 'criterion channel', 'mubi'], []],
  ['acorn', 'Acorn TV & BritBox', ['acorn tv', 'britbox'], []],
  ['astro', 'Astro', ['astro'], []],
];
// The TMDB names that would otherwise be read wrong ("Max" the service vs "Mad Max"): films and series only take
// networks from their categories, services, labels and TMDB's lists — never from the title.
const NET_LIVE = new Phrases(NETS.map(([id, n, a]) => [id, n, a]));
// (Films and series: "Disney" is Disney+, not the Disney Channel — that one only by its own name.)
const NET_VOD = new Phrases(NETS.map(([id, n, a, b]) => [id, n, id === 'disney' ? b : a.concat(b)]));
// Short ones that mean something else in a title or a category of films ("SHO", "OWN", "Encore" in "Encore
// Performances"…): from TMDB's lists and channel names only.
const VOD_GROUP_SKIP = new Set(['sho', 'own', 'oprah', 'encore', 'astro', 'history', 'flo', 'e network', 'apple', 'max', 'prime', 'amazon']);
const NET_VOD_GROUP = new Phrases(NETS.map(([id, n, a, b]) => [id, n, (id === 'disney' ? b : a.concat(b)).filter((p) => !VOD_GROUP_SKIP.has(p))]).concat([
  ['max', 'Max & HBO', ['hbo max', 'max originals', 'max series', 'max movies']], ['prime', 'Prime Video', ['amazon prime', 'prime video', 'amazon prime plus', 'prime plus']],
  ['apple', 'Apple TV+', ['apple tv plus', 'apple plus', 'apple tv']],
]));
// Providers' "NF - Title" labels (lib/catalog.js: svc).
const SVC = { Netflix: 'netflix', 'Disney+': 'disneyplus', 'Apple TV+': 'apple', 'Prime Video': 'prime', HBO: 'max', Max: 'max', Hulu: 'hulu', Peacock: 'peacock', 'Paramount+': 'paramount' };

// ---------------------------------------------------------------- genres
const GENRES = [
  ['sports', 'Sports'], ['news', 'News'], ['kids', 'Kids & family'], ['movies', 'Movies'], ['entertainment', 'Entertainment'],
  ['comedy', 'Comedy'], ['drama', 'Drama'], ['crime', 'Crime'], ['thriller', 'Thriller'], ['horror', 'Horror'], ['action', 'Action'],
  ['adventure', 'Adventure'], ['scifi', 'Science fiction'], ['fantasy', 'Fantasy'], ['mystery', 'Mystery'], ['romance', 'Romance'],
  ['animation', 'Animation'], ['anime', 'Anime'], ['documentary', 'Documentary'], ['reality', 'Reality'], ['music', 'Music & concerts'],
  ['standup', 'Stand-up comedy'], ['history', 'History'], ['war', 'War'], ['western', 'Western'], ['lifestyle', 'Food, home & travel'],
  ['faith', 'Faith'], ['talk', 'Talk shows'], ['classic', 'Classics'], ['local', 'Local channels'], ['247', '24/7 channels'], ['shopping', 'Shopping'],
  ['weather', 'Weather'], ['uhd', '4K & UHD'], ['adult', 'Adults only'], ['other', 'Everything else'],
];
// TMDB's (and providers' tidied) genre names → ids.
const GENRE_OF = {
  Action: 'action', Adventure: 'adventure', Animation: 'animation', Anime: 'anime', Comedy: 'comedy', Crime: 'crime', Documentary: 'documentary',
  Drama: 'drama', Family: 'kids', Kids: 'kids', Fantasy: 'fantasy', History: 'history', Horror: 'horror', Music: 'music', Mystery: 'mystery',
  Romance: 'romance', 'Science Fiction': 'scifi', Thriller: 'thriller', War: 'war', Western: 'western', Reality: 'reality', News: 'news',
  Talk: 'talk', 'Talk Show': 'talk', Sport: 'sports', 'Action & Adventure': 'action', 'War & Politics': 'war', 'Sci-Fi & Fantasy': 'scifi',
  Biography: 'history', Soap: 'drama', Politics: 'news',
};
// In channel names, providers' categories, and what the guide says a channel shows.
const GENRE_WORDS = new Phrases([
  ['sports', '', ['sport', 'sports', 'espn', 'sportsnet', 'tsn', 'dazn', 'bein', 'nfl', 'nba', 'nhl', 'mlb', 'mls', 'ncaa', 'ncaaf', 'ncaab', 'ufc', 'wwe', 'aew', 'boxing', 'golf', 'tennis', 'soccer', 'football', 'futbol', 'premier league', 'epl', 'efl', 'uefa', 'la liga', 'laliga', 'serie a', 'bundesliga', 'ligue 1', 'f1', 'formula 1', 'nascar', 'motogp', 'indycar', 'racing', 'cricket', 'rugby', 'darts', 'snooker', 'hockey', 'baseball', 'basketball', 'olympic', 'olympics', 'wrestling', 'fight', 'fighting', 'mma', 'sec network', 'acc network', 'btn', 'big ten', 'flosports', 'flo', 'flsp', 'victory plus', 'fite', 'triller', 'matchroom', 'setanta', 'eurosport', 'redzone', 'sunday ticket', 'milb', 'nfhs', 'cycling', 'motorsport', 'motorsports', 'replay', 'replays', 'match', 'matches', 'league', 'cup']],
  ['news', '', ['news', 'cnn', 'msnbc', 'cnbc', 'bloomberg', 'c span', 'cspan', 'newsmax', 'al jazeera', 'euronews', 'france 24', 'dw', 'newsnation', 'cheddar', 'cbc news', 'sky news', 'bbc news', 'abc news', 'cbs news', 'nbc news', 'fox news', 'fox business', 'cbsn', 'arise news', 'news 12', 'rt']],
  ['weather', '', ['weather', 'weather channel', 'weathernation', 'accuweather', 'fox weather']],
  ['kids', '', ['kids', 'kid', 'children', 'childrens', 'cartoon', 'cartoons', 'nick', 'nickelodeon', 'nick jr', 'nicktoons', 'teennick', 'disney junior', 'disney jr', 'disney xd', 'disney channel', 'boomerang', 'cartoonito', 'pbs kids', 'baby', 'babytv', 'cbeebies', 'cbbc', 'toons', 'kids and family', 'kids family', 'family kids', 'chu chu', 'cocomelon', 'junior', 'universal kids', 'duck tv']],
  ['movies', '', ['movies', 'movie', 'cinema', 'cine', 'cinemax', 'film', 'films', 'hbo', 'showtime', 'starz', 'encore', 'tcm', 'turner classic', 'fxm', 'flix', 'movieplex', 'indieplex', 'retroplex', 'box office', 'epix', 'mgm', 'sky cinema', 'film4', 'cinemania', 'lifetime movies', 'lmn', 'hallmark movies', 'movies and series', 'movie channels']],
  ['music', '', ['music', 'mtv', 'vh1', 'cmt', 'bet jams', 'revolt', 'radio', 'hits', 'concert', 'concerts', 'festival', 'now 70s', 'now 80s', 'now 90s', 'karaoke', 'jazz', 'country music', 'stingray', 'trace', 'mezzo', 'clubbing', 'dance']],
  ['documentary', '', ['documentary', 'documentaries', 'docu', 'docs', 'discovery', 'history', 'h2', 'nat geo', 'natgeo', 'national geographic', 'science', 'animal planet', 'smithsonian', 'curiosity', 'learning', 'nature', 'bbc earth', 'love nature', 'odisea', 'documentaire']],
  ['lifestyle', '', ['food', 'cooking', 'hgtv', 'travel', 'home and garden', 'diy', 'tlc', 'lifestyle', 'fashion', 'outdoor', 'outside tv', 'magnolia', 'tastemade', 'garden', 'fishing', 'hunting']],
  ['reality', '', ['reality', 'reality shows', 'bravo', 'love island', 'we tv', 'oxygen', 'real housewives', 'big brother', 'survivor', 'tele realite', 'e entertainment']],
  ['comedy', '', ['comedy', 'comedies', 'sitcom', 'sitcoms', 'laugh', 'laughs', 'funny', 'comedy central', 'tbs', 'humor']],
  ['standup', '', ['stand up', 'stand up comedy', 'standup']],
  ['drama', '', ['drama', 'dramas', 'soap', 'soaps', 'novela', 'novelas', 'telenovela', 'telenovelas', 'dramabite']],
  ['crime', '', ['crime', 'true crime', 'investigation', 'investigation discovery', 'court tv', 'cops', 'gangster', 'mafia', 'detective', 'oxygen true crime']],
  ['horror', '', ['horror', 'scary', 'fright', 'chiller', 'shudder', 'screambox', 'terror', 'halloween 24 7', 'creepy']],
  ['action', '', ['action', 'action and adventure', 'actionmax']],
  ['scifi', '', ['sci fi', 'scifi', 'syfy', 'science fiction', 'science fiction fantasy', 'fantastique']],
  ['anime', '', ['anime', 'animes', 'crunchyroll', 'funimation']],
  ['animation', '', ['animation', 'animations', 'animated']],
  ['romance', '', ['romance', 'romantic']],
  ['faith', '', ['faith', 'religion', 'religious', 'christian', 'church', 'tbn', 'god', 'gospel', 'catholic', 'ewtn', 'daystar', 'islam', 'islamic', 'quran', 'bible', 'biblical', 'jesus', 'hillsong']],
  ['talk', '', ['talk', 'talk show', 'talk shows', 'late night', 'podcast', 'podcasts']],
  ['shopping', '', ['qvc', 'hsn', 'shop', 'shopping', 'jewelry', 'shop lc', 'evine']],
  ['classic', '', ['classic', 'classics', 'retro', 'oldies', 'nostalgia', 'metv', 'me tv', 'antenna tv', 'cozi', 'cozi tv', 'grit', 'decades', 'tv land', 'buzzr', 'start tv', 'heroes and icons', 'catchy comedy', 'classic movies', 'classic series']],
  ['entertainment', '', ['entertainment', 'general', 'variety', 'varietes', 'tv shows', 'shows', 'series', 'tvshows', 'usa network', 'tnt', 'fx', 'amc', 'e', 'abc', 'cbs', 'nbc', 'fox', 'cw']],
  ['war', '', ['war', 'military', 'action war']],
  ['western', '', ['western', 'westerns']],
  ['history', '', ['history', 'historical', 'biography']],
  ['uhd', '', ['4k', 'uhd', '2160p', 'ultra hd', '4k uhd', 'dolby vision']],
]);
// What a guide's programme categories say (XMLTV <category>): the main ones.
const EPG_GENRE = new Phrases([
  ['sports', '', ['sports', 'sport', 'football', 'soccer', 'basketball', 'baseball', 'hockey', 'golf', 'tennis', 'boxing', 'motorsport', 'racing', 'sports event', 'sports talk']],
  ['news', '', ['news', 'newsmagazine', 'current affairs', 'public affairs', 'weather']],
  ['kids', '', ['children', 'childrens', 'kids', 'animated', 'animation', 'family', 'educational', 'cartoon']],
  ['movies', '', ['movie', 'movies', 'film', 'feature film']],
  ['documentary', '', ['documentary', 'nature', 'science', 'history', 'travel', 'docuseries']],
  ['music', '', ['music', 'concert', 'music video']],
  ['reality', '', ['reality', 'game show', 'competition reality']],
  ['lifestyle', '', ['cooking', 'home improvement', 'house garden', 'fashion', 'consumer', 'outdoors', 'fishing', 'hunting', 'auto']],
  ['faith', '', ['religious', 'religion']],
  ['shopping', '', ['shopping', 'infomercial', 'paid programming']],
  ['talk', '', ['talk', 'interview']],
  ['comedy', '', ['comedy', 'sitcom']],
  ['drama', '', ['drama', 'soap', 'crime drama']],
  ['horror', '', ['horror']],
]);
// Providers' categories of films and series ("|EN| ✪ COMEDY", "Stand-Up Comedy", "Gangster & Mafia").
const GENRE_VOD_GROUP = new Phrases([
  ['comedy', '', ['comedy', 'comedies', 'comedie', 'sitcom']], ['standup', '', ['stand up', 'standup', 'stand up comedy']], ['horror', '', ['horror', 'horreur', 'terror']],
  ['thriller', '', ['thriller', 'thrillers', 'suspense']], ['documentary', '', ['documentary', 'documentaries', 'documentaire', 'documentaires', 'docu']],
  ['anime', '', ['anime', 'animes']], ['animation', '', ['animation', 'animations', 'cartoon', 'cartoons', 'classic cartoons']],
  ['kids', '', ['kids', 'children', 'family', 'enfants', 'kinder', 'family children', 'children family']], ['romance', '', ['romance', 'romantic']],
  ['action', '', ['action', 'action war', 'action thriller']], ['adventure', '', ['adventure']], ['war', '', ['war']], ['western', '', ['western', 'westerns']],
  ['scifi', '', ['sci fi', 'science fiction', 'science fiction fantasy', 'science fiction fantastic', 'fantastique']], ['fantasy', '', ['fantasy']],
  ['crime', '', ['crime', 'gangster', 'mafia', 'gangster and mafia', 'drama crime', 'crime mystery']], ['mystery', '', ['mystery']],
  ['drama', '', ['drama', 'dramas', 'drame', 'drama romance', 'drama comedy']], ['reality', '', ['reality', 'reality shows', 'tele realite']],
  ['music', '', ['music', 'concert', 'concerts', 'festival', 'broadway', 'musical', 'music concert festival']],
  ['sports', '', ['sport', 'sports', 'ufc', 'wwe', 'boxing', 'nba', 'nfl', 'nhl', 'mlb', 'replay', 'f1', 'worldcup', 'world cup', 'wc', 'olympics', 'sport tv shows']],
  ['faith', '', ['biblical', 'bible', 'christian', 'faith']], ['classic', '', ['classic', 'classics', 'classic movies', 'classic series', 'classic movies collection']],
  ['history', '', ['history', 'historical', 'biography']], ['uhd', '', ['4k', 'uhd', '4k movies', '4k uhd', 'dolby vision', 'bluray dolby vision', 'series 4k']],
  ['talk', '', ['talk show', 'talk shows']],
]);

// TMDB's keywords of a film or series → genres. TMDB's list of series genres has no Horror, Thriller, Romance,
// History, Music, Sport or Faith (its films' list has most of them), so without these a series could only be in them
// through a provider's category name: two horror series in a catalogue of 21,000. [genre, keyword test, not]
const GENRE_KW = [
  ['horror', /horror|^zombies?$|zombie apocalypse|^slasher|splatter|^gore$|haunted house|^haunting$|demonic possession|^possession$|exorcis|lovecraftian|creature feature/],
  ['thriller', /thriller|^suspense(ful)?$|^conspiracy$|serial killer/],
  ['romance', /romance|romantic|love triangle|love polygon|first love|forbidden love|unrequited love|love affair|enemies to lovers|friends to lovers|boys' love|girls' love|falling in love|teenage love|new love|^love$/, /bromance|loss of loved one/],
  ['history', /historical|^history$|period drama|period piece|(edo|meiji|taisho|heian|sengoku|joseon|goryeo) (period|era|dynasty)|victorian era|regency era|^medieval|biograph/],
  ['war', /^war$|world war|vietnam war|civil war|cold war|korean war|gulf war|iraq war|war in afghanistan|^military$/],
  ['music', /^music|musical|musician|^concert|music festival|^rock band$|^band$|^singer$|^rapper$/],
  ['sports', /^sports?$|sports documentary|combat sports|high school sports|sports entertainment|^(football|american football|basketball|baseball|boxing|soccer|wrestling|ice hockey|tennis|golf|motorsport|formula 1|racing)$/],
  ['standup', /stand-?up comedy|^stand-?up$/],
  ['lifestyle', /cooking|baking|culinary|^food$|food competition|^travel$|travel (show|documentary|series|guide)|home (renovation|improvement|makeover)|interior design|gardening/],
  ['faith', /christian|christianity|^bible|biblical|^faith$|jesus christ/],
  ['talk', /talk show|late night (show|talk)|^talk$/],
  ['reality', /game show|reality (tv|show|competition)|dating show|competition show|cooking competition/],
];
// A series' description, for the same genres when TMDB gives it no keywords (only clear phrases: "the horrors of
// war" isn't horror; and only for series — films have TMDB's own genres for these).
const GENRE_PLOT = [
  ['horror', /\b(horror (series|anthology|comedy|drama|story|stories|tales|show)|supernatural horror|zombie apocalypse|zombies|slasher|haunted house)\b/],
  ['thriller', /\b(psychological thriller|thriller series|political thriller|crime thriller|spy thriller)\b/],
  ['romance', /\b(romantic (comedy|drama|series)|rom ?com|love story)\b/],
];

// ---------------------------------------------------------------- sports
const SPORTS = [
  ['football', 'Football (NFL & college)', ['nfl', 'ncaaf', 'cfb', 'college football', 'american football', 'nfl network', 'redzone', 'red zone', 'sunday ticket', 'super bowl', 'xfl', 'ufl', 'cfl', 'nfl teams', 'nfl package', 'nfl replay']],
  ['soccer', 'Soccer', ['soccer', 'futbol', 'premier league', 'premiere league', 'epl', 'efl', 'mls', 'uefa', 'champions league', 'europa league', 'la liga', 'laliga', 'serie a', 'bundesliga', 'ligue 1', 'liga mx', 'fa cup', 'concacaf', 'fifa', 'world cup', 'worldcup', 'copa', 'eredivisie', 'national league', 'spfl', 'efl cup', 'carabao', 'nwsl', 'wc 2026']],
  ['basketball', 'Basketball', ['nba', 'wnba', 'ncaab', 'basketball', 'euroleague', 'nba tv', 'march madness', 'nba replay', 'big3']],
  ['hockey', 'Hockey', ['nhl', 'hockey', 'ahl', 'chl', 'ohl', 'whl', 'khl', 'hockey league', 'nhl replay']],
  ['baseball', 'Baseball', ['mlb', 'milb', 'baseball', 'mlb network', 'mlb replay', 'world series']],
  ['fighting', 'Fighting & wrestling', ['ufc', 'boxing', 'wwe', 'aew', 'mma', 'bellator', 'pfl', 'wrestling', 'triller', 'fite', 'matchroom', 'top rank', 'pbc', 'raw', 'smackdown', 'nxt', 'one championship', 'bkfc', 'kickboxing', 'glory', 'sport ufc', 'sport wwe', 'sport boxing', 'ufc replay', 'wwe replay', 'boxing replay']],
  ['motorsport', 'Motorsport', ['f1', 'formula 1', 'formula one', 'nascar', 'indycar', 'motogp', 'moto gp', 'wrc', 'rally', 'supercross', 'motocross', 'imsa', 'le mans', 'f1 and motogp', 'formula 1 plus moto gp', 'motorsport', 'motorsports']],
  ['tennis', 'Tennis', ['tennis', 'atp', 'wta', 'roland garros', 'tennis channel']],
  ['golf', 'Golf', ['golf', 'pga', 'lpga', 'liv golf', 'ryder cup', 'golf channel', 'masters']],
  ['cricket', 'Cricket', ['cricket', 'ipl', 'bbl', 'test match', 'willow']],
  ['rugby', 'Rugby', ['rugby', 'nrl', 'super rugby', 'six nations', 'rugby pass']],
  ['college', 'College sports', ['ncaa', 'ncaaf', 'ncaab', 'college', 'btn', 'big ten', 'b1g', 'sec network', 'acc network', 'pac 12', 'longhorn', 'nfhs', 'flo college']],
  ['racing', 'Horse racing', ['horse racing', 'sky racing', 'racing tv', 'at the races', 'tvg', 'fanduel racing']],
  ['darts', 'Darts & snooker', ['darts', 'dart', 'snooker', 'pdc', 'pool']],
  ['olympics', 'Olympics', ['olympic', 'olympics', 'paralympics']],
  ['cycling', 'Cycling', ['cycling', 'tour de france', 'giro']],
];
const SPORT_WORDS = new Phrases(SPORTS);

// ---------------------------------------------------------------- holidays (the dates: when each is "in season")
// [id, label, phrases, keyword phrases (TMDB's, a little wider), season [from month, day, to month, day], other names]
const HOLIDAYS = [
  ['christmas', 'Christmas', ['christmas', 'xmas', 'x mas', 'santa claus', 'santa clause', 'grinch', 'nutcracker', 'christmas eve', 'noel', 'navidad', 'weihnachten'], ['christmas', 'santa claus', 'christmas party', 'christmas eve', 'christmas tree', 'christmas carol', 'holiday season', 'north pole', 'christmas gift', 'christmas present'], [11, 1, 12, 31], ['xmas', 'holiday', 'holidays']],
  ['halloween', 'Halloween', ['halloween', 'trick or treat', 'all hallows', 'jack o lantern'], ['halloween', 'trick or treating', 'jack o lantern', 'all hallows eve'], [9, 15, 11, 2], ['spooky']],
  ['thanksgiving', 'Thanksgiving', ['thanksgiving'], ['thanksgiving'], [11, 1, 11, 30], []],
  ['newyear', 'New Year’s Eve', ['new years eve', 'new year s eve', 'new years'], ['new year s eve', 'new years eve', 'new year'], [12, 20, 1, 3], ['new year']],
  ['valentine', 'Valentine’s Day', ['valentine', 'valentines', 'valentines day', 'valentine s day'], ['valentine s day', 'valentine'], [1, 20, 2, 15], ['valentines']],
  ['easter', 'Easter', ['easter bunny', 'easter egg hunt'], ['easter', 'easter bunny', 'easter sunday'], [3, 15, 4, 30], []],
  ['hanukkah', 'Hanukkah', ['hanukkah', 'chanukah'], ['hanukkah', 'chanukah'], [11, 25, 12, 31], []],
  ['stpatricks', 'St. Patrick’s Day', ['st patricks day', 'st patrick s day', 'saint patricks day'], ['st patrick s day', 'saint patrick s day'], [3, 1, 3, 18], []],
  ['july4', 'Fourth of July', ['fourth of july', '4th of july', 'independence day'], ['fourth of july', 'independence day usa', 'independence day'], [6, 20, 7, 6], ['4th of july']],
];
const HOL_WORDS = new Phrases(HOLIDAYS.map(([id, n, a]) => [id, n, a]));
const HOL_KW = new Phrases(HOLIDAYS.map(([id, n, a, b]) => [id, n, b]));
// In a plot, only the plain words ("…a heist on Christmas Eve"): a mention is enough to be a holiday film.
const HOL_PLOT = new Phrases(HOLIDAYS.filter((h) => !['easter', 'july4', 'newyear'].includes(h[0])).map(([id, n, a]) => [id, n, a.filter((p) => !['noel', 'grinch', 'nutcracker', 'valentine', 'valentines'].includes(p))]));
/** The holidays in season on a date (their ids, the nearest first). */
function inSeason(d = new Date()) {
  const md = (d.getMonth() + 1) * 100 + d.getDate();
  const out = [];
  for (const [id, , , , [m1, d1, m2, d2]] of HOLIDAYS) {
    const a = m1 * 100 + d1, b = m2 * 100 + d2;
    const on = a <= b ? md >= a && md <= b : md >= a || md <= b;
    if (on) { const left = (a <= b ? b - md : md >= a ? 1231 - md + b : b - md); out.push([id, left]); }
  }
  return out.sort((x, y) => x[1] - y[1]).map((x) => x[0]);
}

// ---------------------------------------------------------------- themes and studios (TMDB keywords, studios)
const THEMES = [
  ['superhero', 'Superheroes', ['superhero', 'superheroes', 'based on comic', 'marvel cinematic universe mcu', 'dc extended universe dceu', 'super power', 'superhero team'], ['superhero', 'superheroes', 'marvel universe', 'dc universe']],
  ['truestory', 'Based on a true story', ['based on true story', 'based on a true story', 'biography', 'true crime', 'historical figure', 'based on real person'], ['true story', 'true stories', 'biopic']],
  ['zombie', 'Zombies', ['zombie', 'zombies', 'zombie apocalypse', 'living dead'], ['zombie', 'zombies']],
  ['vampire', 'Vampires', ['vampire', 'vampires', 'dracula'], ['vampire', 'vampires']],
  ['timetravel', 'Time travel', ['time travel', 'time machine', 'time loop'], []],
  ['space', 'Space', ['space', 'outer space', 'astronaut', 'spaceship', 'space travel', 'space opera', 'mars', 'nasa'], []],
  ['alien', 'Aliens', ['alien', 'aliens', 'alien invasion', 'extraterrestrial', 'ufo', 'alien life form'], []],
  ['dinosaur', 'Dinosaurs', ['dinosaur', 'dinosaurs', 'jurassic'], []],
  ['monster', 'Monsters', ['monster', 'giant monster', 'kaiju', 'creature', 'sea monster', 'godzilla'], []],
  ['shark', 'Sharks', ['shark', 'shark attack', 'great white shark'], []],
  ['heist', 'Heists', ['heist', 'bank robbery', 'robbery', 'heist movie', 'thief'], []],
  ['spy', 'Spies', ['spy', 'secret agent', 'espionage', 'cia', 'mi6', 'secret service'], ['spy']],
  ['martialarts', 'Martial arts', ['martial arts', 'kung fu', 'karate', 'wuxia', 'samurai', 'ninja'], ['martial arts', 'kung fu']],
  ['gangster', 'Gangsters & mafia', ['gangster', 'mafia', 'organized crime', 'mobster', 'cartel', 'drug cartel', 'yakuza'], ['gangster', 'mafia', 'gangster and mafia', 'gangster mafia']],
  ['postapoc', 'Post-apocalyptic', ['post apocalyptic future', 'post apocalyptic', 'apocalypse', 'dystopia', 'end of the world', 'nuclear war'], []],
  ['serialkiller', 'Serial killers', ['serial killer', 'serial murder', 'psychopath', 'slasher'], []],
  ['haunted', 'Haunted houses & ghosts', ['haunted house', 'ghost', 'ghosts', 'haunting', 'paranormal', 'poltergeist', 'possession', 'exorcism', 'demon'], []],
  ['sportsfilm', 'Sports stories', ['sports', 'boxer', 'underdog', 'basketball', 'baseball', 'american football', 'soccer', 'coach', 'sports team'], []],
  ['highschool', 'High school', ['high school', 'teenager', 'coming of age', 'prom', 'teen movie', 'school'], []],
  ['roadtrip', 'Road trips', ['road trip', 'road movie'], []],
  ['book', 'Based on a book', ['based on novel or book', 'based on novel', 'based on book', 'based on young adult novel', 'based on short story'], []],
  ['musical', 'Musicals', ['musical', 'broadway', 'singing', 'based on musical'], ['musical', 'broadway', 'broadway musical']],
  ['robot', 'Robots & AI', ['robot', 'artificial intelligence a i', 'artificial intelligence', 'android', 'cyborg', 'cyberpunk'], []],
  ['survival', 'Survival', ['survival', 'stranded', 'wilderness', 'plane crash', 'disaster', 'natural disaster'], []],
  ['animals', 'Animals', ['dog', 'cat', 'horse', 'animal', 'talking animal', 'pets', 'bear'], []],
  ['revenge', 'Revenge', ['revenge', 'vengeance', 'vigilante'], []],
];
const THEME_KW = new Phrases(THEMES.map(([id, n, a]) => [id, n, a]));
const THEME_GROUP = new Phrases(THEMES.map(([id, n, , b]) => [id, n, b]));
const STUDIOS = [
  ['marvel', 'Marvel', ['marvel studios', 'marvel entertainment', 'marvel enterprises', 'marvel animation', 'marvel television'], ['marvel', 'marvel universe', 'marvel cinematic universe mcu'], ['marvel']],
  ['dc', 'DC', ['dc films', 'dc entertainment', 'dc comics', 'dc studios'], ['dc universe', 'dc comics', 'dc extended universe dceu'], ['dc comics']],
  ['pixar', 'Pixar', ['pixar'], ['pixar'], ['pixar']],
  ['disneyanim', 'Disney', ['walt disney pictures', 'walt disney animation studios', 'walt disney productions', 'disneytoon studios', 'disney television animation'], ['disney', 'disney shorts', 'disney movies'], ['disney']],
  ['dreamworks', 'DreamWorks', ['dreamworks animation', 'dreamworks pictures', 'dreamworks'], ['dreamworks'], ['dreamworks']],
  ['ghibli', 'Studio Ghibli', ['studio ghibli'], ['ghibli', 'studio ghibli'], ['studio ghibli']],
  ['lucasfilm', 'Star Wars & Lucasfilm', ['lucasfilm', 'lucasfilm animation'], ['star wars'], ['star wars']],
  ['a24', 'A24', ['a24'], ['a24'], []],
  ['blumhouse', 'Blumhouse', ['blumhouse productions', 'blumhouse television'], ['blumhouse'], []],
  ['illumination', 'Illumination', ['illumination', 'illumination entertainment'], [], []],
  ['laika', 'Laika & Aardman', ['laika', 'aardman', 'aardman animations'], [], []],
  ['sonyanim', 'Sony Pictures Animation', ['sony pictures animation'], [], []],
  ['hammer', 'Hammer horror', ['hammer films', 'hammer film productions'], [], []],
  ['bond', 'James Bond', ['eon productions'], ['james bond', '007'], ['james bond']],
  ['wizarding', 'Harry Potter & Wizarding World', ['heyday films'], ['harry potter', 'wizarding world'], ['harry potter', 'fantastic beasts']],
  ['startrek', 'Star Trek', [], ['star trek'], ['star trek']],
];
const STUDIO_CO = new Phrases(STUDIOS.map(([id, n, a]) => [id, n, a]));
const STUDIO_GROUP = new Phrases(STUDIOS.map(([id, n, , b]) => [id, n, b]));
const STUDIO_COL = new Phrases(STUDIOS.map(([id, n, , , c]) => [id, n, c])); // (collections and keywords: "Star Wars Collection")

// ---------------------------------------------------------------- countries (channels)
const COUNTRY_NAMES = { US: 'USA', USA: 'USA', UK: 'UK', GB: 'UK', CA: 'Canada', AU: 'Australia', NZ: 'New Zealand', IE: 'Ireland', ZA: 'South Africa', IN: 'India', PK: 'Pakistan', FR: 'France', DE: 'Germany', AT: 'Austria', CH: 'Switzerland', BE: 'Belgium', NL: 'Netherlands', ES: 'Spain', MX: 'Mexico', AR: 'Argentina', BR: 'Brazil', PT: 'Portugal', IT: 'Italy', TR: 'Turkey', GR: 'Greece', RU: 'Russia', UA: 'Ukraine', PL: 'Poland', RO: 'Romania', HU: 'Hungary', CZ: 'Czechia', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', JP: 'Japan', KR: 'Korea', CN: 'China', PH: 'Philippines', MY: 'Malaysia', TH: 'Thailand', ID: 'Indonesia', VN: 'Vietnam', SA: 'Saudi Arabia', AE: 'UAE', EG: 'Egypt', MA: 'Morocco', IL: 'Israel', IR: 'Iran', IQ: 'Iraq' };
// Words in providers' channel categories that name a country ("|UK| …", "Canada Live Event-Ppv", "Philippines").
const COUNTRY_WORDS = new Phrases([
  ['US', '', ['usa', 'us', 'united states', 'america', 'american']], ['UK', '', ['uk', 'united kingdom', 'britain', 'british', 'england', 'scotland', 'wales', 'cymru']],
  ['CA', '', ['canada', 'canadian', 'ca', 'quebec', 'quebecoise']], ['AU', '', ['australia', 'aussie', 'au']], ['NZ', '', ['new zealand', 'nz']], ['IE', '', ['ireland', 'irish']],
  ['IN', '', ['india', 'hindi', 'indian']], ['PH', '', ['philippines', 'philippine', 'pinoy']], ['MY', '', ['malaysia', 'malaysian']], ['ZA', '', ['south africa', 'dstv']],
  ['FR', '', ['france', 'french']], ['DE', '', ['germany', 'deutschland', 'german']], ['ES', '', ['spain', 'espana', 'spanish']], ['MX', '', ['mexico', 'mexican']],
  ['IT', '', ['italy', 'italia', 'italian']], ['TR', '', ['turkey', 'turkish', 'turkiye']], ['AR', '', ['argentina']], ['BR', '', ['brazil', 'brasil']],
  ['PT', '', ['portugal']], ['NL', '', ['netherlands', 'dutch', 'holland']], ['BE', '', ['belgium']], ['SE', '', ['sweden', 'swedish']], ['NO', '', ['norway']],
  ['DK', '', ['denmark']], ['FI', '', ['finland']], ['PL', '', ['poland', 'polish']], ['GR', '', ['greece', 'greek']], ['AT', '', ['austria']], ['CH', '', ['switzerland', 'swiss']],
]);

// ---------------------------------------------------------------- events
const EVENT_WORDS = new Phrases([['ppv', '', ['ppv', 'pay per view', 'event', 'events', 'live event', 'live events', 'ppv events', 'eevnt', 'fight night']]]);

/** Every category this can make (before the admin's choices): [{ id, n, k, types? }]. */
function builtins() {
  const out = [];
  out.push({ id: 'tr:day', n: 'Trending today', k: 'top' }, { id: 'tr:week', n: 'Trending this week', k: 'top' }, { id: 'tr:pop', n: 'Popular right now', k: 'top' },
    { id: 'tr:top', n: 'Top rated of all time', k: 'top' }, { id: 'tr:now', n: 'Out now', k: 'top', nt: { movie: 'In cinemas now', show: 'On TV this week' } },
    { id: 'tr:soon', n: 'New today and coming', k: 'top', nt: { movie: 'Coming to cinemas', show: 'New episodes today' } },
    { id: 'v:new', n: 'Just added', k: 'top' }, { id: 'v:rel', n: 'New releases', k: 'top' });
  for (const [id, n] of NETS) out.push({ id: 'n:' + id, n, k: 'net' });
  for (const [id, n] of GENRES) out.push({ id: 'g:' + id, n, k: 'genre' });
  for (const [id, n] of SPORTS) out.push({ id: 's:' + id, n, k: 'sport' });
  for (const [id, n, , , , aka] of HOLIDAYS) out.push({ id: 'h:' + id, n, k: 'hol', aka });
  for (const [id, n] of THEMES) out.push({ id: 't:' + id, n, k: 'theme' });
  for (const [id, n] of STUDIOS) out.push({ id: 'st:' + id, n, k: 'studio' });
  const seen = new Set();
  for (const [code, n] of Object.entries(COUNTRY_NAMES)) { if (seen.has(n)) continue; seen.add(n); out.push({ id: 'c:' + code, n, k: 'country' }); }
  out.push({ id: 'e:ppv', n: 'Events & pay-per-view', k: 'event' });
  return out;
}
const BUILTINS = builtins();
const BUILTIN_IDS = new Set(BUILTINS.map((d) => d.id));
const COUNTRY_ID = (() => { const m = {}; const firstOf = {}; for (const [code, n] of Object.entries(COUNTRY_NAMES)) { if (!firstOf[n]) firstOf[n] = code; m[code] = 'c:' + firstOf[n]; } return m; })();

const DEFAULTS = {
  on: false, // the switch: smarter categories instead of the providers' own
  keep: false, // the providers' own categories too (under "From your providers")
  region: 'US', // streaming services as they are in this country (TMDB's lists)
  kinds: Object.fromEntries(KIND_IDS.map((k) => [k, true])),
  hidden: [], // category ids not used
  names: {}, // id → the admin's name for it
  custom: [], // the admin's own: { id, n, words: 'a, b', types: [] }
  holidays: 'always', // 'always' listed, or 'season' (only around the day) — they can be searched for either way
  plot: true, // a holiday mentioned in the plot counts
  extras: true, // fetch streaming services, keywords and studios from TMDB (in the background)
  epg: true, // what the guide shows decides a channel's genre too
  min: 2, // categories with fewer titles aren't listed
  liked: true, // My List: titles given a thumbs up are in it too
  listOrder: 'played', // My List: 'played' (recently played first, then recently added or liked) | 'added'
};

/** The admin's settings, with the defaults filled in. */
function config(S) {
  const c = { ...DEFAULTS, ...((S && S.smart) || {}) };
  c.kinds = { ...DEFAULTS.kinds, ...((S && S.smart && S.smart.kinds) || {}) };
  c.hidden = Array.isArray(c.hidden) ? c.hidden : [];
  c.names = c.names && typeof c.names === 'object' ? c.names : {};
  c.custom = Array.isArray(c.custom) ? c.custom : [];
  c.region = /^[A-Z]{2}$/.test(String(c.region || '').toUpperCase()) ? String(c.region).toUpperCase() : 'US';
  return c;
}

/** Cleans what the admin sent (Admin → Categories). */
function clean(b, prev) {
  const c = config({ smart: prev });
  const out = { ...c };
  for (const k of ['on', 'keep', 'plot', 'extras', 'epg', 'liked']) if (k in b) out[k] = !!b[k];
  if (typeof b.region === 'string' && /^[A-Za-z]{2}$/.test(b.region)) out.region = b.region.toUpperCase();
  if (b.holidays === 'season' || b.holidays === 'always') out.holidays = b.holidays;
  if (b.listOrder === 'played' || b.listOrder === 'added') out.listOrder = b.listOrder;
  if (Number.isFinite(Number(b.min))) out.min = Math.max(1, Math.min(50, Math.round(Number(b.min))));
  if (b.kinds && typeof b.kinds === 'object') for (const k of KIND_IDS) if (k in b.kinds) out.kinds[k] = !!b.kinds[k];
  const customIds = new Set();
  if (Array.isArray(b.custom)) {
    out.custom = b.custom.slice(0, 60).map((x) => {
      const n = String((x && x.n) || '').trim().slice(0, 40);
      const words = String((x && x.words) || '').split(',').map((w) => w.trim()).filter(Boolean).slice(0, 30).join(', ');
      if (!n || !words) return null;
      let id = /^x:[a-z0-9-]{1,40}$/.test(String(x.id || '')) ? x.id : 'x:' + (plain(n).trim().replace(/ /g, '-').slice(0, 30) || 'own');
      while (customIds.has(id)) id += '-2';
      customIds.add(id);
      const types = (Array.isArray(x.types) ? x.types : []).filter((t) => ['live', 'radio', 'movie', 'show'].includes(t));
      return { id, n, words, types };
    }).filter(Boolean);
  }
  for (const x of out.custom) customIds.add(x.id);
  const known = (id) => BUILTIN_IDS.has(id) || customIds.has(id);
  if (Array.isArray(b.hidden)) out.hidden = [...new Set(b.hidden.map(String).filter(known))];
  if (b.names && typeof b.names === 'object') {
    out.names = {};
    for (const [id, n] of Object.entries(b.names)) { const v = String(n || '').trim().slice(0, 40); if (known(id) && v) out.names[id] = v; }
  }
  return out;
}

/** What devices are told (publicSettings): the categories in use, their names and order, what's in season. */
function publicView(S) {
  const c = config(S);
  if (!c.on) return { on: false, liked: c.liked, listOrder: c.listOrder };
  const hidden = new Set(c.hidden);
  const defs = [];
  for (const d of BUILTINS.concat(c.custom.map((x) => ({ id: x.id, n: x.n, k: 'own', types: x.types && x.types.length ? x.types : undefined })))) {
    if (!c.kinds[d.k] || hidden.has(d.id)) continue;
    const o = { id: d.id, n: c.names[d.id] || d.n, k: d.k };
    if (d.nt && !c.names[d.id]) o.nt = d.nt;
    if (d.types) o.types = d.types;
    if (d.aka && d.aka.length) o.aka = d.aka;
    defs.push(o);
  }
  return {
    on: true, keep: c.keep, min: c.min, holidays: c.holidays, liked: c.liked, listOrder: c.listOrder,
    kinds: KINDS.filter((k) => c.kinds[k.k]).map((k) => ({ k: k.k, n: k.n, types: k.types })), defs, season: inSeason().map((h) => 'h:' + h),
  };
}

/**
 * Works out the categories for items. deps: { meta(key) → TMDB details or null, epgCats(item) → [category text] }.
 * tagger(S) → { tag(it) → [ids] or null }.
 */
function tagger(S, deps = {}) {
  const c = config(S);
  if (!c.on) return { on: false, tag: () => null };
  const hidden = new Set(c.hidden);
  const kind = (id) => (id.startsWith('n:') ? 'net' : id.startsWith('g:') ? 'genre' : id.startsWith('s:') ? 'sport' : id.startsWith('h:') ? 'hol' : id.startsWith('t:') ? 'theme' : id.startsWith('st:') ? 'studio' : id.startsWith('c:') ? 'country' : id.startsWith('e:') ? 'event' : id.startsWith('x:') ? 'own' : 'top');
  const ok = (id) => c.kinds[kind(id)] && !hidden.has(id);
  const custom = c.custom.map((x) => ({ id: x.id, types: x.types, ph: new Phrases([[x.id, x.n, x.words.split(',').map((w) => w.trim())]]) }));
  const meta = deps.meta || (() => null);
  const epgCats = deps.epgCats || (() => []);

  function tagChannel(it) {
    const out = new Set();
    const name = plain(it.n + (it.tvgName && it.tvgName !== it.n ? ' ' + it.tvgName : ''));
    const group = plain((it.rg || '') + ' ' + (it.g || ''));
    const both = name + group;
    const nets = NET_LIVE.find(both, new Set());
    for (const id of nets) out.add('n:' + id);
    const gs = GENRE_WORDS.find(both, new Set());
    if (c.epg && it.epg) {
      // What the guide says is on over the next hours: a category most of the programmes have.
      const cats = epgCats(it);
      if (cats.length >= 3) {
        const count = new Map();
        for (const x of cats) for (const id of EPG_GENRE.find(plain(x), new Set())) count.set(id, (count.get(id) || 0) + 1);
        for (const [id, n] of count) if (n / cats.length >= 0.4) gs.add(id);
      }
    }
    // Sports channels: which sports, by name and category ("NHL VEGAS GOLDEN KNIGHTS", "MLS PPV").
    const sp = SPORT_WORDS.find(both, new Set());
    if (sp.size) gs.add('sports');
    if (gs.has('sports')) for (const id of sp) out.add('s:' + id);
    if (it.kids) gs.add('kids');
    if (it.adult) { out.clear(); gs.clear(); gs.add('adult'); }
    // Local stations: "ABC 6 COLUMBUS OH (WSYX)", "FOX 30 (WFOX) Jacksonville", "Local - NBC".
    const affiliate = nets.has('abc') || nets.has('cbs') || nets.has('nbc') || nets.has('fox') || nets.has('pbs') || nets.has('cw');
    if (/ local /.test(group) || (affiliate && (/[([][KW][A-Z]{2,3}(?:-?(?:DT|TV|LD|CD))?[)\]]/.test(it.n) || /^ (?:abc|cbs|nbc|fox|pbs|cw|my) \d{1,2} [a-z]/.test(name)))) gs.add('local');
    if (/ 24 7 /.test(both) || / 247 /.test(both)) gs.add('247');
    // Too general to say anything when it's only from the category ("Entertainment", "General"): a fallback.
    if (gs.size > 1) gs.delete('entertainment');
    for (const id of gs) out.add('g:' + id);
    if (it.ev || it.rn || EVENT_WORDS.find(both, new Set()).size) out.add('e:ppv');
    for (const h of HOL_WORDS.find(both, new Set())) out.add('h:' + h);
    // Country: the provider's tag ("US| …", "|UK| …") or a word in its category.
    const co = it.co && COUNTRY_ID[it.co] ? COUNTRY_ID[it.co] : null;
    if (co) out.add(co);
    else { const cs = COUNTRY_WORDS.find(group, new Set()); if (cs.size === 1) out.add(COUNTRY_ID[[...cs][0]]); }
    return out;
  }

  function tagTitle(it) {
    const out = new Set();
    const m = meta(it.k) || null;
    const group = plain((it.rg || '') + ' ' + (it.g || ''));
    const title = plain(it.n);
    // Networks and services: the label, the categories, TMDB's lists — never the title ("Mad Max" isn't on Max).
    const nets = new Set();
    if (it.svc && SVC[it.svc]) nets.add(SVC[it.svc]);
    NET_VOD_GROUP.find(group, nets);
    if (m) {
      for (const p of m.wp || []) NET_VOD.find(plain(p), nets);
      for (const p of m.nw || []) NET_VOD.find(plain(p), nets);
    }
    for (const id of nets) out.add('n:' + id);
    // Genres: TMDB's (or the provider's) genre names, then the categories.
    const gs = new Set();
    for (const g of it.gn || []) { const id = GENRE_OF[g]; if (id) gs.add(id); }
    GENRE_VOD_GROUP.find(group, gs);
    // (TMDB's keywords: the genres its series list hasn't got, and more of them for films.)
    if (m && m.kw) {
      for (const k of m.kw) {
        const n = String(k).toLowerCase();
        for (const [id, re, not] of GENRE_KW) if (re.test(n) && !(not && not.test(n))) gs.add(id);
      }
    }
    if (it.t === 'show' && c.plot && it.plot && !(m && m.kw && m.kw.length)) {
      const p = String(it.plot).slice(0, 800).toLowerCase();
      for (const [id, re] of GENRE_PLOT) if (re.test(p)) gs.add(id);
    }
    if (gs.has('standup')) gs.add('comedy');
    if (gs.has('animation') && m && m.ol === 'ja') gs.add('anime');
    if (it.kids) gs.add('kids');
    if (it.y && it.y < 1970) gs.add('classic');
    if (gs.has('comedy') && m && (m.kw || []).some((k) => /stand.?up/i.test(k))) gs.add('standup');
    const sp = new Set();
    if (gs.has('sports') || SPORT_WORDS.find(group, sp).size) { SPORT_WORDS.find(title, sp); SPORT_WORDS.find(group, sp); if (sp.size) gs.add('sports'); }
    if (it.adult) { gs.clear(); nets.clear(); out.clear(); gs.add('adult'); }
    for (const id of gs) out.add('g:' + id);
    for (const id of sp) out.add('s:' + id);
    // Holidays: TMDB's keywords, the title, the category, the plot.
    const hol = new Set();
    HOL_WORDS.find(title, hol);
    HOL_WORDS.find(group, hol);
    if (m && m.kw) for (const k of m.kw) HOL_KW.find(plain(k), hol);
    if (c.plot && it.plot) HOL_PLOT.find(plain(String(it.plot).slice(0, 600)), hol);
    if (!it.adult) for (const h of hol) out.add('h:' + h);
    // Themes and studios.
    const th = new Set();
    THEME_GROUP.find(group, th);
    if (m && m.kw) for (const k of m.kw) THEME_KW.find(plain(k), th);
    for (const id of th) out.add('t:' + id);
    const st = new Set();
    STUDIO_GROUP.find(group, st);
    if (m) {
      for (const co of m.co || []) STUDIO_CO.find(plain(co), st);
      if (m.col && m.col.name) STUDIO_COL.find(plain(m.col.name), st);
      if (m.kw) for (const k of m.kw) STUDIO_COL.find(plain(k), st);
    }
    // ("Disney" the studio for Disney's own films: Pixar and Marvel are listed under their own name.)
    if (st.has('pixar') || st.has('marvel') || st.has('lucasfilm')) st.delete('disneyanim');
    for (const id of st) out.add('st:' + id);
    return out;
  }

  return {
    on: true,
    tag(it) {
      if (!it || it.t === 'episode') return null;
      const out = it.t === 'live' || it.t === 'radio' ? tagChannel(it) : it.t === 'movie' || it.t === 'show' ? tagTitle(it) : new Set();
      if (custom.length) {
        const text = plain(it.n + ' ' + (it.rg || '') + ' ' + (it.g || '') + ' ' + (it.gn || []).join(' '));
        const t = it.t === 'episode' ? 'show' : it.t;
        for (const x of custom) if ((!x.types.length || x.types.includes(t)) && x.ph.find(text, new Set()).size) out.add(x.id);
      }
      const ids = [...out].filter(ok);
      // Nothing else: "Everything else", so nothing is out of reach.
      if (!ids.some((id) => !id.startsWith('c:') && !id.startsWith('e:')) && ok('g:other')) ids.push('g:other');
      return ids.sort();
    },
  };
}

// ---------------------------------------------------------------- trending and popular worldwide (TMDB's charts)
const CHARTS = [
  { id: 'tr:day', movie: ['/trending/movie/day', 3], show: ['/trending/tv/day', 3] },
  { id: 'tr:week', movie: ['/trending/movie/week', 5], show: ['/trending/tv/week', 5] },
  { id: 'tr:pop', movie: ['/movie/popular', 5], show: ['/tv/popular', 5] },
  { id: 'tr:top', movie: ['/movie/top_rated', 10], show: ['/tv/top_rated', 10] },
  { id: 'tr:now', movie: ['/movie/now_playing', 3], show: ['/tv/on_the_air', 3] },
  // (Films with a date still to come that the lists already have, and series with an episode out today.)
  { id: 'tr:soon', movie: ['/movie/upcoming', 2], show: ['/tv/airing_today', 4] },
];

/**
 * TMDB's charts, refreshed every few hours, matched to the catalogue by TMDB id. deps: { tmdb, catalog(), region() }.
 * view() → { at, lists: { 'tr:week': { movie: [[keys of one title]…], show: […] } } }.
 */
class Trending {
  constructor({ tmdb, catalog, region }) {
    this.tmdb = tmdb; this.catalog = catalog; this.region = region || (() => 'US');
    this.raw = null; // { at, lists: { id: { movie: [tmdb ids], show: [tmdb ids] } } }
    this.busy = null;
    this.idx = null;
    this.out = null;
  }
  async refresh(force = false) {
    if (!this.tmdb || !this.tmdb.enabled()) return null;
    if (this.busy) return this.busy;
    if (!force && this.raw && Date.now() - this.raw.at < 6 * 3600e3) return this.raw;
    this.busy = (async () => {
      const lists = {};
      for (const ch of CHARTS) {
        lists[ch.id] = {};
        for (const type of ['movie', 'show']) {
          const [p, pages] = ch[type];
          const ids = [];
          for (let page = 1; page <= pages; page++) {
            const params = { page: String(page) };
            if (/now_playing|popular|top_rated|upcoming/.test(p) && type === 'movie') params.region = this.region();
            // ("Today" where the server is, not in the US.)
            if (/airing_today/.test(p)) { try { params.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch {} }
            let j;
            try { j = await this.tmdb.get(p, params, 5 * 3600e3); } catch { break; }
            for (const r of (j && j.results) || []) if (r && r.id && !ids.includes(r.id)) ids.push(r.id);
            if (!j || !j.total_pages || page >= j.total_pages) break;
          }
          lists[ch.id][type] = ids;
        }
      }
      this.raw = { at: Date.now(), lists };
      this.out = null;
      return this.raw;
    })().finally(() => { this.busy = null; });
    return this.busy;
  }
  /** TMDB id → catalogue keys (rebuilt when the catalogue or the matches change). */
  _index() {
    const cat = this.catalog();
    const map = this.tmdb.map.data.m;
    const v = cat.version + ':' + Object.keys(map).length;
    if (this.idx && this.idx.v === v) return this.idx;
    const m = new Map();
    for (const it of cat.items) {
      if (it.t !== 'movie' && it.t !== 'show') continue;
      const x = map[it.k];
      const id = x && x.id ? String(x.id) : /^\d+$/.test(String(it.tmdb || '')) ? String(it.tmdb) : '';
      if (!id || (x && x.none)) continue;
      const k = it.t + id;
      const l = m.get(k);
      if (l) l.push(it.k); else m.set(k, [it.k]);
    }
    this.idx = { v, m };
    this.out = null;
    return this.idx;
  }
  view() {
    if (!this.raw) return { at: 0, lists: {} };
    const idx = this._index();
    if (this.out && this.out.v === idx.v && this.out.at === this.raw.at) return this.out.data;
    const lists = {};
    for (const [id, l] of Object.entries(this.raw.lists)) {
      lists[id] = {};
      for (const type of ['movie', 'show']) lists[id][type] = (l[type] || []).map((tid) => idx.m.get(type + tid)).filter(Boolean);
    }
    const data = { at: this.raw.at, lists };
    this.out = { v: idx.v, at: this.raw.at, data };
    return data;
  }
}

module.exports = { KINDS, BUILTINS, DEFAULTS, config, clean, publicView, tagger, inSeason, plain, Phrases, Trending, COUNTRY_NAMES, HOLIDAYS };
