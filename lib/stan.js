'use strict';
/**
 * Pamięć aplikacji: które składniki są już załatwione.
 *
 * Klucz to **tydzień i przepis**, nie sam przepis. Dzięki temu nowy tydzień startuje
 * czysto sam z siebie — gdy leczo wraca za miesiąc, ptaszki z września go nie dotyczą
 * i nikt nie musi pamiętać o czyszczeniu. Wcześniej trzeba było i właśnie o tym się
 * zapominało.
 *
 * „Załatwiony" znaczy „nie trzeba tego kupować" i jest to stan TRWAŁY — inaczej niż
 * obecność na liście Bring!, która znika po zrobieniu zakupów. Gdyby ptaszek zależał
 * od listy, po powrocie ze sklepu wszystko odhaczyłoby się z powrotem.
 *
 * Stan trzyma serwer, a nie telefon, żeby domownicy widzieli to samo.
 *
 * Plik: dane/stan-przepisow.json (poza repozytorium — to stan działania, nie treść)
 *   { "<tydzien>/<przepis>": { "<nazwa składnika>": { zalatwione, kiedy } } }
 */

const fs = require('fs');
const path = require('path');
const U = require('./uklad.js');

const PLIK = process.env.PC_STAN || path.join(U.DIR_DANE, 'stan-przepisow.json');

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
  try {
    fs.mkdirSync(path.dirname(PLIK), { recursive: true });
    const tmp = PLIK + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(pamiec, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, PLIK);
  } catch (e) {
    process.stderr.write('[stan] nie udało się zapisać: ' + e.message + '\n');
  }
}

const klucz = (tydzien, przepis) => String(tydzien || '?') + '/' + String(przepis || '?');

function dlaPrzepisu(tydzien, przepis) {
  return wczytaj()[klucz(tydzien, przepis)] || {};
}

// stan === null kasuje wpis i przywraca zachowanie domyślne (spiżarnia).
function ustaw(tydzien, przepis, nazwa, stan) {
  const p = wczytaj();
  const k = klucz(tydzien, przepis);
  if (!p[k]) p[k] = {};
  if (stan === null) delete p[k][nazwa];
  else p[k][nazwa] = { zalatwione: !!stan, kiedy: new Date().toISOString() };
  if (!Object.keys(p[k]).length) delete p[k];
  zapisz();
}

function ustawWiele(tydzien, przepis, nazwy, stan) {
  const p = wczytaj();
  const k = klucz(tydzien, przepis);
  if (!p[k]) p[k] = {};
  const kiedy = new Date().toISOString();
  nazwy.forEach((n) => { p[k][n] = { zalatwione: !!stan, kiedy }; });
  zapisz();
}

function wyczysc(tydzien, przepis) {
  const p = wczytaj();
  delete p[klucz(tydzien, przepis)];
  zapisz();
}

module.exports = { dlaPrzepisu, ustaw, ustawWiele, wyczysc, PLIK };
