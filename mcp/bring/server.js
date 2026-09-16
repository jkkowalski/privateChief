#!/usr/bin/env node
'use strict';
/**
 * Serwer MCP: Bring! (lista zakupów) — JSON-RPC 2.0 po stdio.
 * Bez zależności zewnętrznych, wymaga Node >= 18 (globalne fetch).
 *
 * Cała logika Bring! (logowanie, katalog nazw, zapisy) siedzi w bring.js — ten plik
 * odpowiada tylko za protokół MCP i zamianę wyników na czytelny tekst po polsku.
 * Z tego samego modułu korzysta aplikacja webowa w web/app.js.
 *
 * Dane logowania: plik credentials.json obok tego pliku albo zmienne środowiskowe
 * BRING_EMAIL / BRING_PASSWORD. Hasło nigdy nie trafia do .mcp.json.
 */

const B = require('./bring.js');
const U = require('../../lib/uklad.js');
const SKL = require('../../lib/skladniki.js');
const ALERGENY = require('../../lib/alergeny.js');

const PROTOCOL = '2025-06-18';
const log = (msg) => process.stderr.write('[bring] ' + msg + '\n');

// ---------------------------------------------------------------- formatowanie

// Nagłówek odpowiedzi + ostrzeżenie, gdy aplikacja pokazuje listę w innym języku niż
// ten, w którym rozmawiamy (wtedy "Ciecierzyca" wyświetli się na telefonie po niemiecku).
function header(r) {
  const lines = ['Lista "' + r.list.name + '" [' + r.list.uuid + ']'];
  if (r.appLanguage && r.appLanguage !== r.language) {
    lines.push('Uwaga: w aplikacji ta lista ma ustawiony język ' + r.appLanguage +
      ', więc nazwy z katalogu zobaczysz na telefonie po ' + r.appLanguage.slice(0, 2) +
      ', mimo że tutaj są po ' + r.language.slice(0, 2) + '.');
  }
  if (!r.catalogOk) {
    lines.push('Uwaga: nie udało się pobrać katalogu nazw (' + r.language + ') — nazwy bez tłumaczenia.');
  }
  return lines;
}

function fmtItem(name, specification) {
  return '  - ' + name + (specification ? '  (' + specification + ')' : '');
}

// Etykiety nagłówków grup, osobno dla każdej operacji — bo "missing" znaczy co innego
// przy usuwaniu (nie ma czego kasować) niż przy odhaczaniu (nie było do kupienia).
const LABELS = {
  add:      { added: 'Dodano', updated: 'Już było na liście (zaktualizowano ilość)', failed: 'Nie udało się' },
  remove:   { removed: 'Usunięto', missing: 'Nie było na liście (pominięto)', failed: 'Nie udało się' },
  complete: { completed: 'Oznaczono jako kupione', missing: 'Nie było do kupienia (pominięto)', failed: 'Nie udało się' }
};

function render(r, op) {
  const labels = LABELS[op];
  const lines = header(r);
  const groups = [];

  r.results.forEach((it) => {
    const label = labels[it.status] || it.status;
    let g = groups.find((x) => x.label === label);
    if (!g) groups.push(g = { label, lines: [] });
    const note = it.status === 'added' && !it.matched ? 'spoza katalogu, jako własna pozycja' : it.note;
    g.lines.push(fmtItem(it.name, it.specification) + (note ? '  — ' + note : ''));
  });

  groups.forEach((g) => {
    lines.push(g.label + ' (' + g.lines.length + '):');
    g.lines.forEach((l) => lines.push(l));
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------- narzędzia MCP

const LIST_ARG = {
  type: 'string',
  description: 'Nazwa lub UUID listy Bring!. Pominięte = domyślna lista z credentials.json (albo jedyna lista na koncie).'
};

const ITEMS_ARG = {
  type: 'array',
  description: 'Pozycje po polsku: tekst ("ciecierzyca") albo obiekt {name, specification}, gdzie specification to ilość/uwaga (np. "400 g"). Nazwy są dopasowywane do katalogu Bring!; czego nie ma w katalogu, trafia na listę jako własna pozycja.',
  items: {
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nazwa produktu, np. "mleko".' },
          specification: { type: 'string', description: 'Ilość lub uwaga, np. "2 l", "3 szt.".' }
        },
        required: ['name']
      }
    ]
  }
};

// ---------------------------------------------------------------- stan przepisu
//
// Te cztery narzędzia dają sesji dostęp do tej samej pamięci, którą widzą domownicy
// w aplikacji: co z przepisu jest już załatwione, a czego jeszcze brakuje. Bez nich
// czat pytany „czego brakuje do leczo" musiał zgadywać z treści pliku i dopisywał
// na listę rzeczy, które ktoś dopisał wczoraj.

const TYDZIEN_ARG = {
  type: 'string',
  description: 'Katalog tygodnia w jadlospisy/, np. "2026-09-16_do_2026-09-22". Pominięte = tydzień bieżący.'
};

const PRZEPIS_ARG = {
  type: 'string',
  description: 'Nazwa przepisu z tego tygodnia — wystarczy fragment, np. "leczo".'
};

function biezacy(argTydzien) {
  if (argTydzien) return String(argTydzien);
  const t = U.tydzienBiezacy();
  if (!t) throw new Error('Nie ma jeszcze żadnego jadłospisu w jadlospisy/.');
  return t.slug;
}

// Zamiast slugów z adresu pokazujemy to, co widać w aplikacji: ptaszek, nazwę, ilość
// i powód odhaczenia. Powód jest ważny — inaczej sesja nie odróżni „ktoś to już
// dopisał" od „stoi w spiżarni" i zacznie kasować cudze decyzje.
function renderStan(w, naglowek) {
  const linie = [naglowek];
  const brak = w.skladniki.filter((s) => !s.odhaczony);

  linie.push('Do kupienia (' + brak.length + ' z ' + w.skladniki.length + '):');
  if (!brak.length) linie.push('  — nic, wszystko załatwione');
  brak.forEach((s) => linie.push(fmtItem(s.name, s.specification)));

  const ok = w.skladniki.filter((s) => s.odhaczony);
  if (ok.length) {
    linie.push('Załatwione (' + ok.length + '):');
    ok.forEach((s) => linie.push(fmtItem(s.name, s.specification) + '  — ' + (s.powod || 'odhaczone')));
  }
  return linie.join('\n');
}

// Nazwa przepisu z rozmowy bywa skrótem ("leczo"), a plik nazywa się pełnym daniem.
async function zPrzepisem(args, fn) {
  const tydzien = biezacy(args.tydzien);
  const znaleziony = SKL.znajdzPrzepis(tydzien, String(args.przepis || ''));
  if (znaleziony.blad) return znaleziony.blad;

  const w = await fn(tydzien, znaleziony.slug);
  if (w.blad) return w.blad;
  return { w, tydzien, tytul: znaleziony.tytul };
}

const TOOLS = [
  {
    name: 'lists',
    description: 'Zwraca listy zakupów na koncie Bring! wraz z UUID (przydatne do wpisania w ustawienia.md).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_items',
    description: 'Pokazuje zawartość listy Bring! po polsku: pozycje do kupienia oraz ostatnio kupione.',
    inputSchema: { type: 'object', properties: { list: LIST_ARG }, additionalProperties: false }
  },
  {
    name: 'add_items',
    description: 'Dodaje pozycje do listy zakupów Bring! (np. składniki z jadłospisu). Pozycja już obecna na liście dostaje tylko nową ilość.',
    inputSchema: { type: 'object', properties: { list: LIST_ARG, items: ITEMS_ARG }, required: ['items'], additionalProperties: false }
  },
  {
    name: 'remove_items',
    description: 'Usuwa pozycje z listy zakupów Bring! (bez oznaczania jako kupione).',
    inputSchema: { type: 'object', properties: { list: LIST_ARG, items: ITEMS_ARG }, required: ['items'], additionalProperties: false }
  },
  {
    name: 'complete_items',
    description: 'Oznacza pozycje jako kupione — przenosi je z listy do sekcji "ostatnio kupione".',
    inputSchema: { type: 'object', properties: { list: LIST_ARG, items: ITEMS_ARG }, required: ['items'], additionalProperties: false }
  },
  {
    name: 'skladniki_przepisu',
    description: 'Składniki przepisu z jadłospisu wraz z tym, czego jeszcze trzeba kupić. Pokazuje to samo, co domownicy widzą w aplikacji: co już dopisano na listę, co jest ze spiżarni, a czego brakuje. Zajrzyj tu, ZANIM dopiszesz cokolwiek na listę.',
    inputSchema: {
      type: 'object',
      properties: { tydzien: TYDZIEN_ARG, przepis: PRZEPIS_ARG },
      required: ['przepis'], additionalProperties: false
    }
  },
  {
    name: 'dopisz_z_przepisu',
    description: 'Dopisuje na listę Bring! te składniki przepisu, których jeszcze brakuje, i zapamiętuje to dla aplikacji (domownicy zobaczą je jako odhaczone). Ilości bierze z przepisu, pomija spiżarnię i to, co ktoś już dopisał — więc nie powiela zakupów.',
    inputSchema: {
      type: 'object',
      properties: {
        tydzien: TYDZIEN_ARG,
        przepis: PRZEPIS_ARG,
        list: LIST_ARG,
        skladniki: {
          type: 'array',
          description: 'Tylko te składniki (nazwy z przepisu). Pominięte = wszystko, czego brakuje.',
          items: { type: 'string' }
        }
      },
      required: ['przepis'], additionalProperties: false
    }
  },
  {
    name: 'odhacz_skladnik',
    description: 'Zaznacza pojedynczy składnik przepisu jako załatwiony (albo cofa to). Używaj, gdy ktoś mówi "mam już ryż" — sama lista zakupów tego nie zapamiętuje.',
    inputSchema: {
      type: 'object',
      properties: {
        tydzien: TYDZIEN_ARG,
        przepis: PRZEPIS_ARG,
        skladnik: { type: 'string', description: 'Nazwa składnika tak, jak stoi w przepisie.' },
        zalatwione: { type: 'boolean', description: 'true = nie trzeba kupować (domyślne), false = jednak trzeba.' }
      },
      required: ['przepis', 'skladnik'], additionalProperties: false
    }
  },
  {
    name: 'wyczysc_przepis',
    description: 'Kasuje zapamiętane odhaczenia jednego przepisu — wraca stan wyjściowy (odhaczona zostaje tylko spiżarnia). Nie rusza listy Bring!.',
    inputSchema: {
      type: 'object',
      properties: { tydzien: TYDZIEN_ARG, przepis: PRZEPIS_ARG },
      required: ['przepis'], additionalProperties: false
    }
  },
  {
    name: 'sprawdz_wykluczenia',
    description: 'Sprawdza składniki przepisu (albo wszystkich przepisów tygodnia) deterministycznie pod wykluczenia z rodzina/domownicy.md — alergie, nietolerancje, diety. Uruchamiaj po zapisaniu każdego przepisu i przed pokazaniem planu: model potrafi wpisać orzechy do przepisu „bez orzechów", a to sito łapie nazwy niezależnie od modelu.',
    inputSchema: {
      type: 'object',
      properties: {
        tydzien: TYDZIEN_ARG,
        przepis: { type: 'string', description: 'Nazwa przepisu (wystarczy fragment). Pominięta = wszystkie przepisy tygodnia.' }
      },
      additionalProperties: false
    }
  }
];

const HANDLERS = {
  lists: async () => {
    const d = await B.diagnose();
    if (!d.lists.length) return 'Konto ' + d.account + ' nie ma żadnej listy Bring!.';
    return ['Listy Bring! (konto: ' + d.account + ', rozmawiamy po ' + d.language + '):']
      .concat(d.lists.map((l) => '  - ' + l.name + '  [' + l.uuid + ']' +
        (l.appLanguage && l.appLanguage !== d.language ? '  — w aplikacji po ' + l.appLanguage : '')))
      .join('\n');
  },

  get_items: async (args) => {
    const r = await B.readList(args.list);
    const out = header(r);
    out.push('Do kupienia (' + r.purchase.length + '):');
    r.purchase.forEach((i) => out.push(fmtItem(i.name, i.specification)));
    out.push('Ostatnio kupione (' + r.recently.length + '):');
    r.recently.slice(0, 30).forEach((i) => out.push(fmtItem(i.name, i.specification)));
    return out.join('\n');
  },

  add_items:      async (args) => render(await B.addItems(args.list, args.items), 'add'),
  remove_items:   async (args) => render(await B.removeItems(args.list, args.items), 'remove'),
  complete_items: async (args) => render(await B.completeItems(args.list, args.items), 'complete'),

  skladniki_przepisu: async (args) => {
    const r = await zPrzepisem(args, (t, p) => SKL.stan(t, p));
    if (typeof r === 'string') return r;
    return renderStan(r.w, r.tytul + '  [' + r.tydzien + ']');
  },

  dopisz_z_przepisu: async (args) => {
    const r = await zPrzepisem(args, (t, p) => SKL.dopisz(args.list, t, p, args.skladniki));
    if (typeof r === 'string') return r;
    const naglowek = [r.tytul + '  [' + r.tydzien + ']'];
    if (r.w.uwaga) naglowek.push(r.w.uwaga);
    // Raport z Bring! opisujemy tak samo jak przy add_items, ale bez nagłówka listy —
    // liczy się, co doszło, a nie na którą listę.
    (r.w.raport || []).forEach((it) => {
      naglowek.push('  ' + (LABELS.add[it.status] || it.status) + ': ' + it.name
        + (it.specification ? '  (' + it.specification + ')' : '')
        + (it.status === 'added' && !it.matched ? '  — spoza katalogu, jako własna pozycja' : ''));
    });
    return renderStan(r.w, naglowek.join('\n'));
  },

  odhacz_skladnik: async (args) => {
    const zal = args.zalatwione === undefined ? true : !!args.zalatwione;
    const r = await zPrzepisem(args, (t, p) => SKL.przelacz(t, p, String(args.skladnik || ''), zal));
    if (typeof r === 'string') return r;
    return renderStan(r.w, r.tytul + '  [' + r.tydzien + ']: „' + args.skladnik + '" '
      + (zal ? 'odhaczone' : 'z powrotem do kupienia') + '.');
  },

  wyczysc_przepis: async (args) => {
    const r = await zPrzepisem(args, (t, p) => SKL.wyczysc(t, p));
    if (typeof r === 'string') return r;
    return renderStan(r.w, r.tytul + '  [' + r.tydzien + ']: odhaczenia wyczyszczone.');
  },

  // Drugie sito za modelem (lib/alergeny.js) — to samo, które aplikacja pokazuje
  // w przepisie i które wypisuje narzedzia/sprawdz.js.
  sprawdz_wykluczenia: async (args) => {
    const dekl = ALERGENY.deklaracje();
    if (!dekl.length) {
      return 'W rodzina/domownicy.md nie ma zadeklarowanych wykluczeń (linie „Alergie i nietolerancje:", '
        + '„Dieta / ograniczenia:") — nie ma czego sprawdzać.';
    }
    const tydzien = biezacy(args.tydzien);
    let lista = U.przepisyTygodnia(tydzien);
    if (args.przepis) {
      const z = SKL.znajdzPrzepis(tydzien, String(args.przepis));
      if (z.blad) return z.blad;
      lista = lista.filter((d) => d.slug === z.slug);
    }

    const linie = ['Wykluczenia domowników: ' + ALERGENY.opisDeklaracji(dekl), ''];
    let ile = 0;
    lista.forEach((d) => {
      const doc = U.przepis('tydzien', d.slug, tydzien);
      const traf = ALERGENY.trafienia(SKL.skladniki(doc.text), dekl);
      if (!traf.length) return;
      ile += traf.length;
      linie.push(d.tytul + ':');
      traf.forEach((t) => linie.push('  - ' + ALERGENY.opisTrafienia(t)));
    });

    if (!ile) {
      linie.push('Nic nie znaleziono w ' + lista.length + ' przepisach [' + tydzien + ']. '
        + 'Sito zna tylko nazwy z przepisów — skład produktów ze sklepu sprawdza człowiek.');
    } else {
      linie.push('', 'Trafień: ' + ile + '. Popraw te przepisy, zanim pokażesz plan rodzinie.');
    }
    return linie.join('\n');
  }
};

// ---------------------------------------------------------------- pętla JSON-RPC

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};
  const isNotification = id === undefined || id === null;

  try {
    let result;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'bring', version: '1.2.0' }
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'resources/list':
        result = { resources: [] };
        break;
      case 'prompts/list':
        result = { prompts: [] };
        break;
      case 'tools/call': {
        const fn = HANDLERS[params.name];
        if (!fn) throw new Error('Nieznane narzędzie: ' + params.name);
        const text = await fn(params.arguments || {});
        result = { content: [{ type: 'text', text }] };
        break;
      }
      default:
        if (isNotification) return;                       // np. notifications/initialized
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
        return;
    }
    if (!isNotification) send({ jsonrpc: '2.0', id, result });
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (isNotification) { log(message); return; }
    if (method === 'tools/call') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Błąd: ' + message }], isError: true } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
    }
  }
}

// Zamknięcie stdin nie może ubić procesu w trakcie żądania do API —
// czekamy, aż wszystkie rozpoczęte wywołania oddadzą odpowiedź.
let stdinEnded = false;
let pending = 0;

function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

function track(msg) {
  pending++;
  handle(msg)
    .catch((e) => log('handle: ' + ((e && e.message) || e)))
    .then(() => { pending--; maybeExit(); });
}

function serve() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { log('Pominięto niepoprawny JSON: ' + line.slice(0, 120)); continue; }
      if (Array.isArray(msg)) msg.forEach(track); else track(msg);
    }
  });
  process.stdin.on('end', () => {
    stdinEnded = true;
    setTimeout(() => process.exit(0), 30000).unref();   // bezpiecznik, gdyby API wisiało
    maybeExit();
  });
  process.on('uncaughtException', (e) => log('uncaughtException: ' + ((e && e.stack) || e)));
  process.on('unhandledRejection', (e) => log('unhandledRejection: ' + ((e && e.message) || e)));
}

// tryb diagnostyczny:  node server.js --check
async function check() {
  try {
    const d = await B.diagnose();
    process.stdout.write('OK - zalogowano jako ' + d.account + '\n');
    process.stdout.write(d.catalogOk
      ? 'OK - katalog nazw ' + d.language + ': ' + d.catalogSize + ' pozycji\n'
      : 'UWAGA - nie pobrano katalogu nazw ' + d.language + ', nazwy beda bez tlumaczenia\n');
    d.lists.forEach((l) => {
      process.stdout.write('  - ' + l.name + '  [' + l.uuid + ']' +
        (l.appLanguage && l.appLanguage !== d.language ? '  (w aplikacji po ' + l.appLanguage + ')' : '') + '\n');
    });
    if (!d.lists.length) process.stdout.write('  (konto nie ma zadnej listy)\n');
  } catch (e) {
    process.stdout.write('BLAD: ' + e.message + '\n');
    process.exitCode = 1;
  }
}

if (process.argv.includes('--check')) check(); else serve();
