'use strict';
/**
 * Układ plików PrivateChief — jedno miejsce, które wie, gdzie co leży.
 *
 * Używają go aplikacja webowa i serwer MCP, więc zmiana układu jest zmianą w jednym
 * pliku, a nie polowaniem na ścieżki po całym projekcie.
 *
 *   ksiazka/                           przepisy ulubione — kurowane, stabilne, w gicie
 *   jadlospisy/<tydzien>/
 *     jadlospis.md                     plan tygodnia
 *     przepisy/*.md                    przepisy TEGO tygodnia (kopie z książki albo nowe)
 *     lista-zakupow.md                 zatwierdzona lista
 *   dane/                              stan i cache, poza repozytorium
 *
 * Rozdział książki od tygodnia jest celowy: przepis w książce to wzorzec, do którego
 * wracasz, a przepis w tygodniu to jednorazowe wykonanie. Gdy w środę zabrakło twarogu
 * i poszło tofu, zmienia się kopia tygodniowa — książka zostaje nietknięta. Awans
 * zmiany do książki jest zawsze jawną decyzją człowieka.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- kod i dom
//
// Kod (to repozytorium) i dom (dane jednej rodziny) to dwa różne katalogi. Rozdział
// jest celowy: kod da się aktualizować, kopiować i publikować bez dotykania danych,
// a dom jest jednym katalogiem do kopii zapasowej, z własnym prywatnym gitem.
//
// Dom szukamy w tej kolejności:
//   1. PC_DOM (albo starsze PC_ROOT) — jawnie, np. przy testach na kopii danych;
//   2. bieżący katalog, jeśli wygląda jak dom — tak startuje serwer MCP z sesji
//      Claude Code otwartej w domu i tak działają narzędzia uruchamiane z domu;
//   3. plik dom.txt obok kodu — tak startuje aplikacja z web/start.cmd;
//   4. sam katalog kodu — stary układ, gdy kod i dom były jednym katalogiem.
const KOD = path.join(__dirname, '..');
const PLIK_WSKAZNIKA = path.join(KOD, 'dom.txt');

function jestDomem(d) {
  try {
    return fs.existsSync(path.join(d, 'ustawienia.md'))
      || fs.existsSync(path.join(d, 'rodzina'))
      || fs.existsSync(path.join(d, 'jadlospisy'));
  } catch (e) { return false; }
}

function wskazanyDom() {
  try {
    const p = fs.readFileSync(PLIK_WSKAZNIKA, 'utf8').split(/\r?\n/)[0].trim();
    return p && fs.existsSync(p) ? path.resolve(p) : '';
  } catch (e) { return ''; }
}

function znajdzDom() {
  const env = process.env.PC_DOM || process.env.PC_ROOT;
  // Opisy bez polskich znaków — trafiają na konsolę Windows, która ich nie pokazuje.
  if (env) return { dom: path.resolve(env), skad: 'zmienna PC_DOM' };
  const cwd = path.resolve(process.cwd());
  if (cwd !== path.resolve(KOD) && jestDomem(cwd)) return { dom: cwd, skad: 'biezacy katalog' };
  const w = wskazanyDom();
  if (w) return { dom: w, skad: 'dom.txt obok kodu' };
  return { dom: KOD, skad: jestDomem(KOD) ? 'katalog kodu (stary uklad)' : 'katalog kodu (pusty dom)' };
}

const { dom: ROOT, skad: SKAD_DOM } = znajdzDom();
const DIR_KSIAZKA = path.join(ROOT, 'ksiazka');
const DIR_TYGODNIE = path.join(ROOT, 'jadlospisy');
const DIR_DANE = path.join(ROOT, 'dane');
const DIR_KONFIGURACJA = path.join(ROOT, 'konfiguracja');

// Plik konfiguracji domu (hasła, PIN). Stare miejsce obok kodu honorujemy, żeby
// rozdział kodu od domu nie wymagał ręcznego przenoszenia w tej samej chwili.
function plikKonfiguracji(nazwa, stareMiejsce) {
  const nowy = path.join(DIR_KONFIGURACJA, nazwa);
  if (fs.existsSync(nowy)) return nowy;
  if (stareMiejsce && fs.existsSync(stareMiejsce)) return stareMiejsce;
  return nowy;
}
const PLIK_PLANU = 'jadlospis.md';
const PODKATALOG_PRZEPISOW = 'przepisy';
const PLIK_LISTY = 'lista-zakupow.md';

// ---------------------------------------------------------------- tekst

function norm(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/ł/g, 'l').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function slug(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Nagłówek JSON między "---" (FORMAT.md). Brak nagłówka nie jest błędem — plik
// dopisany ręcznie ma nadal działać, tylko bez danych liczbowych.
function rozbierz(tekst) {
  const t = String(tekst == null ? '' : tekst).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = t.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { meta: {}, tresc: t };
  try {
    const meta = JSON.parse(m[1]);
    return { meta: (meta && typeof meta === 'object') ? meta : {}, tresc: t.slice(m[0].length) };
  } catch (e) {
    return { meta: {}, tresc: t, bladNaglowka: e.message };
  }
}

// ---------------------------------------------------------------- dokumenty

const tytuly = new Map();   // ścieżka -> { mtime, tytul }

function tytulPliku(p, domyslny) {
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch (e) { return domyslny; }
  const c = tytuly.get(p);
  if (c && c.mtime === mtime) return c.tytul;

  let tytul = domyslny;
  try {
    const { meta, tresc } = rozbierz(fs.readFileSync(p, 'utf8'));
    if (meta.tytul) tytul = String(meta.tytul).trim();
    else {
      const m = tresc.slice(0, 3000).match(/^#\s+(.+)$/m);
      if (m) tytul = m[1].replace(/\*\*/g, '').trim();
    }
  } catch (e) { /* zostaje nazwa pliku */ }
  tytuly.set(p, { mtime, tytul });
  return tytul;
}

function dokumenty(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.md$/i.test(f))
    .map((f) => {
      const p = path.join(dir, f);
      const nazwa = f.replace(/\.md$/i, '');
      return { plik: f, sciezka: p, slug: slug(nazwa), tytul: tytulPliku(p, nazwa) };
    })
    .sort((a, b) => a.tytul.localeCompare(b.tytul, 'pl'));
}

// ---------------------------------------------------------------- tygodnie

// Tydzień = katalog w jadlospisy/ zawierający jadlospis.md. Katalogi bez planu
// pomijamy, żeby przypadkowy folder nie udawał tygodnia.
function tygodnie() {
  if (!fs.existsSync(DIR_TYGODNIE)) return [];
  return fs.readdirSync(DIR_TYGODNIE)
    .map((n) => path.join(DIR_TYGODNIE, n))
    .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } })
    .filter((p) => fs.existsSync(path.join(p, PLIK_PLANU)))
    .map((p) => {
      const nazwa = path.basename(p);
      const plan = path.join(p, PLIK_PLANU);
      const { meta } = rozbierz(fs.readFileSync(plan, 'utf8'));
      const zNazwy = nazwa.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
      return {
        slug: nazwa,
        katalog: p,
        plan,
        przepisy: path.join(p, PODKATALOG_PRZEPISOW),
        lista: path.join(p, PLIK_LISTY),
        od: meta.od || (zNazwy ? zNazwy[1] : ''),
        do: meta.do || (zNazwy ? zNazwy[2] : ''),
        tytul: meta.tytul || tytulPliku(plan, nazwa)
      };
    })
    .sort((a, b) => String(a.od).localeCompare(String(b.od)));
}

function tydzien(slugTygodnia) {
  return tygodnie().find((t) => t.slug === slugTygodnia) || null;
}

// Tydzień, w którym jesteśmy: ten obejmujący dziś, a gdy żaden nie obejmuje —
// najbliższy przyszły, a w ostateczności najnowszy. Dzięki temu w sobotę przed
// nowym tygodniem aplikacja pokazuje już ten nadchodzący, a nie zeszły.
function tydzienBiezacy(data) {
  const lista = tygodnie();
  if (!lista.length) return null;
  const d = (data || new Date()).toISOString().slice(0, 10);
  return lista.find((t) => t.od && t.do && t.od <= d && d <= t.do)
    || lista.find((t) => t.od && t.od > d)
    || lista[lista.length - 1];
}

// ---------------------------------------------------------------- przepisy

function przepisyKsiazki() {
  return dokumenty(DIR_KSIAZKA).map((d) => Object.assign({ zrodlo: 'ksiazka' }, d));
}

function przepisyTygodnia(slugTygodnia) {
  const t = tydzien(slugTygodnia);
  if (!t) return [];
  return dokumenty(t.przepisy).map((d) => Object.assign({ zrodlo: 'tydzien', tydzien: t.slug }, d));
}

// Przepis otwieramy wyłącznie po slugu z listy katalogu — nazwa z adresu nigdy nie
// trafia do ścieżki, więc nie ma jak wyjść poza katalog ani sięgnąć po credentials.json.
function przepis(zrodlo, slugPrzepisu, slugTygodnia) {
  const lista = zrodlo === 'ksiazka' ? przepisyKsiazki() : przepisyTygodnia(slugTygodnia);
  const hit = lista.find((d) => d.slug === slug(slugPrzepisu));
  if (!hit) return null;
  const { meta, tresc } = rozbierz(fs.readFileSync(hit.sciezka, 'utf8'));
  return Object.assign({}, hit, { dane: meta, text: tresc });
}

function plan(slugTygodnia) {
  const t = tydzien(slugTygodnia);
  if (!t) return null;
  const { meta, tresc } = rozbierz(fs.readFileSync(t.plan, 'utf8'));
  return { tydzien: t, dane: meta, text: tresc };
}

module.exports = {
  KOD, ROOT, SKAD_DOM, PLIK_WSKAZNIKA, jestDomem, plikKonfiguracji,
  DIR_KSIAZKA, DIR_TYGODNIE, DIR_DANE, DIR_KONFIGURACJA,
  PLIK_PLANU, PODKATALOG_PRZEPISOW, PLIK_LISTY,
  norm, slug, rozbierz, dokumenty,
  tygodnie, tydzien, tydzienBiezacy,
  przepisyKsiazki, przepisyTygodnia, przepis, plan
};
