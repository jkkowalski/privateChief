#!/usr/bin/env node
'use strict';
/**
 * Kontrola zgodności plików z FORMAT.md.
 *
 *   node narzedzia/sprawdz.js
 *
 * Puszczaj po ręcznych poprawkach w plikach i po zmianach w skillu. Wypisuje to,
 * czego aplikacja nie zrozumie — zanim zauważysz to na telefonie w kuchni.
 *
 * Kod wyjścia 1, gdy są błędy; ostrzeżenia nie psują kodu wyjścia.
 */

const fs = require('fs');
const path = require('path');

const U = require('../lib/uklad.js');
const SKL = require('../lib/skladniki.js');
const ALERGENY = require('../lib/alergeny.js');

const bledy = [];
const ostrzezenia = [];
const wykluczenia = [];
const blad = (plik, tekst) => bledy.push(plik + ': ' + tekst);
const ostrzez = (plik, tekst) => ostrzezenia.push(plik + ': ' + tekst);

function rozbierz(plik) {
  const t = fs.readFileSync(plik, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = t.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { meta: null, tresc: t };
  try {
    return { meta: JSON.parse(m[1]), tresc: t.slice(m[0].length) };
  } catch (e) {
    return { meta: undefined, tresc: t, blad: e.message };
  }
}

const liczba = (v) => typeof v === 'number' && isFinite(v);

// ---------------------------------------------------------------- przepisy

const POLA_PRZEPISU = {
  tytul: 'tekst', porcje: 'liczba', porcje_uwaga: 'tekst',
  czas_aktywny_min: 'liczba', czas_calkowity_min: 'liczba',
  trudnosc: 'tekst', bialko_g: 'liczba', kcal: 'obiekt', tagi: 'lista'
};

function sprawdzPrzepis(plik, nazwa) {
  const { meta, tresc, blad: bJson } = rozbierz(plik);

  if (meta === undefined) { blad(nazwa, 'nagłówek nie jest poprawnym JSON-em — ' + bJson); return; }
  if (meta === null) { ostrzez(nazwa, 'brak nagłówka JSON (czytany po staremu) — uruchom narzedzia/migruj.js'); return; }
  if (!meta.tytul) blad(nazwa, 'brak pola "tytul"');

  Object.keys(meta).forEach((k) => {
    const typ = POLA_PRZEPISU[k];
    if (!typ) { ostrzez(nazwa, 'nieznane pole "' + k + '" — aplikacja je zignoruje'); return; }
    const v = meta[k];
    const ok = typ === 'liczba' ? liczba(v)
      : typ === 'lista' ? Array.isArray(v)
      : typ === 'obiekt' ? (v && typeof v === 'object' && !Array.isArray(v))
      : typeof v === 'string';
    if (!ok) blad(nazwa, 'pole "' + k + '" powinno być typu ' + typ);
  });
  if (meta.kcal) {
    Object.keys(meta.kcal).forEach((kto) => {
      if (!liczba(meta.kcal[kto])) blad(nazwa, 'kcal."' + kto + '" nie jest liczbą');
    });
  }

  // Składniki
  const linie = tresc.split('\n');
  let wSekcji = false, ile = 0, zbiorcze = 0;
  linie.forEach((l) => {
    if (/^##\s+/.test(l)) { wSekcji = /^##\s+Składniki/i.test(l); return; }
    if (!wSekcji) return;
    const m = l.match(/^\s*[-*+]\s+(.*)$/);
    if (!m) return;
    const t = m[1].trim();
    if (!t) return;
    if (t.indexOf('|') < 0) {
      // Sama nazwa bez ilości jest w porządku ("- sól"). Zgłaszamy dopiero to,
      // co wyglada na kilka produktow albo na stary zapis z myslnikiem.
      if (/[;—–]|^[^:]{2,30}:\s*\S/.test(t) || t.split(/\s+/).length > 3) {
        zbiorcze++;
        ostrzez(nazwa, 'składnik poza formatem "nazwa | ilość": "' + t.slice(0, 58) + '"');
      } else ile++;
      return;
    }
    const pola = t.split('|').map((x) => x.trim());
    ile++;
    if (!pola[0]) blad(nazwa, 'składnik bez nazwy: "' + t.slice(0, 40) + '"');
    if (pola[0] && pola[0].split(/\s+/).length > 5) {
      ostrzez(nazwa, 'nazwa składnika wygląda na zdanie: "' + pola[0].slice(0, 48) + '"');
    }
    pola.slice(2).join(',').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
      .forEach((z) => {
        if (['spiżarnia', 'opcjonalnie'].indexOf(z) < 0) ostrzez(nazwa, 'nieznany znacznik "' + z + '"');
      });
  });
  if (!ile && !zbiorcze) ostrzez(nazwa, 'nie znalazłem sekcji "## Składniki"');

  // Wykluczenia z rodzina/domownicy.md sprawdzone na składnikach — to samo sito, które
  // aplikacja pokazuje w przepisie. Tu, żeby dało się je złapać przed ugotowaniem.
  ALERGENY.trafienia(SKL.skladniki(tresc)).forEach((t) => {
    wykluczenia.push(nazwa + ': ' + ALERGENY.opisTrafienia(t));
  });
  return { ile, zbiorcze };
}

// ---------------------------------------------------------------- jadłospisy

function sprawdzPlan(plik, slugi, nazwa) {
  const { meta, tresc, blad: bJson } = rozbierz(plik);

  if (meta === undefined) { blad(nazwa, 'nagłówek nie jest poprawnym JSON-em — ' + bJson); return; }
  if (meta === null) { ostrzez(nazwa, 'brak nagłówka JSON — uruchom narzedzia/migruj.js'); return; }
  ['od', 'do'].forEach((k) => {
    if (meta[k] && !/^\d{4}-\d{2}-\d{2}$/.test(meta[k])) blad(nazwa, 'pole "' + k + '" nie jest datą RRRR-MM-DD');
  });

  const linie = tresc.split('\n');
  let od = -1, doo = -1;
  for (let i = 0; i < linie.length; i++) {
    if (!/^\s*\|/.test(linie[i])) continue;
    let j = i;
    while (j < linie.length && /^\s*\|/.test(linie[j])) j++;
    const blok = linie.slice(i, j).join('\n');
    if (/dzień/i.test(blok) && /danie/i.test(blok)) { od = i; doo = j; break; }
    i = j;
  }
  if (od < 0) { blad(nazwa, 'nie znalazłem tabeli posiłków (kolumny "Dzień" i "Danie")'); return; }

  const kom = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const naglowki = kom(linie[od]).map((c) => c.toLowerCase());
  ['data', 'przepis'].forEach((k) => {
    if (naglowki.findIndex((c) => c.indexOf(k) === 0) < 0) {
      ostrzez(nazwa, 'tabela nie ma kolumny "' + k + '" — aplikacja wróci do zgadywania');
    }
  });
  const iData = naglowki.findIndex((c) => c.indexOf('data') === 0);
  const iPrzepis = naglowki.findIndex((c) => c.indexOf('przepis') === 0);
  const iDanie = naglowki.findIndex((c) => c.indexOf('danie') === 0);

  let posilki = 0, bezPrzepisu = 0;
  linie.slice(od + 1, doo).forEach((l) => {
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(l)) return;
    const c = kom(l);
    if (c.length < 3) return;
    posilki++;
    if (iData >= 0 && c[iData] && !/^\d{4}-\d{2}-\d{2}$/.test(c[iData])) {
      blad(nazwa, 'data "' + c[iData] + '" nie jest w formacie RRRR-MM-DD');
    }
    if (iPrzepis >= 0) {
      const s = c[iPrzepis];
      if (!s) { bezPrzepisu++; ostrzez(nazwa, 'bez przepisu: "' + (c[iDanie] || '').slice(0, 44) + '"'); }
      else if (slugi.indexOf(s) < 0) blad(nazwa, 'kolumna Przepis wskazuje na nieistniejący plik: "' + s + '"');
    }
  });
  return { posilki, bezPrzepisu };
}

// ---------------------------------------------------------------- start

const pliki = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.md$/i.test(f)) : []);

let skladniki = 0, zbiorcze = 0, posilki = 0, ilePrzepisow = 0;

// Każdy tydzień sprawdzamy osobno: kolumna "Przepis" w planie ma wskazywać plik
// z TEGO tygodnia, a nie z dowolnego miejsca w projekcie.
const tygodnie = U.tygodnie();
tygodnie.forEach((t) => {
  const katalog = 'jadlospisy/' + t.slug + '/';
  const przepisy = pliki(t.przepisy);
  ilePrzepisow += przepisy.length;

  przepisy.forEach((f) => {
    const r = sprawdzPrzepis(path.join(t.przepisy, f), katalog + 'przepisy/' + f);
    if (r) { skladniki += r.ile; zbiorcze += r.zbiorcze; }
  });

  const r = sprawdzPlan(t.plan, przepisy.map((f) => f.replace(/\.md$/i, '')), katalog + 'jadlospis.md');
  if (r) posilki += r.posilki;
});

// Książka nie należy do żadnego tygodnia i nie ma planu — sprawdzamy same przepisy.
const ksiazka = pliki(U.DIR_KSIAZKA);
ksiazka.forEach((f) => {
  const r = sprawdzPrzepis(path.join(U.DIR_KSIAZKA, f), 'ksiazka/' + f);
  if (r) { skladniki += r.ile; zbiorcze += r.zbiorcze; }
});

console.log('\n  Książka:    ' + ksiazka.length + ' przepisów');
console.log('  Tygodnie:   ' + tygodnie.length + ', w nich ' + ilePrzepisow + ' przepisów i '
  + posilki + ' posiłków');
console.log('  Składniki:  ' + skladniki + ' w formacie'
  + (zbiorcze ? ', ' + zbiorcze + ' linii poza formatem' : ''));

if (bledy.length) {
  console.log('\n  BŁĘDY (' + bledy.length + ') — aplikacja tego nie zrozumie:');
  bledy.forEach((b) => console.log('    - ' + b));
}
if (ostrzezenia.length) {
  console.log('\n  Do przejrzenia (' + ostrzezenia.length + '):');
  ostrzezenia.forEach((o) => console.log('    - ' + o));
}
// Osobno i na końcu, bo to jedyna rzecz tutaj, przez którą ktoś może wylądować w szpitalu.
if (wykluczenia.length) {
  console.log('\n  WYKLUCZENIA (' + wykluczenia.length + ') — składniki, których ktoś w domu nie może jeść:');
  wykluczenia.forEach((w) => console.log('    - ' + w));
  console.log('    (sprawdzane: ' + ALERGENY.opisDeklaracji() + ')');
}
if (!bledy.length && !ostrzezenia.length && !wykluczenia.length) console.log('\n  Wszystko zgodne z FORMAT.md.');
console.log('');

process.exitCode = (bledy.length || wykluczenia.length) ? 1 : 0;
