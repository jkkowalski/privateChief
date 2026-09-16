'use strict';
/**
 * Składniki przepisu i to, czego z nich naprawdę trzeba kupić.
 *
 * Jedno miejsce dla aplikacji i serwera MCP. Wcześniej ta wiedza siedziała w web/app.js
 * i tylko aplikacja umiała jej użyć — czat, pytany „czego brakuje do leczo", zgadywał
 * z treści pliku i nie widział ptaszków.
 *
 * Ptaszek znaczy „nie trzeba kupować" i bierze się z trzech źródeł, w tej kolejności:
 *   1. zapamiętana decyzja (dane/stan-przepisow.json) — trwała, przeżywa zakupy,
 *   2. znacznik „spiżarnia" przy składniku — co wiedział autor przepisu,
 *   3. rodzina/spizarnia.md — co stoi w szafce dzisiaj.
 *
 * Stan liczymy WYŁĄCZNIE per przepis. Obecność pozycji na liście Bring! nie odhacza jej
 * w innych przepisach: gdy jedno danie potrzebuje 500 g pomidorów, a drugie 2 sztuk,
 * to drugie musi dopisać swoje — inaczej jego ilość nigdy nie doliczy się do listy
 * i w sklepie zabraknie.
 */

const fs = require('fs');
const path = require('path');
const U = require('./uklad.js');
const STAN = require('./stan.js');
const B = require('../mcp/bring/bring.js');

// "- nazwa | ilość | znacznik". Stary zapis "- nazwa — ilość (spiżarnia)" czytamy
// dalej, ale bez rozbijania linii zbiorczych — jedna linia to jeden składnik.
function skladniki(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inside = false;

  for (const line of lines) {
    if (/^##\s+/.test(line)) { inside = /^##\s+Składniki/i.test(line); continue; }
    if (!inside) continue;
    const m = line.match(/^\s*[-*+]\s+(.*)$/);
    if (!m) continue;
    const tresc = m[1].replace(/\*\*/g, '').trim();
    if (!tresc) continue;

    if (tresc.indexOf('|') >= 0) {
      const pola = tresc.split('|').map((x) => x.trim());
      const znaczniki = pola.slice(2).join(',').toLowerCase();
      if (!pola[0]) continue;
      out.push({
        name: pola[0],
        specification: pola[1] || '',
        spizarnia: /spiżarni/.test(znaczniki),
        zbiorcza: false
      });
      continue;
    }

    const zbiorcza = /;/.test(tresc) || /^[^:]{2,30}:\s*\S/.test(tresc);
    const czesci = tresc.split(/\s+[—–]\s+|\s+-\s+/);
    out.push({
      name: czesci[0].trim(),
      specification: czesci.length > 1 ? czesci.slice(1).join(', ').trim() : '',
      spizarnia: /\((?:ze\s+)?spiżarni/i.test(tresc),
      zbiorcza,
      surowa: zbiorcza ? tresc : ''
    });
  }
  return out;
}

// ---------------------------------------------------------------- spiżarnia domu
//
// Spiżarnia jest własnością domu, nie przepisu. Znacznik przy składniku mówi, co
// wiedział autor przepisu; rodzina/spizarnia.md mówi, co stoi w szafce dzisiaj.

const PLIK_SPIZARNI = path.join(U.ROOT, 'rodzina', 'spizarnia.md');
let spizarniaCache = null;

function spizarniaDomu() {
  let mtime = 0;
  try { mtime = fs.statSync(PLIK_SPIZARNI).mtimeMs; } catch (e) { return []; }
  if (spizarniaCache && spizarniaCache.mtime === mtime) return spizarniaCache.nazwy;

  const nazwy = [];
  let pomijamy = false;
  try {
    fs.readFileSync(PLIK_SPIZARNI, 'utf8').replace(/\r\n/g, '\n').split('\n').forEach((l) => {
      const h = l.match(/^##\s+(.*)$/);
      if (h) { pomijamy = /do ustalenia/i.test(h[1]); return; }
      if (pomijamy) return;
      const m = l.match(/^\s*[-*+]\s+(.*)$/);
      if (!m) return;
      let tresc = m[1].split(/\s+[—–]\s+|\s+-\s+|:/)[0].replace(/\*\*/g, '').trim();
      tresc = tresc.replace(/\([^)]*\)/g, ' ').trim();
      if (!tresc) return;
      tresc.split(',').map((x) => x.trim()).filter(Boolean).forEach((n) => {
        const nn = U.norm(n);
        if (nn && nazwy.indexOf(nn) < 0) nazwy.push(nn);
      });
    });
  } catch (e) { return []; }

  spizarniaCache = { mtime, nazwy };
  return nazwy;
}

function wSpizarniDomu(nazwa, cat) {
  const lista = spizarniaDomu();
  if (!lista.length) return false;

  const n = U.norm(nazwa);
  if (lista.indexOf(n) >= 0) return true;
  const klucz = B.toKey(cat, nazwa);

  return lista.some((wpis) => {
    const k = B.toKey(cat, wpis);
    // Oba znane katalogowi: rozstrzyga katalog. Ten sam klucz to ten sam produkt
    // ("Mleko" wobec "mleko 2%"), różne klucze to różne produkty — "Ocet" nie ma
    // odhaczać "octu balsamicznego", bo rodzina mówiła o tym zwykłym.
    if (klucz.matched && k.matched) return k.key === klucz.key;
    return (wpis.length >= 4 && n.indexOf(wpis + ' ') === 0)
      || (n.length >= 4 && wpis.indexOf(n + ' ') === 0);
  });
}

// ---------------------------------------------------------------- stan przepisu

/**
 * Znajduje przepis w tygodniu po nazwie z rozmowy.
 *
 * Człowiek mówi „leczo", a plik nazywa się „leczo-z-indykiem-cukinia-i-ciecierzyca".
 * Dopasowujemy najpierw dokładnie, potem po początku nazwy, na końcu po zawieraniu —
 * i tylko wtedy, gdy pasuje DOKŁADNIE jeden przepis. Przy dwóch kandydatach wolimy
 * powiedzieć „doprecyzuj" niż ugotować coś innego, niż prosili.
 */
function znajdzPrzepis(tydzien, tekst) {
  if (!U.tydzien(tydzien)) {
    return { blad: 'Nie ma takiego tygodnia: ' + tydzien + '. Są: '
      + (U.tygodnie().map((t) => t.slug).join('; ') || 'żaden') + '.' };
  }
  const lista = U.przepisyTygodnia(tydzien);
  if (!lista.length) return { blad: 'Tydzień ' + tydzien + ' nie ma przepisów.' };

  const s = U.slug(tekst);
  const n = U.norm(tekst);
  if (!n) return { blad: 'Nie podano nazwy przepisu.' };

  const proby = [
    lista.filter((d) => d.slug === s),
    lista.filter((d) => d.slug.indexOf(s) === 0 || U.norm(d.tytul).indexOf(n) === 0),
    lista.filter((d) => d.slug.indexOf(s) >= 0 || U.norm(d.tytul).indexOf(n) >= 0)
  ];
  for (const trafione of proby) {
    if (trafione.length === 1) return { slug: trafione[0].slug, tytul: trafione[0].tytul };
    if (trafione.length > 1) {
      return { blad: 'Pasuje kilka przepisów: ' + trafione.map((d) => d.tytul).join('; ')
        + '. Doprecyzuj który.' };
    }
  }
  return { blad: 'Nie ma takiego przepisu w tygodniu ' + tydzien + '. Są: '
    + lista.map((d) => d.tytul).join('; ') + '.' };
}

// Przepis otwieramy zawsze z tygodnia. Książkowy wzorzec nie należy do żadnego
// tygodnia, więc nie ma do czego przypiąć ani ptaszków, ani zakupów.
function otworz(tydzien, przepis) {
  if (!U.tydzien(tydzien)) return { blad: 'Nie ma takiego tygodnia: ' + tydzien + '.' };
  const doc = U.przepis('tydzien', przepis, tydzien);
  if (!doc) {
    const znaleziony = znajdzPrzepis(tydzien, przepis);
    return { blad: znaleziony.blad || 'Nie ma takiego przepisu w tygodniu ' + tydzien + '.' };
  }
  return { doc };
}

// Zwraca listę składników z informacją, czy trzeba je kupić. Katalog Bring! służy tu
// wyłącznie do porównywania nazw ze spiżarnią domu — nie odpytujemy listy zakupów.
async function stan(tydzien, przepis) {
  const { doc, blad } = otworz(tydzien, przepis);
  if (blad) return { blad };

  const zapis = STAN.dlaPrzepisu(tydzien, przepis);
  const cat = await B.getCatalog(B.loadCredentials().language);

  return {
    doc,
    skladniki: skladniki(doc.text).map((s) => {
      const wspolne = { name: s.name, specification: s.specification };
      const z = zapis[s.name];
      if (z) return Object.assign(wspolne, { odhaczony: z.zalatwione, powod: 'dopisane z tego przepisu' });
      if (s.spizarnia) return Object.assign(wspolne, { odhaczony: true, powod: 'spiżarnia' });
      if (wSpizarniDomu(s.name, cat)) return Object.assign(wspolne, { odhaczony: true, powod: 'spiżarnia domu' });
      return Object.assign(wspolne, { odhaczony: false, powod: null });
    })
  };
}

/**
 * Dopisuje na listę to, czego brakuje, i zapamiętuje TYLKO to, co faktycznie weszło.
 *
 * `nazwy` zawęża do wybranych składników; bez niego idzie wszystko nieodhaczone.
 * Zapamiętujemy po odpowiedzi Bring!, a nie z góry — wcześniej raport potrafił
 * chwalić się dodaniem rzeczy, która nie doszła.
 */
async function dopisz(lista, tydzien, przepis, nazwy) {
  const s = await stan(tydzien, przepis);
  if (s.blad) return s;

  const wybor = Array.isArray(nazwy) && nazwy.length
    ? new Set(nazwy.map((n) => U.norm(n)))
    : null;
  const brakuje = s.skladniki.filter((x) => !x.odhaczony
    && (!wybor || wybor.has(U.norm(x.name))));

  if (!brakuje.length) return { doc: s.doc, skladniki: s.skladniki, raport: [], uwaga: 'Nie ma czego dopisywać.' };

  const r = await B.addItems(lista, brakuje.map((x) => ({ name: x.name, specification: x.specification })));
  const udane = r.results.filter((x) => x.status === 'added' || x.status === 'updated');
  STAN.ustawWiele(tydzien, przepis, udane.map((x) => x.input), true);

  const po = await stan(tydzien, przepis);
  return { doc: s.doc, skladniki: po.skladniki, raport: r.results };
}

// stan === null kasuje decyzję i przywraca zachowanie domyślne (spiżarnia).
async function przelacz(tydzien, przepis, nazwa, zalatwione) {
  const { doc, blad } = otworz(tydzien, przepis);
  if (blad) return { blad };

  const lista = skladniki(doc.text);
  const hit = lista.find((s) => s.name === nazwa)
    || lista.find((s) => U.norm(s.name) === U.norm(nazwa));
  if (!hit) return { blad: 'Ten przepis nie ma składnika „' + nazwa + '".' };

  STAN.ustaw(tydzien, przepis, hit.name, zalatwione === null ? null : !!zalatwione);
  return await stan(tydzien, przepis);
}

async function wyczysc(tydzien, przepis) {
  const { blad } = otworz(tydzien, przepis);
  if (blad) return { blad };
  STAN.wyczysc(tydzien, przepis);
  return await stan(tydzien, przepis);
}

module.exports = {
  skladniki, spizarniaDomu, wSpizarniDomu, znajdzPrzepis,
  stan, dopisz, przelacz, wyczysc
};
