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
const LIMIT_MS = Number(process.env.PC_CZAT_TIMEOUT || 240000);

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

const KONTEKST = [
  'Rozmawiasz przez aplikację domową PrivateChief z domownikiem, który trzyma telefon',
  'w kuchni — być może w trakcie gotowania. Odpowiadaj po polsku, krótko i konkretnie,',
  'zwykłym tekstem bez nagłówków i tabel; kilka zdań wystarczy.',
  'Rozmówcą bywa dziecko albo gość, więc nie zakładaj wiedzy o plikach ani o tym projekcie.',
  'Gdy prosi o zmianę w jadłospisie lub przepisie — wykonaj ją i powiedz jednym zdaniem,',
  'co zmieniłeś. Gdy prosi o zakupy — dopisz do listy Bring! i powiedz, co doszło.',
  'Nie pytaj o potwierdzenie przy drobiazgach; pytaj tylko wtedy, gdy bez odpowiedzi',
  'zrobiłbyś coś nieodwracalnego albo wyraźnie wbrew profilowi rodziny (alergie, diety).'
].join(' ');

// ---------------------------------------------------------------- sesje

// Jedno urządzenie = jedna rozmowa. Sesje trzymamy w pamięci; restart serwera
// zaczyna rozmowy od nowa, co dla czatu w kuchni jest całkowicie w porządku.
const sesje = new Map();          // idUrzadzenia -> { sessionId, kiedy }
const GODZINA = 3600 * 1000;

function sesja(id) {
  const s = sesje.get(id);
  if (!s) return null;
  if (Date.now() - s.kiedy > 12 * GODZINA) { sesje.delete(id); return null; }
  return s.sessionId;
}

function zapamietaj(id, sessionId) {
  if (sessionId) sesje.set(id, { sessionId, kiedy: Date.now() });
}

function zapomnij(id) {
  sesje.delete(id);
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

function wywolaj(wiadomosc, sessionId) {
  return new Promise((resolve) => {
    // Treść idzie przez wejście standardowe, a nie argumentem. Na Windowsie argument
    // ze spacjami potrafi zostać rozbity przez powłokę — pierwsza próba dostarczyła
    // z pytania "Co jest zaplanowane na środę" samo "Co".
    const args = [
      '-p',
      '--output-format', 'json',
      '--settings', USTAWIENIA,
      // Serwer Bring! wczytujemy wprost z .mcp.json. Zatwierdzenie serwerów projektu
      // zapisuje się per katalog po kliknięciu w sesji interaktywnej, a tryb -p nie ma
      // jak o nie zapytać — bez tej flagi czat po cichu zostałby bez listy zakupów.
      '--mcp-config', path.join(ROOT, '.mcp.json'),
      '--permission-mode', 'acceptEdits',
      '--append-system-prompt', KONTEKST
    ];
    if (sessionId) args.push('--resume', sessionId);

    // Bez powłoki — CLI jest ścieżką do pliku wykonywalnego, a cmd tylko psułby
    // cudzysłowy w argumentach (dotyczy to też --append-system-prompt).
    const env = KLUCZ_API ? Object.assign({}, process.env, { ANTHROPIC_API_KEY: KLUCZ_API }) : process.env;
    const p = spawn(CLI, args, { cwd: ROOT, windowsHide: true, env });
    let out = '', err = '';
    let zabity = false;

    p.stdin.on('error', () => { /* proces mógł już zniknąć */ });
    p.stdin.end(wiadomosc, 'utf8');

    const budzik = setTimeout(() => { zabity = true; p.kill(); }, LIMIT_MS);

    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      clearTimeout(budzik);
      resolve({ blad: 'Nie mogę uruchomić Claude Code (' + e.message + ').' });
    });
    p.on('close', () => {
      clearTimeout(budzik);
      if (zabity) return resolve({ blad: 'Odpowiedź nie przyszła w ciągu ' + Math.round(LIMIT_MS / 1000) + ' s. Spróbuj prościej sformułować prośbę.' });

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

function zapytaj(idUrzadzenia, wiadomosc) {
  return poKolei(async () => {
    const tresc = String(wiadomosc || '').trim();
    if (!tresc) return { blad: 'Pusta wiadomość.' };
    if (tresc.length > 4000) return { blad: 'Wiadomość jest za długa.' };

    // Zapamiętujemy, co leżało niezapisane już przed turą. Nic nie commitujemy
    // z góry — nieudana tura niczego nie zmienia, więc nie ma czego zapisywać.
    const zastane = await zmienionePliki();

    const w = await wywolaj(tresc, sesja(idUrzadzenia));
    if (w.blad) return { blad: w.blad };

    zapamietaj(idUrzadzenia, w.sessionId);
    const moje = await zapiszZmiany(tresc, zastane);
    return { tekst: w.tekst, pliki: moje, ms: w.ms };
  });
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

module.exports = { zapytaj, sprawdz, zapomnij, ustawKluczApi };
