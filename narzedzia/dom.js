#!/usr/bin/env node
'use strict';
/**
 * Dom — katalog z danymi jednej rodziny, osobny od kodu.
 *
 *   node narzedzia/dom.js zaloz <katalog>       zakłada dom (istniejący tylko uzupełnia)
 *   node narzedzia/dom.js aktualizuj [katalog]  odświeża to, co pochodzi z kodu
 *   node narzedzia/dom.js wskaz <katalog>       zapisuje dom.txt obok kodu (dla start.cmd)
 *   node narzedzia/dom.js gdzie                 pokazuje, który dom widzi kod i skąd to wie
 *
 * Dom zawiera:
 *   rodzina/ jadlospisy/ ksiazka/ ustawienia.md    dane rodziny — pisze je skill
 *   dane/                                           stan aplikacji, poza gitem
 *   konfiguracja/bring.json, web.json               hasła i PIN, poza gitem
 *   .claude/skills/rodzinny-jadlospis/              KOPIA skilla z kodu
 *   .mcp.json, .claude/settings.local.json          serwer MCP wskazujący na kod
 *   CLAUDE.md, FORMAT.md                            instrukcje dla sesji otwartych w domu
 *
 * Zasada: dane rodziny narzędzie tylko zakłada, nigdy nie nadpisuje. Nadpisuje wyłącznie
 * to, czego źródłem prawdy jest kod — skill, FORMAT.md, .mcp.json — bo kopia w domu ma
 * nadążać za kodem, a nie żyć własnym życiem. Skill ma w nagłówku numer wersji właśnie
 * po to, żeby dało się zauważyć, że kopia została w tyle.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const U = require('../lib/uklad.js');

const KOD = U.KOD;
const SKILL = 'rodzinny-jadlospis';
const SKILL_W_KODZIE = path.join(KOD, '.claude', 'skills', SKILL);
const SZABLONY = path.join(KOD, 'szablony', 'dom');

const info = (t) => process.stdout.write('  ' + t + '\n');

function wersjaSkilla(katalogSkilla) {
  try {
    const m = fs.readFileSync(path.join(katalogSkilla, 'SKILL.md'), 'utf8')
      .match(/\*\*Wersja skilla: ([^*]+?)\.?\*\*/);
    return m ? m[1].trim() : '?';
  } catch (e) { return 'brak'; }
}

function zapiszJesliBrak(plik, tresc) {
  if (fs.existsSync(plik)) return false;
  fs.mkdirSync(path.dirname(plik), { recursive: true });
  fs.writeFileSync(plik, tresc, 'utf8');
  return true;
}

function szablon(nazwa, dom) {
  return fs.readFileSync(path.join(SZABLONY, nazwa), 'utf8')
    .split('{{KOD}}').join(KOD)
    .split('{{DOM}}').join(dom);
}

// .gitignore domu: dopisujemy brakujące wpisy, nie ruszamy cudzych.
function scalGitignore(dom) {
  const plik = path.join(dom, '.gitignore');
  const chciane = szablon('gitignore', dom).replace(/\r\n/g, '\n');
  let obecny = '';
  try { obecny = fs.readFileSync(plik, 'utf8').replace(/\r\n/g, '\n'); } catch (e) { /* brak */ }
  const linie = new Set(obecny.split('\n').map((l) => l.trim()));
  const brakuje = chciane.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !linie.has(l.trim()));
  if (!brakuje.length && obecny) return false;
  const nowy = obecny ? obecny.replace(/\n*$/, '\n\n') + brakuje.join('\n') + '\n' : chciane;
  fs.writeFileSync(plik, nowy, 'utf8');
  return true;
}

// To, co pochodzi z kodu: nadpisujemy zawsze, bo kod jest źródłem prawdy.
function aktualizuj(dom) {
  if (!fs.existsSync(dom)) throw new Error('Nie ma katalogu ' + dom + ' — najpierw: dom.js zaloz ' + dom);

  const skillWDomu = path.join(dom, '.claude', 'skills', SKILL);
  fs.mkdirSync(skillWDomu, { recursive: true });
  fs.cpSync(SKILL_W_KODZIE, skillWDomu, { recursive: true, force: true });
  info('skill ' + SKILL + ': ' + wersjaSkilla(skillWDomu) + '  (kopia z kodu)');

  fs.copyFileSync(path.join(KOD, 'FORMAT.md'), path.join(dom, 'FORMAT.md'));
  info('FORMAT.md: skopiowany');

  // Serwer MCP uruchamiany z sesji w domu: sam znalazłby dom po bieżącym katalogu,
  // ale PC_DOM w env zdejmuje wszelką zależność od tego, skąd Claude Code startuje.
  const mcp = { mcpServers: { bring: {
    command: 'node',
    args: [path.join(KOD, 'mcp', 'bring', 'server.js')],
    env: { PC_DOM: dom }
  } } };
  fs.writeFileSync(path.join(dom, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n', 'utf8');
  info('.mcp.json: serwer bring -> ' + path.join(KOD, 'mcp', 'bring', 'server.js'));

  // Zatwierdzenie serwera z .mcp.json zapisuje się per katalog po kliknięciu w sesji
  // interaktywnej; wpis tutaj oszczędza tego kliknięcia i pozwala działać trybowi -p.
  const ustawienia = path.join(dom, '.claude', 'settings.local.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(ustawienia, 'utf8')); } catch (e) { /* brak albo śmieci */ }
  const lista = Array.isArray(s.enabledMcpjsonServers) ? s.enabledMcpjsonServers : [];
  if (lista.indexOf('bring') < 0) {
    s.enabledMcpjsonServers = lista.concat(['bring']);
    fs.writeFileSync(ustawienia, JSON.stringify(s, null, 2) + '\n', 'utf8');
    info('.claude/settings.local.json: serwer bring zatwierdzony');
  }
}

function wskaz(dom) {
  fs.writeFileSync(U.PLIK_WSKAZNIKA, dom + '\n', 'utf8');
  info('dom.txt obok kodu -> ' + dom);
}

function zaloz(dom) {
  fs.mkdirSync(dom, { recursive: true });
  const nowy = !U.jestDomem(dom);
  info((nowy ? 'Zakladam dom: ' : 'Uzupelniam istniejacy dom: ') + dom);

  ['rodzina', 'jadlospisy', 'ksiazka', 'dane', 'konfiguracja'].forEach((d) => {
    fs.mkdirSync(path.join(dom, d), { recursive: true });
  });
  zapiszJesliBrak(path.join(dom, 'ksiazka', '.gitkeep'), '');

  aktualizuj(dom);

  if (zapiszJesliBrak(path.join(dom, 'CLAUDE.md'), szablon('CLAUDE.md', dom))) info('CLAUDE.md: zalozony');
  if (scalGitignore(dom)) info('.gitignore: uzupelniony');

  const wzor = path.join(KOD, 'mcp', 'bring', 'credentials.example.json');
  if (fs.existsSync(wzor) && zapiszJesliBrak(path.join(dom, 'konfiguracja', 'bring.example.json'),
    fs.readFileSync(wzor, 'utf8'))) {
    info('konfiguracja/bring.example.json: wzor — skopiuj do bring.json i wpisz dane logowania');
  }

  // Dom ma własne, prywatne repozytorium: commity czatu i książki trafiają tutaj,
  // a nie do repozytorium kodu, które może być publiczne.
  if (!fs.existsSync(path.join(dom, '.git'))) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: dom, stdio: 'ignore' });
      execFileSync('git', ['add', '-A'], { cwd: dom, stdio: 'ignore' });
      execFileSync('git', ['commit', '-q', '-m', 'Dom: poczatek'], { cwd: dom, stdio: 'ignore' });
      info('git: zalozone repozytorium domu z pierwszym commitem');
    } catch (e) {
      info('git: nie udalo sie zalozyc repozytorium (' + (e.message || '').split('\n')[0] + ') — zrob to recznie');
    }
  }

  const wskazany = (() => { try { return fs.readFileSync(U.PLIK_WSKAZNIKA, 'utf8').trim(); } catch (e) { return ''; } })();
  if (!wskazany) wskaz(dom);
  else if (path.resolve(wskazany) !== path.resolve(dom)) {
    info('dom.txt wskazuje na ' + wskazany + ' — zostawiam; zmien poleceniem: dom.js wskaz ' + dom);
  }

  info('');
  info('Dalej: skopiuj konfiguracja/bring.example.json do konfiguracja/bring.json i wpisz dane,');
  info('       otworz ten katalog w Claude Code (skill i serwer MCP sa juz na miejscu),');
  info('       aplikacje dla telefonow uruchamia ' + path.join(KOD, 'web', 'start.cmd') + '.');
}

function gdzie() {
  info('Kod:  ' + KOD);
  info('Dom:  ' + U.ROOT + '  (' + U.SKAD_DOM + ')');
  info('Bring: ' + U.plikKonfiguracji('bring.json', path.join(KOD, 'mcp', 'bring', 'credentials.json')));
  info('Web:   ' + U.plikKonfiguracji('web.json', path.join(KOD, 'web', 'config.json')));
  const wDomu = path.join(U.ROOT, '.claude', 'skills', SKILL);
  const a = wersjaSkilla(SKILL_W_KODZIE), b = wersjaSkilla(wDomu);
  info('Skill: w kodzie ' + a + ', w domu ' + b + (a === b ? '' : '  <- rozne! uruchom: dom.js aktualizuj'));
}

function main() {
  const [polecenie, arg] = process.argv.slice(2);
  const cel = arg ? path.resolve(arg) : U.ROOT;
  console.log('');
  try {
    switch (polecenie) {
      case 'zaloz':
        if (!arg) throw new Error('Podaj katalog: dom.js zaloz <katalog>');
        zaloz(cel); break;
      case 'aktualizuj': aktualizuj(cel); break;
      case 'wskaz':
        if (!arg) throw new Error('Podaj katalog: dom.js wskaz <katalog>');
        if (!U.jestDomem(cel)) throw new Error(cel + ' nie wyglada na dom (brak rodzina/, jadlospisy/ ani ustawienia.md)');
        wskaz(cel); break;
      case 'gdzie': gdzie(); break;
      default:
        info('Uzycie: node narzedzia/dom.js zaloz <katalog> | aktualizuj [katalog] | wskaz <katalog> | gdzie');
    }
  } catch (e) {
    process.stderr.write('  Blad: ' + e.message + '\n');
    process.exitCode = 1;
  }
  console.log('');
}

main();
