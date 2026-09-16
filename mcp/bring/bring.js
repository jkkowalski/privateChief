'use strict';
/**
 * Wspólna logika Bring! — używana przez serwer MCP (server.js) i aplikację webową (web/app.js).
 * Bez zależności zewnętrznych, wymaga Node >= 18 (globalne fetch).
 *
 * Moduł oddaje dane w postaci struktur; formatowanie tekstu zostaje po stronie klientów.
 *
 * Uwaga: korzysta z nieoficjalnego API Bring! (tego samego, z którego korzystają
 * biblioteki społecznościowe i integracja Home Assistant). Działa na własnym koncie.
 *
 * Nazwy produktów: Bring! trzyma pozycje z katalogu pod niemieckimi kluczami
 * ("Kichererbsen"), a aplikacja pokazuje je wg pliku articles.<locale>.json.
 * Tłumaczymy w obie strony, żeby polskie nazwy trafiały na właściwe pozycje katalogu
 * zamiast tworzyć duplikaty ("Ciecierzyca" obok "Kichererbsen").
 */

const fs = require('fs');
const path = require('path');

const U = require('../../lib/uklad.js');

const BASE = (process.env.BRING_API_BASE || 'https://api.getbring.com/rest/v2/').replace(/\/*$/, '/');
// Publiczny klucz klienta aplikacji webowej Bring! (environment.bringapi.apiKeyValue
// w main.bundle.js z web.getbring.com). Bring bywa go rotuje — objawem jest HTTP 401
// z komunikatem "Invalid API key" przy wywołaniach po zalogowaniu. Wtedy trzeba go
// odczytać na nowo albo nadpisać zmienną BRING_API_KEY.
const API_KEY = process.env.BRING_API_KEY || 'cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp';
const COUNTRY = process.env.BRING_COUNTRY || 'PL';
// Dane logowania leżą w domu (konfiguracja/bring.json), nie obok kodu — dom jest jednym
// katalogiem do kopii zapasowej, a kod da się podmienić bez utraty haseł. Stare miejsce
// obok kodu działa nadal, dopóki plik tam jest.
const CRED_FILE = process.env.BRING_CREDENTIALS
  || U.plikKonfiguracji('bring.json', path.join(__dirname, 'credentials.json'));
const ARTICLES = (process.env.BRING_ARTICLES_BASE || 'https://web.getbring.com/locale/').replace(/\/*$/, '/');
const LANGUAGE_FALLBACK = 'pl-PL';

// Katalog roboczy (poza repozytorium): cache katalogu nazw i zapisana sesja.
// Bez nich każdy nowy proces — a czat startuje nowy przy KAŻDEJ wiadomości —
// płacił 150 ms za katalog i 685 ms za logowanie, zanim cokolwiek odpowiedział.
const DANE = process.env.PC_DANE || U.DIR_DANE;
const KATALOG_TTL = 7 * 24 * 3600 * 1000;      // katalog Bring! zmienia się rzadko

const log = (msg) => process.stderr.write('[bring] ' + msg + '\n');

function zapiszDane(nazwa, obj) {
  try {
    fs.mkdirSync(DANE, { recursive: true });
    const tmp = path.join(DANE, nazwa + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, path.join(DANE, nazwa));
  } catch (e) {
    log('Nie udało się zapisać ' + nazwa + ' (' + e.message + ') — działam bez cache.');
  }
}

function czytajDane(nazwa) {
  try { return JSON.parse(fs.readFileSync(path.join(DANE, nazwa), 'utf8')); }
  catch (e) { return null; }
}

// ---------------------------------------------------------------- dane logowania

function loadCredentials() {
  let email = process.env.BRING_EMAIL || '';
  let password = process.env.BRING_PASSWORD || '';
  let defaultList = process.env.BRING_LIST || '';
  let language = process.env.BRING_LANGUAGE || '';

  if (fs.existsSync(CRED_FILE)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    } catch (e) {
      throw new Error('Nie mogę odczytać ' + CRED_FILE + ' (niepoprawny JSON): ' + e.message);
    }
    email = email || raw.email || '';
    password = password || raw.password || '';
    defaultList = defaultList || raw.defaultList || '';
    language = language || raw.language || '';
  }

  if (!email || !password) {
    throw new Error(
      'Brak danych logowania do Bring!. Uzupełnij plik ' + CRED_FILE +
      ' (pola "email" i "password", wzór w mcp/bring/credentials.example.json obok kodu) albo ustaw ' +
      'zmienne BRING_EMAIL i BRING_PASSWORD.'
    );
  }
  return { email, password, defaultList, language: language || LANGUAGE_FALLBACK };
}

// ---------------------------------------------------------------- warstwa HTTP

function formEncode(obj) {
  return Object.keys(obj)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] == null ? '' : String(obj[k])))
    .join('&');
}

let session = null; // { token, uuid, name, expiresAt }

async function login() {
  const { email, password } = loadCredentials();
  const res = await fetch(BASE + 'bringauth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-BRING-API-KEY': API_KEY,
      'X-BRING-CLIENT': 'webApp',
      'X-BRING-CLIENT-SOURCE': 'webApp',
      'X-BRING-COUNTRY': COUNTRY
    },
    body: formEncode({ email, password })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error('Bring! odrzucił logowanie (HTTP ' + res.status + '). Sprawdź e-mail i hasło w ' + CRED_FILE + '.');
    }
    throw new Error('Bring! POST bringauth -> HTTP ' + res.status + (body ? ': ' + body.slice(0, 300) : ''));
  }

  const d = await res.json();
  if (!d.access_token || !d.uuid) {
    throw new Error('Bring! zwrócił odpowiedź bez tokenu/uuid — API mogło się zmienić.');
  }
  session = {
    token: d.access_token,
    uuid: d.uuid,
    name: d.name || '',
    expiresAt: Date.now() + Math.max(60, (Number(d.expires_in) || 3600) - 60) * 1000
  };
  // Token żyje godzinę, a proces czatu tyle nie żyje — bez zapisu każda wiadomość
  // płaciła za ponowne logowanie. Plik jest w dane/, czyli poza repozytorium:
  // to sekret tej samej wagi co hasło.
  zapiszDane('sesja.json', session);
  return session;
}

async function ensureSession() {
  if (!session) {
    const zDysku = czytajDane('sesja.json');
    if (zDysku && zDysku.token && zDysku.uuid) session = zDysku;
  }
  if (!session || Date.now() >= session.expiresAt) await login();
  return session;
}

async function bring(method, endpoint, opts) {
  opts = opts || {};
  let s = await ensureSession();

  const call = async () => {
    const headers = {
      Authorization: 'Bearer ' + s.token,
      'X-BRING-API-KEY': API_KEY,
      'X-BRING-CLIENT': 'webApp',
      'X-BRING-CLIENT-SOURCE': 'webApp',
      'X-BRING-COUNTRY': COUNTRY,
      'X-BRING-USER-UUID': s.uuid
    };
    let body;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = formEncode(opts.form);
    }
    return fetch(BASE + endpoint, { method, headers, body });
  };

  let res = await call();
  if (res.status === 401) {          // token wygasł -> jedno ponowne logowanie
    s = await login();
    res = await call();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Bring! ' + method + ' ' + endpoint + ' -> HTTP ' + res.status + (body ? ': ' + body.slice(0, 300) : ''));
  }

  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return text; }
}

// ---------------------------------------------------------------- katalog artykułów

// Porównujemy nazwy "na luzie": bez wielkości liter i bez znaków diakrytycznych
// (polskie ł i niemieckie ß nie rozkładają się przez NFD, więc osobno).
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Katalog "pusty" = brak tłumaczenia, nazwy lecą jak leci (gdy CDN nie odpowiada).
const NO_CATALOG = { ok: false, display: new Map(), exact: new Map(), names: [] };
const catalogs = new Map();   // locale -> Promise<katalog>

// Surowy katalog: z dysku, jeśli świeży, inaczej z sieci. Gdy sieci nie ma, wolno
// sięgnąć po przeterminowaną kopię — stare nazwy produktów są lepsze niż żadne.
async function surowyKatalog(locale) {
  const nazwa = 'katalog-' + locale + '.json';
  const zDysku = czytajDane(nazwa);
  if (zDysku && zDysku.pobrano && (Date.now() - zDysku.pobrano) < KATALOG_TTL && zDysku.dane) {
    return zDysku.dane;
  }
  try {
    const res = await fetch(ARTICLES + 'articles.' + locale + '.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();
    zapiszDane(nazwa, { pobrano: Date.now(), dane: raw });
    return raw;
  } catch (e) {
    if (zDysku && zDysku.dane) {
      log('Katalog ' + locale + ' z sieci niedostępny (' + e.message + ') — biorę starszą kopię z dysku.');
      return zDysku.dane;
    }
    throw e;
  }
}

async function fetchCatalog(locale) {
  const raw = await surowyKatalog(locale);

  const display = new Map();  // klucz katalogowy -> nazwa w danym języku
  const exact = new Map();    // znormalizowana nazwa (lokalna albo klucz) -> klucz
  const names = [];           // [znormalizowana nazwa, klucz] do dopasowania z marginesem

  Object.keys(raw).forEach((key) => {
    const local = String(raw[key] || key);
    display.set(key, local);
    if (!exact.has(norm(local))) exact.set(norm(local), key);
    names.push([norm(local), key]);
    if (norm(key) !== norm(local)) names.push([norm(key), key]);
  });
  // klucze katalogowe dokładamy na końcu, żeby nie przykryły nazw lokalnych
  Object.keys(raw).forEach((key) => { if (!exact.has(norm(key))) exact.set(norm(key), key); });

  return { ok: true, display, exact, names };
}

function getCatalog(locale) {
  if (!catalogs.has(locale)) {
    catalogs.set(locale, fetchCatalog(locale).catch((e) => {
      log('Nie udało się pobrać katalogu ' + locale + ' (' + e.message + ') — nazwy bez tłumaczenia.');
      return NO_CATALOG;
    }));
  }
  return catalogs.get(locale);
}

// klucz katalogowy -> nazwa do pokazania (pozycja spoza katalogu zostaje sobą)
function toDisplay(cat, key) {
  return cat.display.get(key) || key;
}

// nazwa od użytkownika -> { key, matched }; matched=false => własna pozycja Bring!
function toKey(cat, name) {
  const n = norm(name);
  if (!n) return { key: String(name).trim(), matched: false };

  const hit = cat.exact.get(n);
  if (hit) return { key: hit, matched: true };

  if (n.length >= 4) {
    // A: nazwa katalogowa jest początkiem zapytania, czyli zapytanie ma dodatkowe
    //    określenie ("papryka czerwona" -> Papryka). Wygrywa najdłuższe trafienie.
    //    Dopuszczamy dokładnie jedno dodatkowe słowo: przy dwóch "papryka słodka
    //    wędzona" (przyprawa) trafiała w katalogową "Paprykę" (warzywo) i do koszyka
    //    szedł zupełnie inny produkt. Katalog ma osobną "Paprykę mieloną", ale nie da
    //    się do niej dojść po wspólnym początku — lepiej zostawić własną pozycję.
    const wider = cat.names.filter((e) => {
      if (e[0].length < 3 || n.indexOf(e[0] + ' ') !== 0) return false;
      const reszta = n.slice(e[0].length).trim();
      return reszta.length > 0 && reszta.indexOf(' ') < 0;
    });
    if (wider.length) {
      wider.sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
      return { key: wider[0][1], matched: true };
    }
    // B: zapytanie jest początkiem nazwy katalogowej, a różnica to sama końcówka
    //    fleksyjna ("ziemniak" -> Ziemniaki). Osobne słowo w reszcie dyskwalifikuje
    //    dopasowanie, bo "ogórki" to nie "ogórki konserwowe".
    const infl = cat.names.filter((e) => {
      if (e[0].indexOf(n) !== 0) return false;
      const rest = e[0].slice(n.length);
      return rest.length > 0 && rest.length <= 3 && rest.indexOf(' ') < 0;
    });
    if (infl.length) {
      infl.sort((a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0]));
      return { key: infl[0][1], matched: true };
    }
    // C: obie nazwy różnią się tylko ostatnią literą ("cytryny" -> Cytryna,
    //    "jabłka" -> Jabłko). Celowo dopuszczamy różnicę jednego znaku po każdej
    //    stronie — przy dwóch "cebula" zlewałaby się z "cebulką", a to inny produkt.
    const konc = cat.names.filter((e) => {
      const a = e[0];
      if (Math.abs(a.length - n.length) > 1) return false;
      const wspolny = Math.min(a.length, n.length) - 1;
      if (wspolny < 4) return false;
      if (a.slice(0, wspolny) !== n.slice(0, wspolny)) return false;
      const konA = a.slice(wspolny), konN = n.slice(wspolny);
      // Po obu stronach najwyżej jeden znak różnicy. Luźniejsza wersja uznawała
      // "oliwa" za "Oliwki" — a to nie odmiana, tylko inny produkt, i do koszyka
      // trafiały oliwki zamiast tłuszczu.
      if (konA.length > 1 || konN.length > 1) return false;
      return konA.indexOf(' ') < 0 && konN.indexOf(' ') < 0;
    });
    if (konc.length) {
      konc.sort((a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0]));
      return { key: konc[0][1], matched: true };
    }
  }
  return { key: String(name).trim(), matched: false };
}

// ---------------------------------------------------------------- sumowanie ilości
//
// Bring! nadpisuje specyfikację przy każdym zapisie, więc "pomidory 500 g" dopisane
// dla jednego przepisu ginęły pod "pomidory 2 szt." z drugiego. Sumujemy to, co da się
// zsumować, a reszcie pozwalamy stanąć obok siebie — "500 g + 2 szt." jest uczciwe,
// a zgadywanie, ile gramów ma sztuka pomidora, skończyłoby się złym zakupem.

const UAMKI = { '½': 0.5, '⅓': 1 / 3, '¼': 0.25, '¾': 0.75, '⅔': 2 / 3, '⅛': 0.125 };

// Jednostki, które wolno przeliczać między sobą (rodzina -> ile podstawowych).
const RODZINY = {
  g: { rodzina: 'masa', mnoznik: 1, mala: 'g', duza: 'kg', prog: 1000 },
  dag: { rodzina: 'masa', mnoznik: 10, mala: 'g', duza: 'kg', prog: 1000 },
  kg: { rodzina: 'masa', mnoznik: 1000, mala: 'g', duza: 'kg', prog: 1000 },
  ml: { rodzina: 'objetosc', mnoznik: 1, mala: 'ml', duza: 'l', prog: 1000 },
  l: { rodzina: 'objetosc', mnoznik: 1000, mala: 'ml', duza: 'l', prog: 1000 }
};

function normJednostka(j) {
  return String(j || '').toLowerCase().replace(/\.$/, '').trim();
}

function naLiczbe(txt) {
  const t = String(txt).trim();
  if (UAMKI[t]) return UAMKI[t];
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*([½⅓¼¾⅔⅛])?$/);
  if (!m) return null;
  return Number(m[1].replace(',', '.')) + (m[2] ? UAMKI[m[2]] : 0);
}

function formatuj(n) {
  const zaokr = Math.round(n * 100) / 100;
  return String(zaokr).replace('.', ',');
}

// "2 × 400 g" -> 800 g; "ok. 1,5 kg" -> 1500 g; "½ pęczka" -> 0,5 pęczka
function term(kawalek) {
  const t = kawalek.replace(/\b(ok\.|około|mniej więcej)\s*/gi, '').trim();
  const m = t.match(/^(?:(\d+(?:[.,]\d+)?)\s*[×x]\s*)?([\d.,]+|[½⅓¼¾⅔⅛])\s*([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż.]+)?$/);
  if (!m) return null;
  const mnoznik = m[1] ? Number(m[1].replace(',', '.')) : 1;
  const ile = naLiczbe(m[2]);
  if (ile === null) return null;
  return { n: mnoznik * ile, j: normJednostka(m[3] || 'szt') };
}

function rozbijIlosc(spec) {
  const uwagi = [];
  const bezNawiasow = String(spec || '').replace(/\(([^)]*)\)/g, (m, w) => {
    if (w.trim()) uwagi.push(w.trim());
    return ' ';
  });
  const terminy = [];
  const reszta = [];

  // Przecinek dziesiętny nie dzieli składników ilości: "0,5 l" to jedna liczba.
  bezNawiasow.replace(/(\d),(\d)/g, '$1$2')
    .split(/\s*\+\s*|\s*,\s*|\s+i\s+/)
    .map((s) => s.replace(//g, ',').trim()).filter(Boolean)
    .forEach((k) => {
      const t = term(k);
      if (t) terminy.push(t);
      else reszta.push(k);
    });
  return { terminy, uwagi, reszta };
}

function zlozIlosc(terminy, uwagi, reszta, przed) {
  przed = przed || [];
  const czesci = terminy.map((t) => {
    const r = RODZINY[t.j];
    if (r && t.n >= r.prog) return formatuj(t.n / r.prog) + ' ' + r.duza;
    return formatuj(t.n) + (t.j === 'szt' ? ' szt.' : ' ' + t.j);
  });
  const glowna = przed.concat(czesci, reszta).join(' + ');
  const ogon = uwagi.length ? ' (' + uwagi.join('; ') + ')' : '';
  return (glowna + ogon).trim();
}

// Sumuje dwie specyfikacje. Zwraca tekst do zapisania w Bring!.
function sumujIlosci(stara, nowa) {
  const a = rozbijIlosc(stara);
  const b = rozbijIlosc(nowa);

  const wszystkie = a.terminy.concat(b.terminy);
  const grupy = [];
  wszystkie.forEach((t) => {
    const r = RODZINY[t.j];
    const klucz = r ? r.rodzina : t.j;
    let g = grupy.find((x) => x.klucz === klucz);
    if (!g) grupy.push(g = { klucz, n: 0, j: r ? r.mala : t.j, rodzinowa: !!r });
    g.n += r ? t.n * r.mnoznik : t.n;
  });

  const terminy = grupy.map((g) => ({ n: g.n, j: g.j }));
  const uwagi = a.uwagi.concat(b.uwagi.filter((u) => a.uwagi.indexOf(u) < 0));
  return zlozIlosc(terminy, uwagi, b.reszta.filter((r) => a.reszta.indexOf(r) < 0), a.reszta);
}

// ---------------------------------------------------------------- listy

async function getLists() {
  const s = await ensureSession();
  const d = await bring('GET', 'bringusers/' + s.uuid + '/lists');
  return (d && d.lists) || [];
}

let listLangs = null;   // Promise<{ [listUuid]: 'pl-PL' }>

// Język, w którym aplikacja Bring! wyświetla daną listę (ustawienie listArticleLanguage).
function getListLanguages() {
  if (!listLangs) {
    listLangs = (async () => {
      const s = await ensureSession();
      const d = await bring('GET', 'bringusersettings/' + s.uuid);
      const out = {};
      ((d && d.userlistsettings) || []).forEach((l) => {
        const v = ((l && l.usersettings) || []).find((x) => x.key === 'listArticleLanguage');
        if (v && v.value) out[l.listUuid] = v.value;
      });
      return out;
    })().catch((e) => {
      log('Nie udało się odczytać ustawień list (' + e.message + ').');
      return {};
    });
  }
  return listLangs;
}

function describeLists(lists) {
  return lists.map((l) => '"' + l.name + '" [' + l.listUuid + ']').join(', ') || '(brak list na koncie)';
}

async function resolveList(input) {
  const { defaultList } = loadCredentials();
  const want = String(input || defaultList || '').trim();
  const lists = await getLists();

  if (!want) {
    if (lists.length === 1) return lists[0];
    throw new Error('Nie wiem, której listy użyć. Podaj parametr "list" (nazwa lub UUID) albo ustaw "defaultList" w ' +
      CRED_FILE + '. Dostępne: ' + describeLists(lists));
  }
  const byUuid = lists.find((l) => l.listUuid === want);
  if (byUuid) return byUuid;
  const byName = lists.find((l) => String(l.name || '').toLowerCase() === want.toLowerCase());
  if (byName) return byName;
  if (/^[0-9a-f]{8}-?[0-9a-f-]{20,}$/i.test(want)) return { name: want, listUuid: want };

  throw new Error('Nie znalazłem listy "' + want + '". Dostępne: ' + describeLists(lists));
}

// Kontekst jednego wywołania: lista + katalog w języku agenta + język aplikacji Bring!.
async function context(input) {
  const { language } = loadCredentials();
  const list = await resolveList(input);
  const [cat, langs] = await Promise.all([getCatalog(language), getListLanguages()]);
  return { list, cat, language, appLanguage: langs[list.listUuid] || '' };
}

async function rawList(listUuid) {
  const d = await bring('GET', 'bringlists/' + listUuid);
  const pick = (k) => (d && (d[k] || (d.items && d.items[k]))) || [];
  return { purchase: pick('purchase'), recently: pick('recently') };
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Parametr "items" musi być niepustą tablicą (tekst albo {name, specification}).');
  }
  return items.map((it, i) => {
    if (typeof it === 'string') return { name: it.trim(), specification: '' };
    if (it && typeof it === 'object' && it.name) {
      return {
        name: String(it.name).trim(),
        specification: String(it.specification != null ? it.specification : (it.spec != null ? it.spec : '')).trim()
      };
    }
    throw new Error('items[' + i + ']: oczekiwano tekstu albo obiektu {name, specification}.');
  }).filter((x) => x.name);
}

// PUT na listę: jedno niepuste pole = jedna operacja
async function putItem(listUuid, fields) {
  const form = { purchase: '', recently: '', specification: '', remove: '', sender: 'null' };
  Object.keys(fields).forEach((k) => { form[k] = fields[k]; });
  await bring('PUT', 'bringlists/' + listUuid, { form });
}

// Raporty opierają się na tym, co widać na liście tuż przed zapisem, a Bring! nie ma
// transakcji. Gdyby przyszło kilka żądań naraz, każde zdążyłoby odczytać jeszcze stary
// stan i wynik rozminąłby się z rzeczywistością — dlatego zapisy idą pojedynczo.
let queue = Promise.resolve();

function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

// ---------------------------------------------------------------- API modułu

// Zawartość listy z nazwami przetłumaczonymi na język rozmowy.
async function readList(input) {
  const ctx = await context(input);
  const { purchase, recently } = await rawList(ctx.list.listUuid);
  const map = (arr) => arr.map((i) => ({
    key: i.name,
    name: toDisplay(ctx.cat, i.name),
    specification: i.specification || ''
  }));
  return {
    list: { name: ctx.list.name, uuid: ctx.list.listUuid },
    language: ctx.language,
    appLanguage: ctx.appLanguage,
    catalogOk: ctx.cat.ok,
    purchase: map(purchase),
    recently: map(recently)
  };
}

// Wspólny przebieg zapisu. `plan` decyduje, co zrobić z pozycją wobec stanu listy.
// Statusy: added | updated | removed | completed | missing | failed
async function write(input, items, plan) {
  const ctx = await context(input);
  const list = normalizeItems(items);

  return serialize(async () => {
    const state = await rawList(ctx.list.listUuid);
    const inPurchase = new Set(state.purchase.map((i) => i.name));
    const inRecently = new Set(state.recently.map((i) => i.name));
    // Bieżące ilości — Bring! nadpisuje specyfikację przy każdym zapisie, więc przy
    // dopisywaniu trzeba je zsumować samemu, inaczej "pomidory 500 g" z jednego
    // przepisu ginie pod "pomidory 2 szt." z drugiego.
    const ilosci = new Map();
    state.purchase.forEach((i) => ilosci.set(i.name, i.specification || ''));

    // To, co faktycznie leży na liście, ma pierwszeństwo przed katalogiem. Bez tego
    // własnej pozycji "cytryny" nie dałoby się usunąć, bo nazwa mapuje się na
    // katalogową "Cytryna" i kasowalibyśmy nie to, co użytkownik widzi.
    const naLiscie = new Map();
    state.purchase.concat(state.recently).forEach((i) => {
      const n = norm(i.name);
      if (!naLiscie.has(n)) naLiscie.set(n, i.name);
      const lokalna = norm(toDisplay(ctx.cat, i.name));
      if (!naLiscie.has(lokalna)) naLiscie.set(lokalna, i.name);
    });

    const results = [];

    for (const it of list) {
      const wprost = naLiscie.get(norm(it.name));
      const { key, matched } = wprost
        ? { key: wprost, matched: ctx.cat.display.has(wprost) }
        : toKey(ctx.cat, it.name);
      const row = {
        input: it.name,
        name: toDisplay(ctx.cat, key),
        specification: it.specification,
        matched
      };
      const step = plan({ key, matched, item: it, inPurchase, inRecently, ilosci });
      // Gdy plan zsumował ilość, pokazujemy w raporcie sumę, a nie to, co przyszło —
      // inaczej odpowiedź mówiłaby "2 szt." o pozycji, która ma na liście "500 g + 2 szt.".
      if (step.fields && step.fields.specification != null) row.specification = step.fields.specification;

      if (!step.fields) {
        results.push(Object.assign(row, { status: step.status, note: step.note || '' }));
        continue;
      }
      try {
        await putItem(ctx.list.listUuid, step.fields);
        results.push(Object.assign(row, { status: step.status, note: step.note || '' }));
      } catch (e) {
        results.push(Object.assign(row, { status: 'failed', note: e.message }));
      }
    }

    return {
      list: { name: ctx.list.name, uuid: ctx.list.listUuid },
      language: ctx.language,
      appLanguage: ctx.appLanguage,
      catalogOk: ctx.cat.ok,
      results
    };
  });
}

function addItems(input, items) {
  return write(input, items, (p) => {
    const juz = p.inPurchase.has(p.key);
    // Dopisanie do pozycji, która już jest na liście, sumuje ilości zamiast nadpisywać.
    const ilosc = juz ? sumujIlosci(p.ilosci.get(p.key) || '', p.item.specification) : p.item.specification;
    return {
      status: juz ? 'updated' : 'added',
      fields: { purchase: p.key, specification: ilosc }
    };
  });
}

function removeItems(input, items) {
  return write(input, items, (p) => {
    if (!p.inPurchase.has(p.key) && !p.inRecently.has(p.key)) {
      return { status: 'missing', fields: null };
    }
    return { status: 'removed', fields: { remove: p.key } };
  });
}

function completeItems(input, items) {
  return write(input, items, (p) => {
    if (!p.inPurchase.has(p.key)) {
      return {
        status: 'missing',
        note: p.inRecently.has(p.key) ? 'już w "ostatnio kupione"' : '',
        fields: null
      };
    }
    return { status: 'completed', fields: { recently: p.key } };
  });
}

// Diagnostyka: logowanie + katalog + listy.
async function diagnose() {
  const { language } = loadCredentials();
  const s = await login();
  const cat = await getCatalog(language);
  const [lists, langs] = await Promise.all([getLists(), getListLanguages()]);
  return {
    account: s.name || s.uuid,
    language,
    catalogOk: cat.ok,
    catalogSize: cat.display.size,
    lists: lists.map((l) => ({ name: l.name, uuid: l.listUuid, appLanguage: langs[l.listUuid] || '' }))
  };
}

module.exports = {
  CRED_FILE,
  loadCredentials,
  getLists,
  getListLanguages,
  describeLists,
  resolveList,
  readList,
  addItems,
  removeItems,
  completeItems,
  diagnose,
  // pomocnicze, przydatne przy testach i w kliencie
  getCatalog,
  toDisplay,
  toKey,
  normalizeItems
};
