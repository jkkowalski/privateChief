'use strict';
/**
 * Pamięć aplikacji: które składniki danego przepisu są już załatwione.
 *
 * „Załatwiony" znaczy „nie trzeba tego kupować" i jest to stan TRWAŁY — inaczej niż
 * obecność na liście Bring!, która znika w chwili zrobienia zakupów. Gdyby ptaszek
 * zależał tylko od listy, po powrocie ze sklepu wszystkie składniki odhaczyłyby się
 * z powrotem i aplikacja proponowałaby kupić je drugi raz.
 *
 * Stan trzymamy po stronie serwera, a nie w telefonie, żeby domownicy widzieli to samo:
 * jedna osoba dopisuje składniki, druga nie ogląda ich jako brakujących.
 *
 * Plik: web/stan-przepisow.json  (poza repozytorium — to stan działania, nie dane rodziny)
 *   { "<slug-przepisu>": { "<nazwa składnika>": { zalatwione: true|false, kiedy: ISO } } }
 */

const fs = require('fs');
const path = require('path');

const PLIK = process.env.PC_STAN || path.join(__dirname, 'stan-przepisow.json');

let pamiec = null;

function wczytaj() {
  if (pamiec) return pamiec;
  try {
    pamiec = JSON.parse(fs.readFileSync(PLIK, 'utf8'));
    if (!pamiec || typeof pamiec !== 'object') pamiec = {};
  } catch (e) {
    pamiec = {};                       // brak pliku albo śmieci — zaczynamy od zera
  }
  return pamiec;
}

// Zapis przez plik tymczasowy, żeby przerwanie w trakcie nie zostawiło ogryzka,
// którego następny start nie potrafiłby wczytać.
function zapisz() {
  const tmp = PLIK + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pamiec, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, PLIK);
}

function dlaPrzepisu(slug) {
  const p = wczytaj();
  return p[slug] || {};
}

// stan === null kasuje wpis i przywraca zachowanie domyślne (spiżarnia / lista Bring!).
function ustaw(slug, nazwa, stan) {
  const p = wczytaj();
  if (!p[slug]) p[slug] = {};
  if (stan === null) delete p[slug][nazwa];
  else p[slug][nazwa] = { zalatwione: !!stan, kiedy: new Date().toISOString() };
  if (!Object.keys(p[slug]).length) delete p[slug];
  zapisz();
}

function ustawWiele(slug, nazwy, stan) {
  const p = wczytaj();
  if (!p[slug]) p[slug] = {};
  const kiedy = new Date().toISOString();
  nazwy.forEach((n) => { p[slug][n] = { zalatwione: !!stan, kiedy }; });
  zapisz();
}

function wyczysc(slug) {
  const p = wczytaj();
  delete p[slug];
  zapisz();
}

module.exports = { dlaPrzepisu, ustaw, ustawWiele, wyczysc, PLIK };
