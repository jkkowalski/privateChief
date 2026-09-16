'use strict';
/**
 * Książka kucharska: awans przepisu z tygodnia i usunięcie go z książki.
 *
 * Kopiujemy, a nie przenosimy ani linkujemy. Przepis w tygodniu to zapis jednego
 * gotowania i wolno go zmieniać („zabrakło twarogu, poszło tofu"); przepis w książce
 * to wzorzec, do którego wracacie. Gdyby to był ten sam plik, poprawka na środę
 * po cichu zmieniałaby ulubioną sałatkę na zawsze.
 *
 * Każda zmiana książki dostaje własny commit — książka jest w repozytorium właśnie
 * po to, żeby dało się cofnąć skasowanie i zobaczyć, jak przepis dojrzewał.
 * Commitujemy WYŁĄCZNIE ścieżkę, której dotyczy zmiana, żeby nie zgarnąć cudzej
 * niezapisanej pracy leżącej obok.
 *
 * Czat tu nie sięga (web/czat-uprawnienia.json) — do książki dodaje człowiek
 * przyciskiem, świadomie.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const U = require('./uklad.js');

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: U.ROOT, windowsHide: true },
      (err, out) => resolve(err ? '' : String(out)));
  });
}

async function commit(sciezkaWzgledna, opis) {
  await git(['add', '--', sciezkaWzgledna]);
  await git(['commit', '-m', opis, '--', sciezkaWzgledna]);
}

const wzgledna = (p) => path.relative(U.ROOT, p).split(path.sep).join('/');

// Nazwa pliku w książce bierze się z tytułu, nie ze sluga — ludzie szukają po nazwie
// w katalogu, a nie po adresie URL.
// Tytuł przychodzi z telefonu, więc nie może decydować o ścieżce: wycinamy separatory
// katalogów i znaki zakazane w Windows, a kropki z brzegów ucinamy, żeby ".." nie
// wyprowadziło zapisu poza książkę.
function nazwaPliku(tytul) {
  const zakazane = '<>:"|?*/' + String.fromCharCode(92);
  let s = String(tytul == null ? '' : tytul).split('')
    .map((c) => (zakazane.indexOf(c) >= 0 || c.charCodeAt(0) < 32) ? ' ' : c)
    .join('').split(' ').filter(Boolean).join(' ');
  while (s && s[0] === '.') s = s.slice(1).trim();
  while (s && s[s.length - 1] === '.') s = s.slice(0, -1).trim();
  return (s.slice(0, 80) || 'przepis') + '.md';
}

function wolnaNazwa(tytul) {
  const baza = String(tytul || 'przepis').trim();
  for (let i = 1; i < 50; i++) {
    const kandydat = i === 1 ? baza : baza + ' (' + i + ')';
    if (!fs.existsSync(path.join(U.DIR_KSIAZKA, nazwaPliku(kandydat)))) return kandydat;
  }
  return baza + ' ' + Date.now();
}

// Tytuł siedzi w dwóch miejscach naraz: w nagłówku JSON i w "# " na górze treści.
// Zapisując pod inną nazwą, poprawiamy oba, żeby plik nie kłamał sam o sobie.
function zTytulem(tekst, tytul) {
  const { meta, tresc } = U.rozbierz(tekst);
  const nowa = Object.assign({}, meta, { tytul });
  const body = tresc.replace(/^#\s+.*$/m, '# ' + tytul);
  return Object.keys(meta).length
    ? '---\n' + JSON.stringify(nowa, null, 2) + '\n---\n' + body
    : '# ' + tytul + '\n' + body.replace(/^#\s+.*\n?/, '');
}

/**
 * Awans przepisu tygodnia do książki.
 *
 * Bez `tytul` sprawdzamy kolizję i — jeśli jest — nic nie zapisujemy, tylko oddajemy
 * propozycję nowej nazwy. To człowiek decyduje, czy to inny przepis o tej samej nazwie,
 * czy poprawiona wersja tego samego; aplikacja nie zgaduje i nie nadpisuje.
 */
async function dodaj(slugTygodnia, slugPrzepisu, tytul) {
  const doc = U.przepis('tydzien', slugPrzepisu, slugTygodnia);
  if (!doc) return { blad: 'Nie ma takiego przepisu w tym tygodniu.' };

  const chciany = String(tytul || '').trim() || doc.tytul;
  const cel = path.join(U.DIR_KSIAZKA, nazwaPliku(chciany));

  if (fs.existsSync(cel)) {
    if (!tytul) return { kolizja: true, tytul: chciany, propozycja: wolnaNazwa(chciany) };
    return { blad: 'W książce jest już przepis o tej nazwie.' };
  }

  const tekst = fs.readFileSync(doc.sciezka, 'utf8');
  fs.mkdirSync(U.DIR_KSIAZKA, { recursive: true });
  fs.writeFileSync(cel, chciany === doc.tytul ? tekst : zTytulem(tekst, chciany), 'utf8');

  await commit(wzgledna(cel), 'ksiazka: ' + chciany);
  return { ok: true, tytul: chciany, slug: U.slug(path.basename(cel, '.md')) };
}

async function usun(slugPrzepisu) {
  const doc = U.przepis('ksiazka', slugPrzepisu);
  if (!doc) return { blad: 'Nie ma takiego przepisu w książce.' };

  fs.unlinkSync(doc.sciezka);
  await commit(wzgledna(doc.sciezka), 'ksiazka: usuniety ' + doc.tytul);
  return { ok: true, tytul: doc.tytul };
}

module.exports = { dodaj, usun, nazwaPliku, wolnaNazwa };
