#!/usr/bin/env node
'use strict';
/**
 * Przenosi projekt na układ z książką i folderami tygodni (FORMAT.md).
 *
 *   node narzedzia/migruj-uklad.js --proba    podgląd, nic nie rusza
 *   node narzedzia/migruj-uklad.js            wykonanie
 *
 * Z:                              Na:
 *   przepisy/*.md                   jadlospisy/<tydzien>/przepisy/*.md
 *   jadlospisy/<zakres>.md          jadlospisy/<tydzien>/jadlospis.md
 *   jadlospisy/*.pdf                jadlospisy/<tydzien>/
 *   listy-zakupow/<data>.md         jadlospisy/<tydzien>/lista-zakupow.md
 *   web/stan-przepisow.json         dane/stan-przepisow.json  (klucz: tydzien/przepis)
 *   —                               ksiazka/  (pusta, zapełnia ją człowiek)
 *
 * Przepisy idą do tygodnia, a nie do książki, bo to zapis jednego konkretnego
 * tygodnia gotowania. Co z tego zasługuje na książkę, wskazuje człowiek przyciskiem
 * — narzędzie nie zgaduje, co rodzina lubi.
 *
 * Używa `git mv`, więc historia plików nie ginie, a całość da się cofnąć.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = require('../lib/uklad.js').ROOT;      // dom, nie katalog kodu
const PROBA = process.argv.includes('--proba');

const kroki = [];
const uwagi = [];

function git(args) {
  if (PROBA) return '';
  try { return String(execFileSync('git', args, { cwd: ROOT })); }
  catch (e) { uwagi.push('git ' + args.join(' ') + ' — ' + (e.message || '').split('\n')[0]); return ''; }
}

function sledzonyPrzezGit(wzgledna) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', wzgledna], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}

// Przenosimy przez git mv, gdy plik jest śledzony — wtedy historia zostaje przy pliku.
function przenies(zWzgl, doWzgl) {
  kroki.push('  ' + zWzgl + '  ->  ' + doWzgl);
  if (PROBA) return;
  const doAbs = path.join(ROOT, doWzgl);
  fs.mkdirSync(path.dirname(doAbs), { recursive: true });
  if (sledzonyPrzezGit(zWzgl)) git(['mv', zWzgl, doWzgl]);
  else fs.renameSync(path.join(ROOT, zWzgl), doAbs);
}

function main() {
  const planyDir = path.join(ROOT, 'jadlospisy');
  const przepisyDir = path.join(ROOT, 'przepisy');
  const listyDir = path.join(ROOT, 'listy-zakupow');

  const plany = fs.existsSync(planyDir)
    ? fs.readdirSync(planyDir).filter((f) => /\.md$/i.test(f)) : [];

  if (!plany.length) { console.log('\n  Brak planów w jadlospisy/ — nie ma czego przenosić.\n'); return; }
  if (plany.length > 1) {
    console.log('\n  Znalazłem kilka planów. Każdy dostanie własny folder, ale przepisy leżą');
    console.log('  we wspólnym worku i nie wiem, który należy do którego tygodnia.');
    console.log('  Przenoszę je do najnowszego planu; resztę przełóż ręcznie.\n');
  }

  // Tydzień bierzemy z zakresu dat w nazwie pliku planu.
  const docelowe = plany.map((f) => {
    const m = f.match(/(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/);
    return { plik: f, folder: m ? m[1] + '_do_' + m[2] : f.replace(/\.md$/i, '') };
  });
  const glowny = docelowe[docelowe.length - 1];

  console.log(PROBA ? '\n  PRÓBA — nic nie zostanie przeniesione\n' : '\n  PRZENOSINY\n');

  docelowe.forEach((d) => przenies('jadlospisy/' + d.plik, 'jadlospisy/' + d.folder + '/jadlospis.md'));

  // PDF-y leżące luzem w jadlospisy/ trafiają do swojego tygodnia.
  (fs.existsSync(planyDir) ? fs.readdirSync(planyDir) : [])
    .filter((f) => /\.pdf$/i.test(f))
    .forEach((f) => {
      const m = f.match(/(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/);
      const cel = m ? m[1] + '_do_' + m[2] : glowny.folder;
      przenies('jadlospisy/' + f, 'jadlospisy/' + cel + '/' + f);
    });

  const przepisy = fs.existsSync(przepisyDir)
    ? fs.readdirSync(przepisyDir).filter((f) => /\.md$/i.test(f)) : [];
  przepisy.forEach((f) => przenies('przepisy/' + f, 'jadlospisy/' + glowny.folder + '/przepisy/' + f));

  const listy = fs.existsSync(listyDir)
    ? fs.readdirSync(listyDir).filter((f) => /\.md$/i.test(f)) : [];
  if (listy.length === 1) {
    przenies('listy-zakupow/' + listy[0], 'jadlospisy/' + glowny.folder + '/lista-zakupow.md');
  } else if (listy.length > 1) {
    listy.forEach((f) => {
      const data = (f.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      const cel = docelowe.find((d) => data && d.folder.indexOf(data) === 0) || glowny;
      przenies('listy-zakupow/' + f, 'jadlospisy/' + cel.folder + '/lista-zakupow.md');
    });
  }

  // Książka: pusta, ale katalog ma istnieć w repozytorium, żeby było gdzie awansować.
  kroki.push('  ksiazka/  (nowy, pusty)');
  if (!PROBA) {
    fs.mkdirSync(path.join(ROOT, 'ksiazka'), { recursive: true });
    const gk = path.join(ROOT, 'ksiazka', '.gitkeep');
    if (!fs.existsSync(gk)) fs.writeFileSync(gk, '', 'utf8');
  }

  // Stan: przepisany na klucz "<tydzien>/<przepis>". Ptaszki z ostatnich dni zostają —
  // odnoszą się do tego samego gotowania, tylko adresowane są teraz przez tydzień.
  const staryStan = path.join(ROOT, 'web', 'stan-przepisow.json');
  if (fs.existsSync(staryStan)) {
    let stary = {};
    try { stary = JSON.parse(fs.readFileSync(staryStan, 'utf8')); } catch (e) { uwagi.push('stan: ' + e.message); }
    const nowy = {};
    Object.keys(stary).forEach((przepis) => { nowy[glowny.folder + '/' + przepis] = stary[przepis]; });
    kroki.push('  web/stan-przepisow.json  ->  dane/stan-przepisow.json  ('
      + Object.keys(nowy).length + ' przepisów, klucz z tygodniem)');
    if (!PROBA) {
      fs.mkdirSync(path.join(ROOT, 'dane'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'dane', 'stan-przepisow.json'),
        JSON.stringify(nowy, null, 2) + '\n', 'utf8');
      fs.unlinkSync(staryStan);
    }
  }

  kroki.forEach((k) => console.log(k));
  if (uwagi.length) {
    console.log('\n  Uwagi:');
    uwagi.forEach((u) => console.log('    - ' + u));
  }
  console.log('\n  Kroków: ' + kroki.length + (PROBA ? '  (próba — nic nie ruszone)' : '') + '\n');
}

main();
