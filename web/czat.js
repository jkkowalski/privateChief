'use strict';
/**
 * Czat aplikacji domowej — most do Claude Code w trybie bezokienkowym.
 *
 * Każde pytanie to wywołanie `claude -p` w katalogu projektu. Dzięki temu sesja sama
 * wczytuje skill z .claude/skills/ i narzędzia Bring! z .mcp.json — nie powielamy tu
 * ani logiki szefa kuchni, ani obsługi listy zakupów.
 *
 * Uprawnienia ogranicza web/czat-uprawnienia.json: czat widzi dane rodziny, plany,
 * przepisy i listę zakupów, a nie widzi kodu serwera, hasła do Bring! ani PIN-u.
 *
 * Każda tura, która zmieni pliki, dostaje własny commit — to jedyna droga powrotu,
 * gdy ktoś z telefonu poprosi o coś nierozsądnego.
 *
 * Wymaga jednorazowego `claude` + /login w terminalu: CLI ma własne uwierzytelnienie,
 * niezależne od aplikacji Claude na komputerze.
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const U = require('../lib/uklad.js');

// Sesje czatu pracują w domu (dane rodziny), nie w katalogu kodu: tam leży skill,
// .mcp.json i CLAUDE.md rodziny, i tam trafiają commity.
const ROOT = U.ROOT;
const USTAWIENIA = path.join(__dirname, 'czat-uprawnienia.json');
// Limit czasu na turę, per tryb. Planowanie to wywiad i zapis kilkunastu plików na mocnym
// modelu — 4 minuty zwykłej rozmowy to za mało, a ubicie procesu w połowie zostawia
// tydzień zapisany do połowy.
const LIMIT_MS = {
  zwykly: Number(process.env.PC_CZAT_TIMEOUT || 240000),
  planowanie: Number(process.env.PC_CZAT_TIMEOUT_PLANOWANIE || 600000)
};

// Klucz API zamiast logowania Claude Code: rozliczenie za zużycie, warunki komercyjne,
// bez pytania o współdzielenie subskrypcji z domownikami. Ustawia go aplikacja
// z konfiguracja/web.json (pole "claudeApiKey") albo środowisko.
let KLUCZ_API = process.env.ANTHROPIC_API_KEY || '';
function ustawKluczApi(k) { if (k) KLUCZ_API = String(k); }

// Na tej maszynie w PATH potrafią stać dwie instalacje Claude Code, z czego jedna bywa
// uszkodzona po nieudanej aktualizacji (zostają same pliki claude.exe.old.*). Poleganie
// na PATH kończy się wtedy błędem "is not recognized", więc szukamy pliku wprost —
// zaczynając od katalogu Node'a, którym uruchomiono ten serwer.
function znajdzCli() {
  const wzgledemNode = path.join(path.dirname(process.execPath),
    'node_modules', '@anthropic-ai', 'claude-code', 'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude');
  const globalneNpm = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin',
        process.platform === 'win32' ? 'claude.exe' : 'claude')
    : '';

  const kandydaci = [process.env.PC_CLAUDE, wzgledemNode, globalneNpm].filter(Boolean);
  for (const k of kandydaci) {
    try { if (fs.existsSync(k)) return k; } catch (e) { /* próbujemy dalej */ }
  }
  return 'claude';                         // ostatecznie licz na PATH
}

const CLI = znajdzCli();

// Dwa tryby rozmowy, bo „czego brakuje do leczo" i „ułóż jadłospis na tydzień" to dwie
// różne prace: pierwsza ma być tania i szybka, druga ma być zrobiona dobrze. Tryb jest
// cechą SESJI, nie wiadomości — planowanie to wywiad na kilka tur i nie może w połowie
// przeskoczyć na słabszy model.
const KONTEKST = {
  zwykly: [
    'Rozmawiasz przez aplikację domową PrivateChief z domownikiem, który trzyma telefon',
    'w kuchni — być może w trakcie gotowania. Odpowiadaj po polsku, krótko i konkretnie,',
    'zwykłym tekstem bez nagłówków i tabel; kilka zdań wystarczy.',
    'Rozmówcą bywa dziecko albo gość, więc nie zakładaj wiedzy o plikach ani o tym projekcie.',
    'Gdy prosi o zmianę w jadłospisie lub przepisie — wykonaj ją i powiedz jednym zdaniem,',
    'co zmieniłeś. Gdy prosi o zakupy — dopisz do listy Bring! i powiedz, co doszło.',
    'Nie pytaj o potwierdzenie przy drobiazgach; pytaj tylko wtedy, gdy bez odpowiedzi',
    'zrobiłbyś coś nieodwracalnego albo wyraźnie wbrew profilowi rodziny (alergie, diety).'
  ].join(' '),
  planowanie: [
    'Rozmawiasz przez aplikację domową PrivateChief z domownikiem, który planuje jadłospis',
    'na kolejny tydzień. To pełna sesja planowania według skilla: najpierw zapytaj o miniony',
    'tydzień (co smakowało, sytość, czego zabrakło), potem ułóż plan. Odpowiadaj po polsku,',
    'zwykłym tekstem bez tabel i nagłówków markdown — panel czatu ich nie renderuje, a ekran',
    'to telefon. Propozycję planu zapisz od razu do pliku jadlospisy/<tydzień>/jadlospis.md',
    'z polem "status": "propozycja" w nagłówku JSON (i przepisy do przepisy/), a w rozmowie',
    'podaj tylko skrót: jedna linia na dzień, potem prośba o uwagi — domownik obejrzy plan',
    'w aplikacji w zakładce Jadłospisy. Po akceptacji usuń pole status. Listy zakupów nie',
    'wysyłaj do Bring! bez wyraźnego "wysyłaj". Po zapisaniu przepisów uruchom',
    'sprawdz_wykluczenia i popraw trafienia, zanim poprosisz o akceptację.',
    'Jeżeli domownik nie prosi o nowy tydzień, tylko o zmianę albo przebudowę bieżącego',
    'planu — wykonaj tę zmianę od razu, bez wywiadu o miniony tydzień.'
  ].join(' ')
};

// Modele per tryb. Aliasy "sonnet"/"opus" rozwiązuje Claude Code na to, co konto ma
// dostępne; pełne identyfikatory (np. claude-sonnet-5) też działają. Ustawia je aplikacja
// z konfiguracja/web.json (claudeModel, claudeModelPlanowanie).
const MODELE = { zwykly: 'sonnet', planowanie: 'opus' };
function ustawModele(zwykly, planowanie) {
  if (zwykly) MODELE.zwykly = String(zwykly);
  if (planowanie) MODELE.planowanie = String(planowanie);
}

// Wykrywanie planowania z treści działa tylko na PIERWSZĄ wiadomość nowej rozmowy — potem
// tryb jest już własnością sesji. Przycisk w aplikacji ustawia tryb wprost i jest drogą
// główną; to jest siatka na tych, którzy po prostu napiszą „ułóż jadłospis".
// Wzorzec jest eksportowany, bo ten sam test robi też przeglądarka — żeby podświetlić
// tryb planowania od razu przy wysyłce, a nie dopiero po odpowiedzi modelu.
//
// Łapie tylko wyraźny zamiar ułożenia NOWEGO tygodnia. Pierwsza wersja reagowała na samo
// słowo „jadłospis" i prośba „zmieńmy plan posiłków, przelicz jadłospis z obecnego
// tygodnia" wylądowała w trybie planowania — model zaczął wywiad o miniony tydzień zamiast
// przebudować bieżący plan. Fałszywe trafienie kosztuje minuty na mocnym modelu i nie tę
// odpowiedź, więc lepiej przepuścić wątpliwy przypadek do trybu zwykłego: przycisk
// „Zaplanuj następny tydzień" i przełącznik w nagłówku są drogą główną.
const WZORZEC_PLANOWANIA = new RegExp([
  '(nastepny|przyszly|kolejny|nowy|nadchodzacy)\\s+tydzie',
  'nowy\\s+jadlospis',
  'zaplanuj\\w*\\s+(nam\\s+|mi\\s+)?tydzie',
  '(zaplanuj\\w*|uloz\\w*|przygotuj\\w*|zrob\\w*)\\s+(nam\\s+|mi\\s+|nowy\\s+)?(jadlospis|menu|plan\\w*)(\\s+\\S+){0,4}?\\s+tydzie',
  '(jadlospis|menu)\\s+na\\s+(caly\\s+|ten\\s+)?tydzie'
].join('|'));
function wykryjPlanowanie(tekst) {
  const n = String(tekst || '').toLowerCase()
    .replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');
  return WZORZEC_PLANOWANIA.test(n);
}

// ---------------------------------------------------------------- sesje

// Jedno urządzenie = jedna rozmowa. Sesje trzymamy w pamięci; restart serwera
// zaczyna rozmowy od nowa, co dla czatu w kuchni jest całkowicie w porządku.
const sesje = new Map();          // idUrzadzenia -> { sessionId, tryb, kiedy }
const GODZINA = 3600 * 1000;

function sesja(id) {
  const s = sesje.get(id);
  if (!s) return null;
  if (Date.now() - s.kiedy > 12 * GODZINA) { sesje.delete(id); return null; }
  return s;
}

function zapamietaj(id, sessionId, tryb) {
  if (sessionId) sesje.set(id, { sessionId, tryb: tryb || 'zwykly', kiedy: Date.now() });
}

function zapomnij(id) {
  sesje.delete(id);
  ostatnie.delete(id);
}

// ---------------------------------------------------------------- git

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: ROOT, windowsHide: true }, (err, out) => resolve(err ? '' : String(out)));
  });
}

// --porcelain -z, bo bez tego git cytuje ścieżki z polskimi znakami ("jadlospisy/...")
// i nazwa pliku wraca w cudzysłowach, których potem nie da się przekazać do "git add".
// Przy zmianie nazwy git wypisuje dwie ścieżki (nową i starą) — bierzemy obie.
async function zmienionePliki() {
  const out = await git(['status', '--porcelain', '-z']);
  const pola = out.split('\0').filter(Boolean);
  const pliki = [];
  for (let i = 0; i < pola.length; i++) {
    const kod = pola[i].slice(0, 2);
    pliki.push(pola[i].slice(3));
    if (kod[0] === 'R' || kod[0] === 'C') { i++; if (pola[i]) pliki.push(pola[i]); }
  }
  return pliki;
}

/**
 * Commit po turze, która ruszyła pliki — żeby dało się wrócić.
 *
 * Commitujemy **tylko to, co zmieniła ta tura**, wypisując ścieżki wprost. Wcześniej
 * szło tu `git add -A` i pewnego dnia prośba z telefonu o gofry zabrała ze sobą
 * przebudowę układu katalogów, którą ktoś akurat robił na komputerze — commit nazywał
 * się „czat: gofry", a zawierał 27 przeniesionych plików. Praca nie zginęła, ale
 * historia kłamała.
 */
async function zapiszZmiany(prosba, zastane) {
  const wszystkie = await zmienionePliki();
  const moje = wszystkie.filter((f) => zastane.indexOf(f) < 0);
  if (!moje.length) return [];

  const opis = prosba.replace(/\s+/g, ' ').trim().slice(0, 60);
  const tresc = ['Zmiana zlecona z aplikacji domowej.'];
  if (zastane.length) {
    tresc.push('', 'W katalogu leżały wtedy także inne niezapisane zmiany — zostawiam '
      + 'je nietknięte: ' + zastane.join(', ') + '.');
  }
  await git(['add', '--'].concat(moje));
  await git(['commit', '-m', 'czat: ' + opis, '-m', tresc.join('\n'), '--'].concat(moje));
  return moje;
}

// ---------------------------------------------------------------- kolejka

// Jedno wywołanie naraz. Claude Code pisze po tych samych plikach, a dwa procesy
// równolegle potrafiłyby sobie nawzajem nadpisać zmiany w jadłospisie.
let kolejka = Promise.resolve();

function poKolei(fn) {
  const bieg = kolejka.then(fn, fn);
  kolejka = bieg.then(() => {}, () => {});
  return bieg;
}

// ---------------------------------------------------------------- wywołanie CLI

// Argumenty CLI osobno, żeby dało się je sprawdzić w teście bez uruchamiania Claude.
function argumenty(tryb, sessionId) {
  const t = KONTEKST[tryb] ? tryb : 'zwykly';
  const args = [
    '-p',
    '--output-format', 'json',
    '--settings', USTAWIENIA,
    // Serwer Bring! wczytujemy wprost z .mcp.json. Zatwierdzenie serwerów projektu
    // zapisuje się per katalog po kliknięciu w sesji interaktywnej, a tryb -p nie ma
    // jak o nie zapytać — bez tej flagi czat po cichu zostałby bez listy zakupów.
    '--mcp-config', path.join(ROOT, '.mcp.json'),
    '--permission-mode', 'acceptEdits',
    // Model podajemy także przy wznowieniu: sesja planowania ma zostać na swoim modelu.
    '--model', MODELE[t],
    '--append-system-prompt', KONTEKST[t]
  ];
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

function wywolaj(wiadomosc, sessionId, tryb) {
  return new Promise((resolve) => {
    // Treść idzie przez wejście standardowe, a nie argumentem. Na Windowsie argument
    // ze spacjami potrafi zostać rozbity przez powłokę — pierwsza próba dostarczyła
    // z pytania "Co jest zaplanowane na środę" samo "Co".
    const args = argumenty(tryb, sessionId);

    // Bez powłoki — CLI jest ścieżką do pliku wykonywalnego, a cmd tylko psułby
    // cudzysłowy w argumentach (dotyczy to też --append-system-prompt).
    const env = KLUCZ_API ? Object.assign({}, process.env, { ANTHROPIC_API_KEY: KLUCZ_API }) : process.env;
    // spawn potrafi rzucić od razu (plik nie jest programem, brak uprawnień) — nie tylko
    // zgłosić 'error' później. Bez tego wyjątek uciekał z tej obietnicy jako odrzucenie.
    let p;
    try {
      p = spawn(CLI, args, { cwd: ROOT, windowsHide: true, env });
    } catch (e) {
      return resolve({ blad: 'Nie mogę uruchomić Claude Code (' + e.message + ').' });
    }
    let out = '', err = '';
    let zabity = false;

    p.stdin.on('error', () => { /* proces mógł już zniknąć */ });
    p.stdin.end(wiadomosc, 'utf8');

    const limit = LIMIT_MS[KONTEKST[tryb] ? tryb : 'zwykly'];
    const budzik = setTimeout(() => { zabity = true; p.kill(); }, limit);

    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      clearTimeout(budzik);
      resolve({ blad: 'Nie mogę uruchomić Claude Code (' + e.message + ').' });
    });
    p.on('close', () => {
      clearTimeout(budzik);
      if (zabity) return resolve({ blad: 'Odpowiedź nie przyszła w ciągu ' + Math.round(limit / 60000) + ' min. Spróbuj prościej sformułować prośbę.' });

      let d;
      try { d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); }
      catch (e) {
        return resolve({ blad: 'Nieczytelna odpowiedź Claude Code' + (err ? ': ' + err.trim().slice(0, 200) : '.') });
      }

      const tekst = typeof d.result === 'string' ? d.result : '';
      if (d.is_error) {
        if (/not logged in|\/login/i.test(tekst)) {
          return resolve({ blad: 'Claude Code nie jest zalogowany. Na komputerze z aplikacją otwórz terminal, '
            + 'wpisz "claude", a potem "/login" — to jednorazowe.' });
        }
        return resolve({ blad: tekst || 'Claude Code zwrócił błąd.' });
      }
      resolve({ tekst, sessionId: d.session_id, koszt: d.total_cost_usd, ms: d.duration_ms });
    });
  });
}

// ---------------------------------------------------------------- API modułu

// Ostatnia tura per urządzenie — żeby odpowiedź dało się odzyskać, gdy telefon zgasił
// ekran albo ktoś odświeżył stronę, zanim mocny model skończył myśleć. Bez tego odpowiedź
// na pierwszą wiadomość szła w próżnię, a kolejna („halo?") dostawała odpowiedź na tamtą.
const ostatnie = new Map();       // idUrzadzenia -> { wiadomosc, trwa, wynik, kiedy }

function stan(id) {
  const o = ostatnie.get(id);
  if (!o) return { trwa: false, ostatnia: null };
  const ostatnia = { wiadomosc: o.wiadomosc, kiedy: o.kiedy };
  return { trwa: o.trwa, ostatnia: o.trwa ? ostatnia : Object.assign(ostatnia, o.wynik) };
}

function zapytaj(idUrzadzenia, wiadomosc, trybZadany) {
  const tresc = String(wiadomosc || '').trim();
  if (!tresc) return Promise.resolve({ blad: 'Pusta wiadomość.' });
  if (tresc.length > 4000) return Promise.resolve({ blad: 'Wiadomość jest za długa.' });

  // „Trwa" od chwili przyjęcia, nie od startu — w kolejce też się czeka.
  ostatnie.set(idUrzadzenia, { wiadomosc: tresc, trwa: true, wynik: null, kiedy: Date.now() });

  // Każdy wyjątek po drodze (git, spawn, cokolwiek) ma zostać zwykłym błędem tury:
  // inaczej stan „trwa" nigdy by się nie zamknął i przeglądarka pytałaby o niego bez końca.
  return poKolei(() => tura(idUrzadzenia, tresc, trybZadany).catch((e) => {
    const wynik = { blad: 'Czat nie zadziałał: ' + (e && e.message ? e.message : String(e)) };
    const o = ostatnie.get(idUrzadzenia);
    if (o && o.wiadomosc === tresc && o.trwa) ostatnie.set(idUrzadzenia, { wiadomosc: tresc, trwa: false, wynik, kiedy: Date.now() });
    return wynik;
  }));
}

async function tura(idUrzadzenia, tresc, trybZadany) {
  {
    // Zapamiętujemy, co leżało niezapisane już przed turą. Nic nie commitujemy
    // z góry — nieudana tura niczego nie zmienia, więc nie ma czego zapisywać.
    const zastane = await zmienionePliki();

    // Tryb należy do sesji: pierwsza wiadomość go ustala (przycisk w aplikacji albo
    // wykrycie z treści), kolejne go dziedziczą aż do „Nowej rozmowy".
    const s = sesja(idUrzadzenia);
    // Wybór jawny (przycisk albo przełącznik w nagłówku) ma pierwszeństwo przed
    // wykrywaniem z treści — kto kliknął „zwykły", ten chciał zwykły.
    const tryb = s ? s.tryb
      : trybZadany === 'planowanie' ? 'planowanie'
        : trybZadany === 'zwykly' ? 'zwykly'
          : wykryjPlanowanie(tresc) ? 'planowanie' : 'zwykly';

    const w = await wywolaj(tresc, s ? s.sessionId : null, tryb);
    let wynik;
    if (w.blad) {
      wynik = { blad: w.blad, tryb, model: MODELE[tryb] };
    } else {
      zapamietaj(idUrzadzenia, w.sessionId, tryb);
      const moje = await zapiszZmiany(tresc, zastane);
      wynik = { tekst: w.tekst, pliki: moje, ms: w.ms, tryb, model: MODELE[tryb] };
    }
    // Zapisujemy wynik tylko, jeśli w międzyczasie nie przyszła nowsza wiadomość z tego
    // urządzenia — wtedy to ona jest „ostatnią" i to na nią ktoś czeka.
    const o = ostatnie.get(idUrzadzenia);
    if (o && o.wiadomosc === tresc && o.trwa) {
      ostatnie.set(idUrzadzenia, { wiadomosc: tresc, trwa: false, wynik, kiedy: Date.now() });
    }
    return wynik;
  }
}

// Czy CLI w ogóle istnieje i czy jest zalogowane — do komunikatu w interfejsie.
function sprawdz() {
  return new Promise((resolve) => {
    execFile(CLI, ['--version'], { windowsHide: true }, (err, out) => {
      if (err) {
        return resolve({
          ok: false,
          powod: 'Nie znalazłem działającego Claude Code na tym komputerze (szukałem jako "'
            + CLI + '"). Zainstaluj go albo wskaż ścieżkę zmienną PC_CLAUDE.'
        });
      }
      resolve({ ok: true, wersja: String(out).trim(), sciezka: CLI, klucz: !!KLUCZ_API });
    });
  });
}

module.exports = { zapytaj, stan, sprawdz, zapomnij, ustawKluczApi, ustawModele, wykryjPlanowanie, WZORZEC_PLANOWANIA, argumenty, MODELE };
