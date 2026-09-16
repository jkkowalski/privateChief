'use strict';
/**
 * Wykluczenia domowników sprawdzane deterministycznie na składnikach przepisu.
 *
 * Model językowy generuje tekst probabilistycznie i potrafi wpisać orzechy do przepisu
 * zatytułowanego „bez orzechów" — nie z braku wiedzy, lecz z natury generowania.
 * Skutkiem bywa reakcja anafilaktyczna, więc alergie zadeklarowane w profilu sprawdza
 * KOD, jako drugie sito za modelem: aplikacja pokazuje ostrzeżenie w przepisie,
 * narzędzie sprawdz.js i serwer MCP wypisują trafienia, a skill ma je poprawić, zanim
 * plan trafi do rodziny.
 *
 * Źródło deklaracji: rodzina/domownicy.md — linie „Alergie i nietolerancje:", „Alergie:"
 * i „Dieta / ograniczenia:" pod nagłówkiem osoby. „Nie je:" pomijamy celowo: to
 * ograniczenia miękkie (skill: unikaj, ale bez zakazu).
 *
 * Grupy odpowiadają 14 alergenom z rozporządzenia (UE) 1169/2011 (te, które muszą być
 * na etykietach) plus praktycznym wykluczeniom diet: wieprzowina, mięso, miód, żelatyna,
 * alkohol. Dopasowanie jest celowo ostrożne — lepiej ostrzec o „mące" w przepisie
 * bezglutenowym, niż przemilczeć — z wyjątkami dla oczywistych zamienników („mleko
 * kokosowe", „mąka ryżowa"). Filtr nie zna składu produktów ze sklepu; etykietę czyta
 * człowiek.
 *
 * Słowa-klucze są rdzeniami po U.norm (małe litery, bez polskich znaków): jedno słowo
 * dopasowuje POCZĄTEK wyrazu w nazwie składnika („orzech" łapie „orzechy", „orzechów"),
 * słowo z „$" na końcu — cały wyraz („wino$" nie łapie „winogron"), kilka słów — ciąg
 * w całej nazwie („kasza manna").
 */

const fs = require('fs');
const path = require('path');
const U = require('./uklad.js');

const PLIK_DOMOWNIKOW = path.join(U.ROOT, 'rodzina', 'domownicy.md');

const NAZWY = {
  gluten: 'gluten', skorupiaki: 'skorupiaki', jaja: 'jaja', ryby: 'ryby',
  'orzeszki ziemne': 'orzeszki ziemne', soja: 'soja', mleko: 'mleko i nabiał',
  orzechy: 'orzechy', seler: 'seler', gorczyca: 'gorczyca', sezam: 'sezam',
  siarczyny: 'siarczyny', lubin: 'łubin', mieczaki: 'mięczaki',
  wieprzowina: 'wieprzowina', mieso: 'mięso', miod: 'miód', zelatyna: 'żelatyna',
  alkohol: 'alkohol'
};

const WIEPRZOWINA = ['wieprz', 'boczek', 'boczk', 'szynk', 'kielbas', 'slonin', 'smalec', 'schab',
  'karkowk', 'zeberk', 'salami', 'parowk', 'kabanos', 'bekon', 'golonk', 'pasztet', 'prosciutto',
  'chorizo', 'pancett', 'kaszank'];

const GRUPY = {
  gluten: {
    slowa: ['gluten', 'pszen', 'maka', 'maki', 'makaron', 'chleb', 'bulk', 'bulec', 'pieczyw',
      'kasza manna', 'manna', 'kuskus', 'bulgur', 'peczak', 'jeczmien', 'zyt', 'orkisz', 'panierk',
      'bulka tarta', 'tortill', 'tost', 'nalesnik', 'gofr', 'plack', 'placek', 'ciast', 'piwo',
      'seitan', 'otreb', 'owsian', 'platki', 'suchark', 'grzank', 'krakers', 'herbatnik',
      'biszkopt', 'pierog', 'klusk', 'kopytk', 'lazank', 'pizz', 'bagiet', 'chalk', 'rogal',
      'drozdzow', 'pszenn', 'semolin', 'durum', 'graham', 'razow', 'pumpernikiel', 'wafl',
      'precel', 'musli', 'granol', 'kasza', 'kaszk', 'makaronik'],
    wyjatki: ['bezglutenow', 'bez glutenu', 'ryzow', 'kukurydzian', 'gryczan', 'ziemniaczan',
      'jaglan', 'kokosow', 'migdalow', 'z ciecierzycy', 'ciecierzycow', 'soczewic', 'tapiok',
      'maniok', 'amarant', 'komos', 'quinoa', 'orzechow', 'kasztanow']
  },
  skorupiaki: { slowa: ['krewetk', 'krab', 'homar', 'langust', 'rak$', 'raki$', 'rakow$', 'raczk', 'scampi', 'surimi'], wyjatki: [] },
  jaja: { slowa: ['jaj', 'majonez', 'bezow', 'beza$', 'bezy$', 'bezik', 'omlet', 'kogel'], wyjatki: ['wegan', 'roslinn'] },
  ryby: {
    slowa: ['ryb', 'losos', 'dorsz', 'pstrag', 'tunczyk', 'makrel', 'sledz', 'sardynk', 'sardel',
      'halibut', 'mintaj', 'sandacz', 'szczupak', 'fladr', 'sola$', 'anchois', 'pangi', 'tilapi',
      'karp$', 'karpia$', 'wegorz', 'morszczuk', 'sos rybny', 'okon', 'troc'],
    wyjatki: []
  },
  'orzeszki ziemne': { slowa: ['orzeszk', 'arachid', 'fistaszk', 'maslo orzechowe'], wyjatki: [] },
  soja: { slowa: ['soj', 'tofu', 'edamame', 'tempeh', 'miso', 'sos sojowy', 'natto'], wyjatki: [] },
  mleko: {
    slowa: ['mlek', 'mleczn', 'mleczk', 'smietan', 'jogurt', 'twarog', 'twarozek', 'ser', 'maslo',
      'maslank', 'kefir', 'skyr', 'ricott', 'mozzarell', 'feta', 'parmezan', 'mascarpone', 'bryndz',
      'oscypek', 'camembert', 'brie', 'gouda', 'cheddar', 'halloumi', 'laktoz', 'kazein', 'lody',
      'kajmak', 'ghee', 'budyn', 'burrata', 'grana', 'pecorino', 'emmental', 'edam', 'gorgonzol',
      'labneh', 'sernik', 'kwasnica'],
    wyjatki: ['orzechow', 'roslinn', 'owsian', 'sojow', 'migdalow', 'kokosow', 'bez laktozy',
      'bezlaktozow', 'ryzow', 'wegan', 'kakaow', 'orzeszkow', 'sezamow', 'serdel', 'serc', 'sercow']
  },
  orzechy: {
    slowa: ['orzech', 'migdal', 'nerkow', 'pistacj', 'laskow', 'wlosk', 'pekan', 'makadami', 'pinii',
      'piniow', 'brazylijsk', 'marcepan', 'nutell', 'pralin', 'amaretti', 'frangipane'],
    wyjatki: ['muszkatol', 'kokos']
  },
  seler: { slowa: ['seler'], wyjatki: [] },
  gorczyca: { slowa: ['gorczyc', 'musztard'], wyjatki: [] },
  sezam: { slowa: ['sezam', 'tahin', 'hummus', 'halw'], wyjatki: [] },
  siarczyny: { slowa: ['siarczyn', 'wino$', 'wina$', 'winem$', 'winie$', 'ocet winny', 'suszone morele', 'morele suszone'], wyjatki: [] },
  lubin: { slowa: ['lubin'], wyjatki: [] },
  mieczaki: { slowa: ['malz', 'ostryg', 'omulk', 'osmiorn', 'kalmar', 'slimak', 'przegrzebk', 'mul$', 'mule$', 'muli$', 'sepi'], wyjatki: [] },
  wieprzowina: { slowa: WIEPRZOWINA, wyjatki: ['wolow', 'drobiow', 'z indyka', 'z kurczaka', 'wegan', 'wegetarian', 'roslinn', 'sojow'] },
  mieso: {
    slowa: WIEPRZOWINA.concat(['wolow', 'cielec', 'kurczak', 'kurcz', 'indyk', 'indycz', 'drob',
      'kaczk', 'ges$', 'gesi', 'jagniec', 'baranin', 'mieso', 'miesa$', 'miesem$', 'mielon', 'wedlin',
      'rosol', 'stek', 'burger', 'hamburg', 'kotlet', 'gulasz', 'watrob', 'podrob', 'flaki', 'pieczen',
      'piers z', 'udk', 'udziec', 'skrzydel', 'zoladk', 'kebab', 'gyros', 'bulion drobiow',
      'bulion wolow', 'bulion miesn']),
    wyjatki: ['sojow', 'wegetarian', 'wegan', 'roslinn', 'z ciecierzycy', 'z soczewicy', 'jarsk',
      'tofu', 'seitan', 'warzywn', 'z kalafiora', 'z fasoli', 'rybn', 'z lososia', 'z dorsza']
  },
  miod: { slowa: ['miod', 'miodow'], wyjatki: [] },
  zelatyna: { slowa: ['zelatyn'], wyjatki: ['agar', 'pektyn'] },
  alkohol: {
    slowa: ['wino$', 'wina$', 'winem$', 'winie$', 'piwo', 'piwem$', 'wodk', 'rum$', 'rumem$', 'likier',
      'brandy', 'koniak', 'whisk', 'alkohol', 'spirytus', 'prosecco', 'szampan', 'sherry', 'porto$',
      'cydr', 'nalewk', 'amaretto', 'marsala', 'kirsch'],
    wyjatki: ['bezalkohol', 'bez alkoholu', 'ocet winny', 'ocet']
  }
};

// Co w deklaracji domownika („laktoza", „bezglutenowa", „wegańska") znaczy które grupy.
const DEKLARACJE = [
  ['gluten', ['gluten']], ['celiak', ['gluten']], ['pszenic', ['gluten']],
  ['laktoz', ['mleko']], ['mlek', ['mleko']], ['nabial', ['mleko']], ['kazein', ['mleko']],
  ['orzeszk', ['orzeszki ziemne']], ['arachid', ['orzeszki ziemne']], ['fistaszk', ['orzeszki ziemne']],
  ['orzech', ['orzechy', 'orzeszki ziemne']], ['migdal', ['orzechy']],
  ['jaj', ['jaja']], ['ryb', ['ryby']],
  ['skorupiak', ['skorupiaki', 'mieczaki']], ['krewetk', ['skorupiaki']],
  ['owoce morza', ['skorupiaki', 'mieczaki', 'ryby']], ['mieczak', ['mieczaki']],
  ['soj', ['soja']], ['seler', ['seler']], ['gorczyc', ['gorczyca']], ['musztard', ['gorczyca']],
  ['sezam', ['sezam']], ['siarczyn', ['siarczyny']], ['siark', ['siarczyny']], ['lubin', ['lubin']],
  ['wegan', ['mieso', 'wieprzowina', 'ryby', 'skorupiaki', 'mieczaki', 'mleko', 'jaja', 'miod', 'zelatyna']],
  ['wegetar', ['mieso', 'wieprzowina', 'ryby', 'skorupiaki', 'mieczaki', 'zelatyna']],
  ['jarsk', ['mieso', 'wieprzowina', 'ryby', 'skorupiaki', 'mieczaki', 'zelatyna']],
  ['pescetar', ['mieso', 'wieprzowina']],
  ['wieprz', ['wieprzowina']], ['halal', ['wieprzowina', 'alkohol']],
  ['koszer', ['wieprzowina', 'skorupiaki', 'mieczaki']],
  ['alkohol', ['alkohol']], ['miod', ['miod']], ['zelatyn', ['zelatyna']]
];

const bezNawiasow = (s) => String(s).replace(/\([^)]*\)/g, ' ');

// Nieznana deklaracja („kiwi", „truskawki") staje się własnym słowem-kluczem: początek
// wyrazu bez końcówki, żeby „truskawki" złapało też „truskawka" i „truskawek".
const rdzen = (n) => (n.length > 5 ? n.slice(0, n.length - 2) : n);

function pasuje(nazwaNorm, slowo) {
  if (slowo.indexOf(' ') >= 0) return nazwaNorm.indexOf(slowo) >= 0;
  const wyrazy = nazwaNorm.split(' ');
  if (slowo.endsWith('$')) { const s = slowo.slice(0, -1); return wyrazy.indexOf(s) >= 0; }
  return wyrazy.some((w) => w.indexOf(slowo) === 0);
}

// ---------------------------------------------------------------- deklaracje

let cache = null;

function deklaracje() {
  let mtime = 0;
  try { mtime = fs.statSync(PLIK_DOMOWNIKOW).mtimeMs; } catch (e) { return []; }
  if (cache && cache.mtime === mtime) return cache.lista;

  const lista = [];
  let osoba = '';
  let tekst = '';
  try { tekst = fs.readFileSync(PLIK_DOMOWNIKOW, 'utf8'); } catch (e) { return []; }

  tekst.replace(/\r\n/g, '\n').split('\n').forEach((l) => {
    const h = l.match(/^##\s+(.+)$/);
    if (h) { osoba = bezNawiasow(h[1]).split(/\s[—–-]\s/)[0].replace(/\*\*/g, '').trim(); return; }
    const m = l.match(/^\s*[-*+]\s+(?:\*\*)?(Alergie i nietolerancje|Alergie|Nietolerancje|Dieta \/ ograniczenia|Dieta|Ograniczenia|Wykluczenia)(?:\*\*)?\s*:\s*(.*)$/i);
    if (!m || !osoba) return;

    bezNawiasow(m[2]).split(/[,;]/).map((x) => x.replace(/\*\*/g, '').trim()).filter(Boolean).forEach((d) => {
      const n = U.norm(d);
      if (!n || /^(brak|nie|nie ma|zadne|zadnych|none|bez|b\.?d\.?)$/.test(n)) return;
      const grupy = [];
      DEKLARACJE.forEach(([klucz, g]) => {
        if (n.indexOf(klucz) >= 0) g.forEach((x) => { if (grupy.indexOf(x) < 0) grupy.push(x); });
      });
      lista.push({ osoba, tekst: d, grupy, slowa: grupy.length ? [] : [rdzen(n)] });
    });
  });

  cache = { mtime, lista };
  return lista;
}

// ---------------------------------------------------------------- sprawdzanie

/**
 * skladniki: lista nazw albo obiektów { name }. Zwraca trafienia:
 *   { skladnik, osoba, deklaracja, grupy: [...] }
 * Jedno trafienie na parę składnik–deklaracja; grupy mówią, przez co złapało.
 */
function trafienia(skladniki, lista) {
  const dekl = lista || deklaracje();
  if (!dekl.length) return [];
  const out = [];

  skladniki.forEach((s) => {
    const nazwa = typeof s === 'string' ? s : (s && s.name) || '';
    const n = U.norm(nazwa);
    if (!n) return;
    dekl.forEach((d) => {
      const grupy = d.grupy.filter((g) => {
        const G = GRUPY[g];
        if (!G) return false;
        if (G.wyjatki.some((w) => pasuje(n, w))) return false;
        return G.slowa.some((w) => pasuje(n, w));
      });
      const wlasne = d.slowa.some((w) => pasuje(n, w));
      if (grupy.length || wlasne) out.push({ skladnik: nazwa, osoba: d.osoba, deklaracja: d.tekst, grupy });
    });
  });
  return out;
}

const nazwaGrupy = (g) => NAZWY[g] || g;

// „orzechy włoskie — Zosia (orzechy)"
function opisTrafienia(t) {
  const przez = t.grupy.length ? t.grupy.map(nazwaGrupy).join(', ') : t.deklaracja;
  return t.skladnik + ' — ' + t.osoba + ' (' + przez + ')';
}

// „laktoza (Kuba), orzechy (Zosia)" — co w ogóle było sprawdzane.
function opisDeklaracji(lista) {
  return (lista || deklaracje()).map((d) => d.tekst + ' (' + d.osoba + ')').join(', ');
}

module.exports = { deklaracje, trafienia, opisTrafienia, opisDeklaracji, nazwaGrupy, NAZWY, GRUPY, PLIK_DOMOWNIKOW };
