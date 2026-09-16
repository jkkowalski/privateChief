#!/usr/bin/env node
'use strict';
/**
 * PrivateChief — aplikacja webowa dla domowników (telefony w sieci WiFi).
 *
 * Czyta jadłospisy i przepisy prosto z plików .md w katalogu projektu i renderuje je
 * po swojemu — bez żadnych zależności i bez CDN-ów, więc działa też wtedy, gdy WiFi
 * nie ma internetu. Listę zakupów obsługuje przez ../mcp/bring/bring.js, czyli ten sam
 * moduł, z którego korzysta serwer MCP (to samo dopasowanie nazw do katalogu Bring!).
 *
 * Uruchomienie:  node web/app.js        (albo web/start.cmd)
 * Konfiguracja:  web/config.json — tworzona przy pierwszym starcie, z losowym PIN-em.
 *
 * Dostęp: PIN podawany raz na urządzenie, zapamiętywany w ciasteczku. To zabezpieczenie
 * na miarę domowego WiFi, a nie internetu — serwer ma nasłuchiwać w sieci lokalnej.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const B = require('../mcp/bring/bring.js');
const CZAT = require('./czat.js');
const U = require('../lib/uklad.js');
const KSIAZKA = require('../lib/ksiazka.js');
const SKL = require('../lib/skladniki.js');
const ALERGENY = require('../lib/alergeny.js');

// Ustawiane raz przy starcie (patrz koniec pliku) — strony pytają o to synchronicznie.
let CZAT_DOSTEPNY = false;

// Dom (dane rodziny) znajduje lib/uklad.js: PC_DOM, bieżący katalog albo dom.txt obok
// kodu. PIN i sekret leżą w domu (konfiguracja/web.json); stare web/config.json obok
// kodu działa nadal, dopóki tam jest.
const ROOT = U.ROOT;
const CONFIG_FILE = U.plikKonfiguracji('web.json', path.join(__dirname, 'config.json'));

// ---------------------------------------------------------------- konfiguracja

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (c.pin && c.secret) return c;
    } catch (e) {
      throw new Error('Nie mogę odczytać ' + CONFIG_FILE + ' (niepoprawny JSON): ' + e.message);
    }
  }
  const c = {
    port: 8765,
    pin: String(crypto.randomInt(1000, 10000)),
    secret: crypto.randomBytes(16).toString('hex'),
    list: ''            // pusta = domyślna lista z konfiguracji Bring!
  };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + '\n', 'utf8');
  return c;
}

const CONFIG = loadConfig();
// Klucz API Anthropic (opcjonalny) — czat działa wtedy bez logowania Claude Code.
CZAT.ustawKluczApi(CONFIG.claudeApiKey);
// Model czatu kuchennego i model planowania tygodnia (aliasy albo pełne identyfikatory).
CZAT.ustawModele(CONFIG.claudeModel, CONFIG.claudeModelPlanowanie);
const PORT = Number(process.env.PC_PORT || CONFIG.port || 8765);
// PC_LIST nadpisuje liste Bring! (do testow na liscie prywatnej).
const LISTA = process.env.PC_LIST || CONFIG.list || '';

// Token w ciasteczku liczymy z PIN-u i sekretu, więc przeżywa restart serwera
// (inaczej każdy domownik logowałby się od nowa po każdym uruchomieniu).
const TOKEN = crypto.createHash('sha256').update(CONFIG.pin + ':' + CONFIG.secret).digest('hex');

// ---------------------------------------------------------------- narzędzia tekstowe

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Nazwa produktu -> postać do porównań (bez wielkości liter i diakrytyków).
// Ten sam zabieg co w mcp/bring/bring.js: ł i ß nie rozkładają się przez NFD.
function norm(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/ł/g, 'l').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Nazwa pliku -> porównywalny klucz (bez wielkości liter, bez diakrytyków).
function slug(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------- render Markdown
//
// Świadomie mały renderer, pokrywający to, co produkuje skill rodzinny-jadlospis:
// nagłówki, listy, tabele, pogrubienia, kod, cytaty, odnośniki. Nie jest to pełny
// Markdown i nie ma nim być — chodzi o to, żeby nie ciągnąć zależności do kuchni.

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, href) => {
    const safe = /^(https?:\/\/|\/)/i.test(href) ? href : '';
    return safe ? '<a href="' + esc(safe) + '">' + txt + '</a>' : txt;
  });
  return t;
}

function renderTable(rows) {
  // rows: linie zaczynające się od "|". Druga linia to zwykle separator |---|---|
  const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const body = rows.filter((r) => !/^\|[\s:|-]+\|?$/.test(r));
  if (!body.length) return '';
  const head = cells(body[0]);
  const out = ['<div class="tabela"><table><thead><tr>'];
  head.forEach((c) => out.push('<th>' + inline(c) + '</th>'));
  out.push('</tr></thead><tbody>');
  body.slice(1).forEach((r) => {
    out.push('<tr>');
    cells(r).forEach((c) => out.push('<td>' + inline(c) + '</td>'));
    out.push('</tr>');
  });
  out.push('</tbody></table></div>');
  return out.join('');
}

function md(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {                       // blok kodu
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {                                       // nagłówek
      const n = Math.min(h[1].length + 1, 6);      // h1 w treści schodzi o poziom
      out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>');
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {                     // tabela
      const buf = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) buf.push(lines[i++].trim());
      out.push(renderTable(buf));
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {               // lista punktowana
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        buf.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      }
      out.push('<ul>' + buf.map((b) => '<li>' + inline(b) + '</li>').join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {               // lista numerowana
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      }
      out.push('<ol>' + buf.map((b) => '<li>' + inline(b) + '</li>').join('') + '</ol>');
      continue;
    }
    if (/^\s*>/.test(line)) {                      // cytat
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push('<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>');
      continue;
    }
    if (!line.trim()) { i++; continue; }

    const buf = [];                                // akapit
    while (i < lines.length && lines[i].trim() && !/^\s*([-*+>|#]|\d+\.)\s*/.test(lines[i])
           && !/^```/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    if (buf.length) out.push('<p>' + buf.map(inline).join('<br>') + '</p>');
    else i++;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- dostęp do plików
//
// Gdzie co leży, wie lib/uklad.js — ten sam moduł czyta serwer MCP. Tutaj zostaje
// tylko to, co dotyczy wyświetlania.

const listDocs = U.dokumenty;

// ---------------------------------------------------------------- jadłospis

// Tabela posiłków ma stałe kolumny (FORMAT.md). Rozpoznajemy ją po nagłówku, bo plan
// zawiera też tabele bilansu kalorycznego i korekt porcji — bez tego ich wiersze
// trafiały między dania.
function blokPlanu(linie) {
  for (let i = 0; i < linie.length; i++) {
    if (!/^\s*\|/.test(linie[i])) continue;
    let j = i;
    while (j < linie.length && /^\s*\|/.test(linie[j])) j++;
    const blok = linie.slice(i, j).join('\n');
    if (/dzień/i.test(blok) && /danie/i.test(blok)) return { od: i, doo: j };
    i = j;
  }
  return null;
}

function komorki(linia) {
  return linia.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function planRows(text) {
  const rows = [];
  const linie = String(text).replace(/\r\n/g, '\n').split('\n');
  const blok = blokPlanu(linie);
  if (!blok) return rows;

  const naglowki = komorki(linie[blok.od]).map((c) => c.toLowerCase());
  const kol = (nazwa) => naglowki.findIndex((c) => c.indexOf(nazwa) === 0);
  const iData = kol('data'), iPrzepis = kol('przepis');
  const iDzien = Math.max(kol('dzień'), 0);
  const iPosilek = kol('posiłek'), iDanie = kol('danie');

  linie.slice(blok.od + 1, blok.doo).forEach((line) => {
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) return;
    const c = komorki(line);
    if (c.length < 3) return;
    if (/^dzie/i.test(c[iDzien] || '')) return;

    const dzien = c[iDzien] || '';
    let date = null;
    if (iData >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(c[iData] || '')) {
      const p = c[iData].split('-');
      date = [c[iData], String(+p[2]), String(+p[1])];      // [pełna, dzień, miesiąc]
    } else {
      const m = dzien.match(/(\d{1,2})\.(\d{1,2})/);
      if (m) date = [null, m[1], m[2]];
    }

    const posilek = c[iPosilek >= 0 ? iPosilek : 1] || '';
    const danie = c[iDanie >= 0 ? iDanie : 2] || '';
    const przepis = iPrzepis >= 0 ? (c[iPrzepis] || '') : '';
    const pomin = [iDzien, iData, iPosilek, iDanie, iPrzepis];
    const reszta = c.filter((x, i) => pomin.indexOf(i) < 0);

    rows.push({ dzien, posilek, danie, przepis, reszta, date });
  });
  return rows;
}

function todayRows() {
  const t = U.tydzienBiezacy();
  if (!t) return { tydzien: null, rows: [] };
  const p = U.plan(t.slug);
  if (!p) return { tydzien: t, rows: [] };

  const now = new Date();
  const dd = now.getDate();
  const mm = now.getMonth() + 1;
  const rows = planRows(p.text).filter((r) => r.date && +r.date[1] === dd && +r.date[2] === mm);
  return { tydzien: t, rows };
}

// Odnośnik do przepisu TEGO tygodnia. Kolumna "Przepis" w planie niesie nazwę pliku,
// więc nie ma tu żadnego zgadywania — dopasowanie po podobieństwie nazw zostało
// wyłącznie dla planów sprzed zmiany formatu.
const STOP = new Set(['z', 'ze', 'i', 'w', 'we', 'na', 'do', 'od', 'dla', 'po', 'o', 'u', 'a', 'oraz']);

function tokeny(s) {
  return U.slug(s).split('-').filter((t) => t.length > 1 && !STOP.has(t));
}

function czlonPasuje(a, b) {
  return a === b || (a.length >= 4 && b.indexOf(a) === 0) || (b.length >= 4 && a.indexOf(b) === 0);
}

function linkPrzepisu(slugTygodnia, slugPrzepisu) {
  return '/tydzien/' + encodeURIComponent(slugTygodnia) + '/' + encodeURIComponent(slugPrzepisu);
}

function recipeLink(danie, przepis, slugTygodnia) {
  if (!slugTygodnia) return null;
  const wTygodniu = U.przepisyTygodnia(slugTygodnia);

  if (przepis) {
    const s = U.slug(przepis);
    return wTygodniu.some((d) => d.slug === s) ? linkPrzepisu(slugTygodnia, s) : null;
  }

  const dt = tokeny(String(danie).replace(/\*\*/g, ''));
  if (!dt.length) return null;
  let best = null;
  wTygodniu.forEach((d) => {
    const rt = tokeny(d.tytul);
    if (!rt.length) return;
    const trafione = rt.filter((r) => dt.some((x) => czlonPasuje(r, x)));
    const kotwica = dt.some((x) => czlonPasuje(rt[0], x));
    if (!kotwica || !trafione.length) return;
    const wynik = trafione.length / rt.length + 0.35 + 0.02 * trafione.length;
    if (!best || wynik > best.wynik) best = { slug: d.slug, wynik };
  });
  return best && best.wynik >= 0.55 ? linkPrzepisu(slugTygodnia, best.slug) : null;
}

// ---------------------------------------------------------------- skladniki
//
// Cala wiedza o skladnikach i spizarni siedzi w lib/skladniki.js — tego samego modulu
// uzywa serwer MCP, wiec czat widzi dokladnie to samo co aplikacja.

const ingredients = SKL.skladniki;


// ---------------------------------------------------------------- szablon HTML

const CSS = `
:root{
  --bg:#fbf8f4; --surface:#fff; --surface2:#f4efe8; --text:#221d18; --muted:#7c7065;
  --line:#e8e0d5; --accent:#bd5629; --accent-bg:#fdf1ea; --green:#46754f; --danger:#a33;
  --cien:0 1px 2px rgba(34,29,24,.05), 0 4px 14px rgba(34,29,24,.05);
  --r-karta:16px; --r-mala:12px;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#15120f; --surface:#1e1a16; --surface2:#262019; --text:#f2ece4; --muted:#a3978a;
  --line:#332c24; --accent:#e8875a; --accent-bg:#2b1d15; --green:#7fb08c; --danger:#e08080;
  --cien:0 1px 2px rgba(0,0,0,.3), 0 4px 14px rgba(0,0,0,.25);
}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);
  font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  padding-bottom:calc(72px + env(safe-area-inset-bottom))}
a{color:var(--accent);text-decoration:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}

header{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:saturate(1.6) blur(12px);border-bottom:1px solid var(--line);
  padding:12px 16px;padding-top:calc(12px + env(safe-area-inset-top));display:flex;align-items:center;gap:10px}
header h1{font-size:17px;margin:0;font-weight:650;letter-spacing:-.01em;flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header .wstecz{flex:0 0 auto;width:32px;height:32px;margin-left:-6px;display:grid;place-items:center;
  color:var(--muted);font-size:26px;line-height:0;border-radius:50%}
header .wstecz:active{background:var(--surface2)}
main{padding:18px 16px 28px;max-width:720px;margin:0 auto}

.naglowek-strony{margin:0 0 18px}
.naglowek-strony .duzy{font-size:27px;font-weight:680;letter-spacing:-.02em;margin:0;line-height:1.15}
.naglowek-strony .pod{color:var(--muted);font-size:14px;margin:5px 0 0}

.karta{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-karta);
  box-shadow:var(--cien);padding:16px;margin:0 0 12px}
.karta.klik{display:block;color:inherit}
.karta.klik:active{transform:scale(.988);border-color:var(--accent)}
.etykieta{font-size:11.5px;font-weight:680;letter-spacing:.07em;text-transform:uppercase;color:var(--accent)}
.danie{font-size:19px;font-weight:620;letter-spacing:-.01em;margin:6px 0 0;line-height:1.3}
.strzalka{color:var(--muted);font-size:14px;margin-top:12px;display:flex;align-items:center;gap:5px}
.karta.klik:active .strzalka{color:var(--accent)}

.chipy{display:flex;flex-wrap:wrap;gap:6px;margin:11px 0 0}
.chip{background:var(--surface2);color:var(--muted);border-radius:999px;padding:4px 11px;font-size:12.5px;white-space:nowrap}
.chip.mocny{background:var(--accent-bg);color:var(--accent);font-weight:600}

.dzien{margin:26px 0 10px;display:flex;align-items:baseline;gap:9px}
.dzien:first-of-type{margin-top:6px}
.dzien h2{font-size:15px;font-weight:680;margin:0;letter-spacing:-.01em}
.dzien .data{color:var(--muted);font-size:13px}
.dzien.dzis h2{color:var(--accent)}
.dzien .znacznik{background:var(--accent);color:#fff;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:650}

.wiersz{display:flex;gap:13px;align-items:flex-start;background:var(--surface);border:1px solid var(--line);
  border-radius:var(--r-mala);padding:13px 14px;margin:0 0 7px;color:inherit}
.wiersz:active{border-color:var(--accent)}
.wiersz .kiedy{flex:0 0 62px;font-size:12px;color:var(--muted);padding-top:2px;font-weight:600}
.wiersz .co{flex:1;min-width:0}
.wiersz .co b{font-weight:550;font-size:15px;display:block;line-height:1.35}
.wiersz .co small{color:var(--muted);font-size:12.5px;display:block;margin-top:3px}
.wiersz .ptaszek{flex:0 0 auto;color:var(--muted);font-size:15px;padding-top:2px}

.szukaj{position:relative;margin:0 0 16px}
.szukaj input{width:100%;padding:13px 15px 13px 40px;border:1px solid var(--line);border-radius:var(--r-mala);
  background:var(--surface);color:var(--text);font-size:15px}
.szukaj .lupa{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:15px;pointer-events:none}
.licznik{color:var(--muted);font-size:13px;margin:0 0 10px}

.spis{list-style:none;padding:0;margin:0}
.spis li{margin:0 0 7px}
.spis a{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--line);
  border-radius:var(--r-mala);padding:14px 15px;color:inherit;font-weight:520;font-size:15px}
.spis a:active{border-color:var(--accent)}
.spis a::after{content:"\\203A";margin-left:auto;color:var(--muted);font-size:17px}

.hero{margin:0 0 20px}
.hero h1{font-size:26px;font-weight:680;letter-spacing:-.022em;margin:0;line-height:1.2}
.hero .opis{color:var(--muted);font-size:14px;margin:9px 0 0;line-height:1.5}

.sekcja{margin:26px 0 0}
.sekcja h2{font-size:13px;font-weight:680;letter-spacing:.06em;text-transform:uppercase;
  color:var(--muted);margin:0 0 11px}

.skl{list-style:none;padding:0;margin:0}
.skl li{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;background:var(--surface);
  border:1px solid var(--line);border-radius:var(--r-mala);margin:0 0 6px;cursor:pointer}
.skl li .box{flex:0 0 auto;width:21px;height:21px;border:2px solid var(--line);border-radius:6px;
  margin-top:1px;display:grid;place-items:center;color:transparent;font-size:13px;font-weight:700}
.skl li.ok .box{background:var(--green);border-color:var(--green);color:#fff}
.skl li.ok .nazwa{text-decoration:line-through;color:var(--muted)}
.skl li .tresc-skl{flex:1;min-width:0}
.skl li .nazwa{font-size:15px;line-height:1.4}
.skl li .ile{color:var(--muted);font-size:13px;display:block;margin-top:2px}
.skl li .spiz{font-size:10.5px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;
  color:var(--muted);background:var(--surface2);border-radius:999px;padding:2px 8px;margin-top:5px;display:inline-block}

.kroki{list-style:none;padding:0;margin:0;counter-reset:krok}
.kroki li{counter-increment:krok;display:flex;gap:13px;padding:14px 15px;background:var(--surface);
  border:1px solid var(--line);border-radius:var(--r-mala);margin:0 0 7px;cursor:pointer;line-height:1.55}
.kroki li::before{content:counter(krok);flex:0 0 26px;height:26px;border-radius:50%;background:var(--accent-bg);
  color:var(--accent);font-size:13px;font-weight:700;display:grid;place-items:center}
.kroki li.ok{opacity:.45}
.kroki li.ok::before{background:var(--green);color:#fff}

.tresc{font-size:16px;line-height:1.62}
.tresc h2{font-size:18px;font-weight:660;margin:24px 0 8px;letter-spacing:-.01em}
.tresc h3{font-size:15.5px;font-weight:650;margin:19px 0 7px}
.tresc h4{font-size:14px;margin:16px 0 6px;color:var(--muted)}
.tresc p{margin:0 0 12px}
.tresc ul,.tresc ol{padding-left:21px;margin:0 0 12px}
.tresc li{margin:5px 0}
.tresc code{background:var(--surface2);padding:1px 6px;border-radius:5px;font-size:14px}
.tresc pre{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-mala);padding:13px;overflow-x:auto}
.tresc blockquote{margin:14px 0;padding:10px 15px;background:var(--surface);border-left:3px solid var(--accent);
  border-radius:0 var(--r-mala) var(--r-mala) 0;color:var(--muted)}
.tabela{overflow-x:auto;margin:14px 0;border:1px solid var(--line);border-radius:var(--r-mala)}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{background:var(--surface2);font-weight:650;white-space:nowrap}
tr:last-child td{border-bottom:0}

nav{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;
  background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:saturate(1.6) blur(12px);
  border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
nav a{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;
  padding:9px 4px 10px;color:var(--muted);font-size:10.5px;font-weight:600}
nav a .ikona{font-size:20px;line-height:1.1;filter:grayscale(1);opacity:.6}
nav a.akt{color:var(--accent)}
nav a.akt .ikona{filter:none;opacity:1}

button,input,textarea{font:inherit}
.btn{display:block;width:100%;background:var(--accent);color:#fff;border:0;border-radius:var(--r-mala);
  padding:15px;font-weight:650;font-size:15px;cursor:pointer}
.btn:active{opacity:.85}
.btn[disabled]{opacity:.55}
.btn.wtorny{background:var(--surface);color:var(--muted);border:1px solid var(--line)}

form.dodaj{display:flex;gap:8px;margin:0 0 16px}
form.dodaj input{flex:1;min-width:0;padding:14px 15px;border:1px solid var(--line);
  border-radius:var(--r-mala);background:var(--surface);color:var(--text);font-size:15px}
form.dodaj button{background:var(--accent);color:#fff;border:0;border-radius:var(--r-mala);
  padding:0 19px;font-weight:650;cursor:pointer;font-size:15px}

.poz{display:flex;align-items:center;gap:13px;background:var(--surface);border:1px solid var(--line);
  border-radius:var(--r-mala);padding:13px 14px;margin:0 0 7px}
.poz .kolko{flex:0 0 auto;width:24px;height:24px;border:2px solid var(--line);border-radius:50%;
  background:transparent;cursor:pointer;display:grid;place-items:center;color:transparent;font-size:13px}
.poz .kolko:active{border-color:var(--green)}
.poz .txt{flex:1;min-width:0}
.poz .txt b{font-weight:520;font-size:15px;display:block;line-height:1.35}
.poz .txt i{font-style:normal;color:var(--muted);font-size:13px;display:block;margin-top:2px}
.poz .x{background:transparent;border:0;color:var(--muted);font-size:19px;padding:6px 4px;cursor:pointer;line-height:1}
.poz.znika{opacity:.4;transform:translateX(6px);transition:opacity .18s,transform .18s}
.poz.zrobione .txt b{text-decoration:line-through;color:var(--muted);font-weight:450}

.zwijane{margin:24px 0 0}
.zwijane summary{cursor:pointer;color:var(--muted);font-size:13.5px;font-weight:620;padding:9px 0;list-style:none}
.zwijane summary::-webkit-details-marker{display:none}
.zwijane summary::before{content:"\\203A";display:inline-block;transform:rotate(90deg);margin-right:8px;transition:transform .15s}
.zwijane[open] summary::before{transform:rotate(-90deg)}

.pusto{color:var(--muted);text-align:center;padding:38px 18px;line-height:1.6;font-size:15px}
.pusto .ikona{font-size:34px;display:block;margin:0 0 12px;filter:grayscale(1);opacity:.45}
.uwaga{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--accent);
  border-radius:0 var(--r-mala) var(--r-mala) 0;padding:12px 15px;color:var(--muted);font-size:13.5px;
  margin:0 0 14px;line-height:1.5}
.toast{position:fixed;left:16px;right:16px;bottom:calc(84px + env(safe-area-inset-bottom));
  background:var(--text);color:var(--bg);padding:13px 16px;border-radius:var(--r-mala);font-size:14px;
  font-weight:520;opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s;
  pointer-events:none;z-index:30;box-shadow:var(--cien);text-align:center}
.toast.on{opacity:1;transform:none}

.login{max-width:300px;margin:14vh auto 0;text-align:center}
.login .znak{font-size:42px;margin:0 0 14px;filter:grayscale(1);opacity:.5}
.login h2{font-size:23px;font-weight:680;margin:0 0 5px;letter-spacing:-.02em}
.login p{color:var(--muted);font-size:14px;margin:0 0 22px}
.login input{width:100%;padding:15px;font-size:25px;text-align:center;letter-spacing:9px;
  border:1px solid var(--line);border-radius:var(--r-mala);background:var(--surface);color:var(--text);margin:0 0 11px}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

function layout(title, body, aktywna, wstecz, skrypt) {
  return '<!doctype html><html lang="pl"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<meta name="color-scheme" content="light dark">'
    + '<meta name="theme-color" content="#fbf8f4" media="(prefers-color-scheme:light)">'
    + '<meta name="theme-color" content="#15120f" media="(prefers-color-scheme:dark)">'
    + '<title>' + esc(title) + ' — PrivateChief</title><style>' + CSS + CSS_CZAT + '</style></head><body>'
    + '<header>'
    + (wstecz ? '<a class="wstecz" href="' + esc(wstecz) + '" aria-label="Wstecz">&#8249;</a>' : '')
    + '<h1>' + esc(title) + '</h1></header>'
    + '<main>' + body + '</main>'
    + nav(aktywna)
    + '<div class="toast" id="toast" role="status" aria-live="polite"></div>'
    // Panel czatu dokładamy do każdej strony po zalogowaniu — na ekranie logowania
    // (aktywna === false) nie ma czego pytać, bo i tak nie przeszlibyśmy dalej.
    + (aktywna === false ? '' : panelCzatu(CZAT_DOSTEPNY))
    + (skrypt ? '<script>' + skrypt + '</script>' : '')
    + (aktywna === false || !CZAT_DOSTEPNY ? '' : '<script>' + SKRYPT_CZAT + '</script>')
    + '</body></html>';
}

function nav(akt) {
  if (akt === false) return '';
  const poz = [
    ['/', 'Dziś', '\u{1F373}'],
    ['/jadlospisy', 'Plan', '\u{1F4C5}'],
    ['/przepisy', 'Przepisy', '\u{1F4D6}'],
    ['/zakupy', 'Zakupy', '\u{1F6D2}']
  ];
  return '<nav>' + poz.map((p) =>
    '<a href="' + p[0] + '"' + (p[0] === akt ? ' class="akt" aria-current="page"' : '') + '>'
    + '<span class="ikona">' + p[2] + '</span>' + esc(p[1]) + '</a>'
  ).join('') + '</nav>';
}

// ---------------------------------------------------------------- kawałki wspólne

const DNI = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const MIES = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca',
  'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

function odmiana(n, a, b, c) {
  if (n === 1) return a;
  const d = n % 10, s = n % 100;
  return (d >= 2 && d <= 4 && (s < 12 || s > 14)) ? b : c;
}

function pusto(ikona, tekst) {
  return '<div class="pusto"><span class="ikona">' + ikona + '</span>' + tekst + '</div>';
}

// Z wiersza planu robimy chipy: czas, porcje, uwagi.
function chipyWiersza(r, mocnyPierwszy) {
  const ch = r.reszta.filter(Boolean);
  if (!ch.length) return '';
  return '<div class="chipy">' + ch.map((t, i) =>
    '<span class="chip' + (i === 0 && mocnyPierwszy ? ' mocny' : '') + '">' + esc(t) + '</span>'
  ).join('') + '</div>';
}

function czysteDanie(d) {
  return String(d).replace(/\*\*/g, '').trim();
}

// ---------------------------------------------------------------- strony

function stronaDzis() {
  const plan = U.tydzienBiezacy();
  if (!plan) {
    return pusto('\u{1F373}', 'Nie ma jeszcze żadnego jadłospisu.<br><br>'
      + 'Poproś Claude\'a o zaplanowanie tygodnia —<br>pliki pojawią się tutaj same.');
  }
  const wiersze = planRows(U.plan(plan.slug).text);

  const teraz = new Date();
  const dd = teraz.getDate(), mm = teraz.getMonth() + 1;
  const naDzis = wiersze.filter((r) => r.date && +r.date[1] === dd && +r.date[2] === mm);

  const tytul = '<div class="naglowek-strony"><p class="duzy">' + esc(DNI[teraz.getDay()]) + '</p>'
    + '<p class="pod">' + teraz.getDate() + ' ' + MIES[teraz.getMonth()] + ' ' + teraz.getFullYear() + '</p></div>';

  if (naDzis.length) return tytul + naDzis.map((r) => kartaPosilku(r, plan.slug)).join('') + stopkaPlanu(plan);

  // Nic na dziś — pokazujemy najbliższy dzień z planu, zamiast zostawiać pustą stronę.
  const przyszle = wiersze.filter((r) => r.date && (+r.date[2] > mm || (+r.date[2] === mm && +r.date[1] > dd)));
  if (!przyszle.length) {
    return tytul + '<div class="uwaga">Plan <b>' + esc(plan.tytul) + '</b> już się skończył. '
      + 'Czas na kolejny tydzień.</div>' + przyciskPlanowania(U.tygodnie()) + stopkaPlanu(plan);
  }
  const pierwszy = przyszle[0].dzien;
  const grupa = przyszle.filter((r) => r.dzien === pierwszy);
  return tytul
    + '<div class="uwaga">Na dziś nic nie zaplanowano. Najbliższe posiłki:</div>'
    + '<div class="dzien"><h2>' + esc(pierwszy) + '</h2></div>'
    + grupa.map((r) => kartaPosilku(r, plan.slug)).join('')
    + stopkaPlanu(plan);
}

function kartaPosilku(r, slugTygodnia) {
  const link = recipeLink(r.danie, r.przepis, slugTygodnia);
  const srodek = '<span class="etykieta">' + esc(r.posilek) + '</span>'
    + '<p class="danie">' + esc(czysteDanie(r.danie)) + '</p>'
    + chipyWiersza(r, true);
  return link
    ? '<a class="karta klik" href="' + link + '">' + srodek
      + '<div class="strzalka">Zobacz przepis <span>&#8250;</span></div></a>'
    : '<div class="karta">' + srodek
      + '<div class="strzalka">Bez zapisanego przepisu</div></div>';
}

function stopkaPlanu(plan) {
  return '<ul class="spis" style="margin-top:18px"><li><a href="/jadlospis/'
    + encodeURIComponent(plan.slug) + '">Cały tydzień</a></li></ul>';
}

// Jadłospis jako lista dni, nie tabela — sześć kolumn na telefonie to scrollowanie w bok.
function stronaJadlospis(doc) {
  const wiersze = planRows(doc.text);
  const teraz = new Date();
  const dd = teraz.getDate(), mm = teraz.getMonth() + 1;

  if (!wiersze.length) return '<div class="tresc">' + md(doc.text) + '</div>';

  const dni = [];
  wiersze.forEach((r) => {
    let g = dni.find((x) => x.dzien === r.dzien);
    if (!g) dni.push(g = { dzien: r.dzien, date: r.date, wiersze: [] });
    g.wiersze.push(r);
  });

  const naglowek = doc.dane.tytul || (doc.text.match(/^#\s+(.*)$/m) || [null, doc.tydzien.tytul])[1];
  const out = ['<div class="naglowek-strony"><p class="duzy">' + esc(naglowek) + '</p>'
    + '<p class="pod">' + wiersze.length + ' ' + odmiana(wiersze.length, 'posiłek', 'posiłki', 'posiłków')
    + ' w ' + dni.length + ' ' + odmiana(dni.length, 'dniu', 'dniach', 'dniach') + '</p></div>'];

  // Plan zapisany przez czat przed akceptacją: widać go tu w całości, ale z jasnym
  // znacznikiem, że to propozycja — zatwierdza się ją w rozmowie, nie samym otwarciem.
  if (doc.dane.status === 'propozycja') {
    out.push('<div class="uwaga">To jest <b>propozycja</b> — do zatwierdzenia w czacie. '
      + 'Napisz tam uwagi albo „zatwierdzam".</div>');
  }

  dni.forEach((g) => {
    const dzis = g.date && +g.date[1] === dd && +g.date[2] === mm;
    out.push('<div class="dzien' + (dzis ? ' dzis' : '') + '"><h2>' + esc(g.dzien) + '</h2>'
      + (dzis ? '<span class="znacznik">dziś</span>' : '') + '</div>');
    g.wiersze.forEach((r) => {
      const link = recipeLink(r.danie, r.przepis, doc.tydzien.slug);
      const uwagi = r.reszta.filter(Boolean).join(' · ');
      const srodek = '<span class="kiedy">' + esc(r.posilek) + '</span>'
        + '<span class="co"><b>' + esc(czysteDanie(r.danie)) + '</b>'
        + (uwagi ? '<small>' + esc(uwagi) + '</small>' : '') + '</span>'
        + (link ? '<span class="ptaszek">&#8250;</span>' : '');
      out.push(link
        ? '<a class="wiersz" href="' + link + '">' + srodek + '</a>'
        : '<div class="wiersz">' + srodek + '</div>');
    });
  });

  // Reszta pliku — wszystko poza tabelą posiłków, z której zrobiliśmy karty dni.
  // Wycinamy WYŁĄCZNIE ten jeden blok, bo plan zawiera też inne tabele: bilans
  // kaloryczny na osobę i dzień oraz korekty porcji. Odsiewanie wszystkich linii
  // zaczynających się od "|" kasowało je razem z liczbami, zostawiając same nagłówki.
  const linie = doc.text.replace(/\r\n/g, '\n').split('\n');
  const blok = blokPlanu(linie);
  const reszta = (blok ? linie.slice(0, blok.od).concat(linie.slice(blok.doo)) : linie)
    .join('\n').replace(/^#\s+.*$/m, '').trim();

  if (reszta) out.push('<div class="tresc" style="margin-top:26px">' + md(reszta) + '</div>');

  return out.join('');
}

// Przycisk planowania: otwiera nową rozmowę w czacie w trybie planowania (mocniejszy
// model na całą sesję). Prośba niesie daty następnego tygodnia, żeby model ich nie
// zgadywał, i nazwę poprzedniego — od pytań o niego skill zaczyna.
function przyciskPlanowania(docs) {
  if (!CZAT_DOSTEPNY) return '';
  const ostatni = docs.length ? docs[docs.length - 1] : null;
  let prosba = 'Ułóż jadłospis na następny tydzień. Zacznij od pytań o miniony tydzień, jak każe skill.';
  if (ostatni && /^\d{4}-\d{2}-\d{2}$/.test(ostatni.do)) {
    const od = new Date(ostatni.do + 'T12:00:00'); od.setDate(od.getDate() + 1);
    const doo = new Date(od); doo.setDate(doo.getDate() + 6);
    const iso = (x) => x.toISOString().slice(0, 10);
    prosba = 'Ułóż jadłospis na następny tydzień: od ' + iso(od) + ' do ' + iso(doo)
      + '. Zacznij od pytań o miniony tydzień (' + ostatni.slug + '), jak każe skill.';
  }
  return '<button class="btn" id="zaplanuj" data-prosba="' + esc(prosba) + '" style="margin-bottom:16px">'
    + 'Zaplanuj następny tydzień</button>';
}

function stronaJadlospisy() {
  const docs = U.tygodnie();
  if (!docs.length) return przyciskPlanowania(docs) + pusto('\u{1F4C5}', 'Nie ma jeszcze żadnego jadłospisu.');
  return przyciskPlanowania(docs) + '<ul class="spis">' + docs.slice().reverse().map((d) =>
    '<li><a href="/jadlospis/' + encodeURIComponent(d.slug) + '">' + esc(d.tytul)
    + (d.status === 'propozycja' ? ' <span class="znacznik">propozycja</span>' : '') + '</a></li>'
  ).join('') + '</ul>';
}

// Zakładka Przepisy pokazuje książkę — to, co lubicie i do czego wracacie — a pod nią
// dania bieżącego tygodnia. Rozdzielone, bo tygodniowa kopia może się różnić od
// książkowej (raz zabrakło twarogu i poszło tofu) i mylenie ich byłoby mylące.
function stronaPrzepisy() {
  const ksiazka = U.przepisyKsiazki();
  const t = U.tydzienBiezacy();
  const tygodniowe = t ? U.przepisyTygodnia(t.slug) : [];

  if (!ksiazka.length && !tygodniowe.length) {
    return pusto('\u{1F4D6}', 'Nie ma jeszcze żadnych przepisów.<br><br>'
      + 'Pojawią się, gdy Claude ułoży jadłospis.');
  }

  const pozycja = (d, href) => '<li data-k="' + esc(d.slug + ' ' + U.norm(d.tytul)) + '">'
    + '<a href="' + href + '">' + esc(d.tytul) + '</a></li>';

  const sekcje = [];
  if (ksiazka.length) {
    sekcje.push('<div class="dzien"><h2>Książka</h2><span class="data">'
      + ksiazka.length + ' ' + odmiana(ksiazka.length, 'przepis', 'przepisy', 'przepisów') + '</span></div>'
      + '<ul class="spis">' + ksiazka.map((d) =>
          pozycja(d, '/ksiazka/' + encodeURIComponent(d.slug))).join('') + '</ul>');
  } else {
    sekcje.push('<div class="uwaga">Książka jest pusta. Otwórz przepis z tego tygodnia '
      + 'i dodaj go do książki, gdy się sprawdzi — wtedy będziesz do niego wracać.</div>');
  }
  if (tygodniowe.length) {
    sekcje.push('<div class="dzien"><h2>Ten tydzień</h2><span class="data">' + esc(t.slug) + '</span></div>'
      + '<ul class="spis">' + tygodniowe.map((d) =>
          pozycja(d, linkPrzepisu(t.slug, d.slug))).join('') + '</ul>');
  }

  const ile = ksiazka.length + tygodniowe.length;
  return '<div class="szukaj"><span class="lupa">\u{1F50D}</span>'
    + '<input id="q" placeholder="Szukaj przepisu" autocomplete="off" aria-label="Szukaj przepisu"></div>'
    + '<p class="licznik" id="licznik">' + ile + ' ' + odmiana(ile, 'przepis', 'przepisy', 'przepisów') + '</p>'
    + '<div id="spis">' + sekcje.join('') + '</div>'
    + pusto('\u{1F50D}', 'Nic nie pasuje.').replace('<div class="pusto"', '<div class="pusto" id="brak" hidden');
}

// Przepis w trybie kuchennym: składniki i kroki do odhaczania, reszta jako treść.
function stronaPrzepis(doc) {
  const skl = ingredients(doc.text);
  const doKupienia = skl.filter((s) => !s.spizarnia);

  const linie = doc.text.replace(/\r\n/g, '\n').split('\n');
  const tytul = doc.dane.tytul || doc.tytul;

  // Wstęp = linie między nagłówkiem a pierwszą sekcją "## ".
  const iH1 = linie.findIndex((l) => /^#\s+/.test(l));
  const iSek = linie.findIndex((l, i) => i > iH1 && /^##\s+/.test(l));
  const wstep = linie.slice(iH1 + 1, iSek < 0 ? linie.length : iSek).join('\n').trim();

  // Plakietki budujemy z nagłówka JSON; linie z kropkami czytamy tylko wtedy, gdy
  // przepis nie został jeszcze zmigrowany.
  const d = doc.dane || {};
  const chipy = [];
  const opis = [];

  if (d.porcje) chipy.push('Porcje: ' + d.porcje + (d.porcje_uwaga ? ' (' + d.porcje_uwaga + ')' : ''));
  if (d.czas_aktywny_min) chipy.push('Czas: ' + d.czas_aktywny_min + ' min');
  if (d.czas_calkowity_min && d.czas_calkowity_min !== d.czas_aktywny_min) {
    chipy.push('Całkowity: ' + d.czas_calkowity_min + ' min');
  }
  if (d.trudnosc) chipy.push(d.trudnosc);
  if (d.kcal && typeof d.kcal === 'object') {
    Object.keys(d.kcal).forEach((kto) => {
      chipy.push(d.kcal[kto] + ' kcal' + (kto === 'porcja' ? '' : ' — ' + kto));
    });
  }
  if (d.bialko_g) chipy.push('białko ' + d.bialko_g + ' g');
  (Array.isArray(d.tagi) ? d.tagi : []).forEach((t) => chipy.push(String(t)));

  wstep.split('\n').filter(Boolean).forEach((l) => {
    if (!chipy.length && l.indexOf('·') >= 0) {
      l.split('·').forEach((c) => { if (c.trim()) chipy.push(c.trim()); });
    } else {
      opis.push(l.trim());
    }
  });

  const out = ['<div class="hero"><h1>' + esc(tytul) + '</h1>'
    + (chipy.length ? '<div class="chipy">' + chipy.map((c, i) =>
        '<span class="chip' + (i === 0 ? ' mocny' : '') + '">' + esc(c) + '</span>').join('') + '</div>' : '')
    + (opis.length ? '<p class="opis">' + opis.map(esc).join('<br>') + '</p>' : '')
    + '</div>'];

  // Zakupy robi się z tygodnia. Przepis w książce to wzorzec — nie wiadomo, na kiedy
  // i w ilu porcjach go ugotujecie, więc ptaszki i przycisk zakupów nie mają tu sensu.
  // Drugie sito za modelem: wykluczenia z profilu sprawdzone deterministycznie na
  // składnikach (lib/alergeny.js). Pokazujemy także „nic nie znaleziono" — brak informacji
  // wyglądałby jak brak sprawdzenia, a rodzina ma wiedzieć, CO zostało sprawdzone.
  const dekl = ALERGENY.deklaracje();
  if (dekl.length) {
    const traf = ALERGENY.trafienia(skl, dekl);
    out.push(traf.length
      ? '<div class="uwaga alarm"><b>Uwaga — składniki wykluczone w profilu:</b><br>'
        + traf.map((t) => esc(ALERGENY.opisTrafienia(t))).join('<br>')
        + '<br><small>Filtr zna tylko nazwy z przepisu — skład produktu ze sklepu sprawdź na etykiecie.</small></div>'
      : '<p class="licznik" style="margin:0 0 12px">Wykluczenia sprawdzone: '
        + esc(ALERGENY.opisDeklaracji(dekl)) + ' — nic nie znaleziono.</p>');
  }

  const wTygodniu = doc.zrodlo !== 'ksiazka';

  if (skl.length) {
    // Ptaszek znaczy "nie trzeba kupować": pozycja jest już na liście Bring! albo
    // pochodzi ze spiżarni. Stan z listy dociąga skrypt, bo odpytanie Bring! przy
    // renderowaniu strony kazałoby czekać na przepis kilka sekund.
    out.push('<div class="sekcja"><h2>Składniki</h2><ul class="skl" id="skl">'
      + skl.map((s, i) => '<li data-i="' + i + '"'
        + ' data-nazwa="' + esc(s.name) + '"'
        + ' data-ile="' + esc(s.specification) + '"'
        + (s.spizarnia ? ' data-spiz="1"' : '')
        + '><span class="box">✓</span>'
        + '<span class="tresc-skl"><span class="nazwa">' + esc(s.name) + '</span>'
        + (s.specification ? '<span class="ile">' + esc(s.specification) + '</span>' : '')
        + (s.spizarnia ? '<span class="spiz">spiżarnia</span>' : '')
        + '</span></li>').join('') + '</ul>'
      // Przycisk zaraz pod listą, a nie na końcu strony: decyzja "czego brakuje"
      // zapada przy patrzeniu na składniki, więc tam ma być czym ją wykonać.
      + (wTygodniu
        ? '<button class="btn" id="dodaj-skladniki" style="margin-top:14px">Sprawdzam listę…</button>'
          + '<p class="licznik" id="stan-skladnikow" style="text-align:center;margin:10px 0 0"></p>'
          + '<button class="btn wtorny" id="reset-skladnikow" style="margin-top:8px" hidden>Zacznij od nowa</button>'
        : '')
      + '</div>');
  }

  // Kroki przygotowania jako ponumerowane bloki do odhaczania.
  const iPrzyg = linie.findIndex((l) => /^##\s+Przygotowanie/i.test(l));
  if (iPrzyg >= 0) {
    const kroki = [];
    for (let i = iPrzyg + 1; i < linie.length; i++) {
      if (/^##\s+/.test(linie[i])) break;
      const m = linie[i].match(/^\s*\d+\.\s+(.*)$/);
      if (m) kroki.push(m[1]);
      else if (kroki.length && linie[i].trim()) kroki[kroki.length - 1] += ' ' + linie[i].trim();
    }
    if (kroki.length) {
      out.push('<div class="sekcja"><h2>Przygotowanie</h2><ol class="kroki" id="kroki">'
        + kroki.map((k, i) => '<li data-i="' + i + '">' + inline(k) + '</li>').join('') + '</ol></div>');
    }
  }

  // Pozostałe sekcje (warianty, zamienniki, "można zrobić wcześniej").
  const pomin = /^##\s+(Składniki|Przygotowanie)/i;
  const inne = [];
  let biore = false;
  linie.forEach((l, i) => {
    if (/^##\s+/.test(l)) biore = !pomin.test(l);
    else if (i <= iH1) return;
    if (biore && /^##\s+/.test(l)) inne.push(l);
    else if (biore) inne.push(l);
  });
  const innyTekst = inne.join('\n').trim();
  if (innyTekst) out.push('<div class="tresc" style="margin-top:8px">' + md(innyTekst) + '</div>');

  // Książka na samym dole — to decyzja po ugotowaniu, nie przed. Awans kopiuje plik,
  // więc późniejsze poprawki w tygodniu nie ruszają już wzorca.
  if (wTygodniu) {
    // Po tytule, nie po slugu: plik w książce nazywa się tytułem przepisu, a plik
    // w tygodniu bywa nazwany skrótem, więc slugi tej samej potrawy się rozjeżdżają.
    const wKsiazce = U.przepisyKsiazki().find((k) => U.norm(k.tytul) === U.norm(tytul));
    out.push('<div class="sekcja ksiazka-akcje">'
      + (wKsiazce
        ? '<p class="licznik" style="text-align:center;margin:0 0 10px">Jest już w książce.</p>'
          + '<a class="btn wtorny" href="/ksiazka/' + encodeURIComponent(wKsiazce.slug) + '">Otwórz w książce</a>'
          + '<button class="btn wtorny" id="do-ksiazki" style="margin-top:8px">Zapisz jako nowy przepis</button>'
        : '<button class="btn wtorny" id="do-ksiazki">Dodaj do książki</button>')
      + '</div>');
  } else {
    out.push('<div class="sekcja ksiazka-akcje">'
      + '<p class="licznik" style="text-align:center;margin:0 0 10px">Przepis z książki — '
      + 'żeby go ugotować, poproś czat o wstawienie go do jadłospisu.</p>'
      + '<button class="btn wtorny" id="z-ksiazki">Usuń z książki</button></div>');
  }

  return out.join('');
}

function stronaZakupy() {
  return '<form class="dodaj" id="f-dodaj" autocomplete="off">'
    + '<input id="poz" placeholder="np. mleko, 2 l" aria-label="Nowa pozycja">'
    + '<button type="submit">Dodaj</button></form>'
    + '<div id="lista">' + pusto('\u{1F6D2}', 'Wczytuję listę…') + '</div>';
}

function stronaLogin(blad) {
  return '<div class="login"><p class="znak">\u{1F373}</p>'
    + '<h2>PrivateChief</h2><p>Podaj PIN, żeby wejść</p>'
    + (blad ? '<div class="uwaga">Zły PIN, spróbuj jeszcze raz.</div>' : '')
    + '<form method="post" action="/login">'
    + '<input name="pin" inputmode="numeric" pattern="[0-9]*" autofocus aria-label="PIN">'
    + '<button class="btn" type="submit">Wejdź</button></form></div>';
}

// ---------------------------------------------------------------- skrypty klienta

const SKRYPT_WSPOLNY = `
function toast(t){var e=document.getElementById('toast');e.textContent=t;e.classList.add('on');
  clearTimeout(e._t);e._t=setTimeout(function(){e.classList.remove('on')},2800);}
function post(url,dane){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify(dane)}).then(function(r){return r.json()});}
function podsumuj(w){var n={};w.forEach(function(x){n[x.status]=(n[x.status]||0)+1});
  var cz=[];
  if(n.added)cz.push('dodano '+n.added);
  if(n.updated)cz.push('zaktualizowano '+n.updated);
  if(n.completed)cz.push('odhaczono '+n.completed);
  if(n.removed)cz.push('usunięto '+n.removed);
  if(n.missing)cz.push('pominięto '+n.missing+' (nie było na liście)');
  if(n.failed)cz.push('nie udało się: '+n.failed);
  return cz.join(', ')||'nic się nie zmieniło';}
`;

const SKRYPT_PRZEPISY = `
(function(){
  var q=document.getElementById('q'), spis=document.getElementById('spis'),
      brak=document.getElementById('brak'), licz=document.getElementById('licznik');
  if(!q)return;
  var poz=[].slice.call(spis.querySelectorAll('li[data-k]')), wszystkie=poz.length;
  var listy=[].slice.call(spis.querySelectorAll('ul'));
  function norm(s){return s.toLowerCase().replace(/ł/g,'l')
    .normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,'');}
  function odmiana(n){if(n===1)return 'przepis';var d=n%10,s=n%100;
    return (d>=2&&d<=4&&(s<12||s>14))?'przepisy':'przepisów';}
  q.addEventListener('input',function(){
    var f=norm(q.value), widoczne=0;
    poz.forEach(function(li){
      var ok=!f||norm(li.dataset.k).indexOf(f)>=0;
      li.hidden=!ok; if(ok)widoczne++;
    });
    // Pusta sekcja chowa sie razem ze swoim naglowkiem, zeby nie zostawalo
    // samotne "Ksiazka" nad niczym.
    listy.forEach(function(ul){
      var ma=[].slice.call(ul.querySelectorAll('li[data-k]')).some(function(li){return !li.hidden});
      ul.hidden=!ma;
      var h=ul.previousElementSibling;
      if(h&&h.classList.contains('dzien'))h.hidden=!ma;
    });
    brak.hidden=widoczne>0;
    licz.textContent=f?(widoczne+' z '+wszystkie):(wszystkie+' '+odmiana(wszystkie));
  });
})();
`;

const SKRYPT_PRZEPIS = SKRYPT_WSPOLNY + `
(function(){
  var skl=document.getElementById('skl'), btn=document.getElementById('dodaj-skladniki'),
      stanTxt=document.getElementById('stan-skladnikow'), kroki=document.getElementById('kroki'),
      reset=document.getElementById('reset-skladnikow');
  // Adres to /tydzien/<tydzien>/<przepis> albo /ksiazka/<przepis>.
  var czesci=location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  var wKsiazce=czesci[0]==='ksiazka';
  var tydzien=wKsiazce?'':czesci[1];
  var slug=wKsiazce?czesci[1]:czesci[2];
  var param='przepis='+encodeURIComponent(slug)+'&tydzien='+encodeURIComponent(tydzien);

  // Postep gotowania zostaje w telefonie — to rzecz osobista i chwilowa, inaczej niz
  // stan zakupow, ktory musi byc wspolny dla domownikow.
  if(kroki){
    var KL='pc:kroki:'+location.pathname, stanKrokow={};
    try{stanKrokow=JSON.parse(localStorage.getItem(KL)||'{}')}catch(e){}
    [].slice.call(kroki.children).forEach(function(li){
      if(stanKrokow[li.dataset.i])li.classList.add('ok');
      li.addEventListener('click',function(){
        li.classList.toggle('ok');
        stanKrokow[li.dataset.i]=li.classList.contains('ok');
        try{localStorage.setItem(KL,JSON.stringify(stanKrokow))}catch(e){}
      });
    });
  }

  // Ksiazka: awans kopiuje plik, wiec przy kolizji nazw pytamy czlowieka zamiast
  // nadpisywac — to moze byc inny przepis o tej samej nazwie albo nowa wersja tego samego.
  var doKs=document.getElementById('do-ksiazki');
  if(doKs){
    doKs.addEventListener('click',function(){
      if(doKs.disabled)return;
      doKs.disabled=true;var byl=doKs.textContent;doKs.textContent='Dodaję…';
      function wyslij(tytul){
        return post('/api/ksiazka/dodaj',{tydzien:tydzien,przepis:slug,tytul:tytul||''});
      }
      wyslij('').then(function(d){
        if(d&&d.kolizja){
          var nowy=prompt('W książce jest już „'+d.tytul+'". Pod jaką nazwą zapisać ten?',d.propozycja);
          if(!nowy){doKs.disabled=false;doKs.textContent=byl;return null}
          return wyslij(nowy);
        }
        return d;
      }).then(function(d){
        if(!d)return;
        doKs.textContent=byl;
        if(d.blad){doKs.disabled=false;toast(d.blad);return}
        toast('W książce: '+d.tytul);
        setTimeout(function(){location.href='/ksiazka/'+encodeURIComponent(d.slug)},700);
      }).catch(function(){doKs.disabled=false;doKs.textContent=byl;toast('Brak połączenia z serwerem.')});
    });
  }

  var zKs=document.getElementById('z-ksiazki');
  if(zKs){
    zKs.addEventListener('click',function(){
      if(!confirm('Usunąć ten przepis z książki? Zostanie w historii gita.'))return;
      zKs.disabled=true;zKs.textContent='Usuwam…';
      post('/api/ksiazka/usun',{przepis:slug}).then(function(d){
        if(d.blad){zKs.disabled=false;zKs.textContent='Usuń z książki';toast(d.blad);return}
        location.href='/przepisy';
      }).catch(function(){zKs.disabled=false;zKs.textContent='Usuń z książki';toast('Brak połączenia z serwerem.')});
    });
  }

  // Na stronie z ksiazki nie ma przyciskow zakupow — ptaszki naleza do tygodnia.
  if(!skl||!btn)return;
  var pozycje=[].slice.call(skl.children), stan={}, zajety=false;

  function odmianaSkl(n){if(n===1)return 'składnik';var d=n%10,s=n%100;
    return (d>=2&&d<=4&&(s<12||s>14))?'składniki':'składników'}

  function przerysuj(){
    var brakuje=[];
    pozycje.forEach(function(li){
      var s=stan[li.dataset.nazwa];
      var ok=s? s.odhaczony : li.dataset.spiz==='1';
      li.classList.toggle('ok',ok);
      li.title=s&&s.powod? 'Odhaczone: '+s.powod : '';
      if(!ok)brakuje.push({name:li.dataset.nazwa,specification:li.dataset.ile||''});
    });
    btn.disabled=brakuje.length===0||zajety;
    btn.classList.toggle('wtorny',brakuje.length===0);
    btn.textContent=zajety? 'Dodaję…' : (brakuje.length
      ? 'Dodaj '+brakuje.length+' '+odmianaSkl(brakuje.length)+' do zakupów'
      : 'Wszystko załatwione');
    var ile=pozycje.length-brakuje.length;
    stanTxt.textContent=ile? ile+' z '+pozycje.length+' odhaczonych' : '';
    if(reset)reset.hidden=ile===0;
    return brakuje;
  }

  function przyjmij(d){
    if(d&&d.skladniki){stan={};d.skladniki.forEach(function(s){stan[s.name]=s});}
    przerysuj();
    return d;
  }

  function pobierz(){
    return fetch('/api/skladniki?'+param)
      .then(function(r){return r.json()}).then(przyjmij)
      .catch(function(){stanTxt.textContent='Nie mogę sprawdzić listy zakupów.';przerysuj()});
  }

  // Dotkniecie zapisuje decyzje na serwerze, zeby widzieli ja wszyscy domownicy.
  skl.addEventListener('click',function(e){
    var li=e.target.closest('li'); if(!li)return;
    var nazwa=li.dataset.nazwa;
    var teraz=stan[nazwa]? stan[nazwa].odhaczony : li.dataset.spiz==='1';
    stan[nazwa]={name:nazwa,odhaczony:!teraz,powod:'zapamiętane'};   // od razu, bez czekania
    przerysuj();
    post('/api/skladniki/przelacz',{przepis:slug,tydzien:tydzien,nazwa:nazwa,zalatwione:!teraz})
      .then(przyjmij)
      .catch(function(){toast('Nie zapisałem zmiany — brak połączenia.');pobierz()});
  });

  if(reset){
    reset.addEventListener('click',function(){
      post('/api/skladniki/reset',{przepis:slug,tydzien:tydzien}).then(przyjmij)
        .then(function(){toast('Odhaczenia wyczyszczone')})
        .catch(function(){toast('Nie udało się wyczyścić.')});
    });
  }

  btn.addEventListener('click',function(){
    var brakuje=przerysuj();
    if(!brakuje.length||zajety)return;
    zajety=true;przerysuj();
    post('/api/skladniki/dodaj',{przepis:slug,tydzien:tydzien,items:brakuje}).then(function(d){
      zajety=false;
      if(d.blad){przerysuj();toast(d.blad);return}
      przyjmij(d);
      if(d.raport)toast(podsumuj(d.raport));
    }).catch(function(){
      zajety=false;przerysuj();toast('Brak połączenia z serwerem.');
    });
  });

  przerysuj();
  pobierz();
})();
`;

const SKRYPT_ZAKUPY = SKRYPT_WSPOLNY + `
function esc(s){return String(s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function odmianaPoz(n){if(n===1)return 'pozycja';var d=n%10,s=n%100;
  return (d>=2&&d<=4&&(s<12||s>14))?'pozycje':'pozycji';}
function rysuj(d){
  var h='';
  if(d.uwaga) h+='<div class="uwaga">'+esc(d.uwaga)+'</div>';
  if(!d.purchase.length){
    h+='<div class="pusto"><span class="ikona">\\u{1F6D2}</span>Lista jest pusta.<br>'
      +'Dopisz coś powyżej albo wejdź w przepis.</div>';
  } else {
    h+='<p class="licznik">'+d.purchase.length+' '+odmianaPoz(d.purchase.length)+' do kupienia</p>';
    d.purchase.forEach(function(i){
      h+='<div class="poz" data-n="'+esc(i.name)+'">'
        +'<button class="kolko" aria-label="Kupione">\\u2713</button>'
        +'<div class="txt"><b>'+esc(i.name)+'</b>'+(i.specification?'<i>'+esc(i.specification)+'</i>':'')+'</div>'
        +'<button class="x" aria-label="Usuń">&times;</button></div>';
    });
  }
  if(d.recently.length){
    h+='<details class="zwijane"><summary>Ostatnio kupione ('+d.recently.length+')</summary><div style="margin-top:8px">';
    d.recently.slice(0,15).forEach(function(i){
      h+='<div class="poz zrobione" data-n="'+esc(i.name)+'" data-wroc="1">'
        +'<div class="txt"><b>'+esc(i.name)+'</b>'+(i.specification?'<i>'+esc(i.specification)+'</i>':'')+'</div>'
        +'<button class="x" aria-label="Dodaj z powrotem">+</button></div>';
    });
    h+='</div></details>';
  }
  document.getElementById('lista').innerHTML=h;
}
function wczytaj(){return fetch('/api/zakupy').then(function(r){return r.json()}).then(function(d){
  if(d.blad){document.getElementById('lista').innerHTML='<div class="uwaga">'+esc(d.blad)+'</div>';return}
  rysuj(d);
}).catch(function(){
  document.getElementById('lista').innerHTML='<div class="uwaga">Brak połączenia z serwerem. '
    +'Sprawdź, czy komputer z aplikacją jest włączony.</div>';
})}
document.getElementById('f-dodaj').addEventListener('submit',function(e){
  e.preventDefault();
  var pole=document.getElementById('poz'), v=pole.value.trim();
  if(!v)return;
  var cz=v.split(/\\s*[,—–]\\s*|\\s+-\\s+/);
  var poz={name:cz[0].trim(),specification:cz.slice(1).join(', ').trim()};
  pole.value=''; pole.blur();
  post('/api/zakupy/dodaj',{items:[poz]}).then(function(d){
    if(d.blad){toast(d.blad);return}
    toast(podsumuj(d.results));wczytaj();
  }).catch(function(){toast('Brak połączenia z serwerem.')});
});
document.getElementById('lista').addEventListener('click',function(e){
  var poz=e.target.closest('.poz'); if(!poz)return;
  var nazwa=poz.dataset.n;
  if(e.target.classList.contains('x')){
    poz.classList.add('znika');
    var url=poz.dataset.wroc?'/api/zakupy/dodaj':'/api/zakupy/usun';
    var dane=poz.dataset.wroc?{items:[{name:nazwa,specification:''}]}:{items:[{name:nazwa}]};
    post(url,dane).then(function(d){toast(podsumuj(d.results));wczytaj()})
      .catch(function(){poz.classList.remove('znika');toast('Brak połączenia z serwerem.')});
    return;
  }
  if(e.target.classList.contains('kolko')){
    poz.classList.add('znika');
    post('/api/zakupy/kup',{items:[{name:nazwa}]}).then(function(d){
      toast(podsumuj(d.results));wczytaj()
    }).catch(function(){poz.classList.remove('znika');toast('Brak połączenia z serwerem.')});
  }
});
wczytaj();
`;

// ---------------------------------------------------------------- czat
//
// Czat nie jest osobną stroną, tylko panelem dostępnym z każdego ekranu: na telefonie
// wysuwa się od dołu nad treścią, a od 900 px dokuje po prawej i zwęża stronę — wtedy
// widać jednocześnie przepis i rozmowę. Aplikacja jest wielostronicowa, więc przejście
// do innego widoku zamyka arkusz na telefonie (i tak zasłaniałby to, co właśnie kliknięto),
// a w trybie zadokowanym otwiera się z powrotem.

const CSS_CZAT = `
.fab{position:fixed;right:16px;bottom:calc(78px + env(safe-area-inset-bottom));z-index:25;
  width:54px;height:54px;border:0;border-radius:50%;background:var(--accent);color:#fff;
  font-size:23px;line-height:1;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.24)}
.fab:active{transform:scale(.94)}
/* Stan otwarcia to wyłącznie klasa .on — bez atrybutu hidden i bez
   requestAnimationFrame. Klatka animacji nie odpala się, gdy strona jest ukryta,
   a wtedy panel zostawał odsunięty poza ekran mimo kliknięcia. */
/* Stan otwarcia zależy WYŁĄCZNIE od klasy .on i od właściwości bez przejścia.
   Animacja jest osobną, czysto ozdobną warstwą (@keyframes), bo ani
   requestAnimationFrame, ani przejścia CSS nie postępują, gdy strona jest ukryta
   albo uśpiona — a wtedy panel zostawał zamrożony poza ekranem mimo kliknięcia. */
.zaslona{position:fixed;inset:0;z-index:28;background:rgba(0,0,0,.4);
  visibility:hidden;pointer-events:none;backdrop-filter:blur(1px)}
.zaslona.on{visibility:visible;pointer-events:auto;animation:zaslonaWejdz .22s ease}
@keyframes zaslonaWejdz{from{opacity:0}to{opacity:1}}

.panel{position:fixed;z-index:29;display:flex;flex-direction:column;background:var(--bg);
  left:0;right:0;bottom:0;height:80vh;border-radius:20px 20px 0 0;
  border-top:1px solid var(--line);box-shadow:0 -6px 28px rgba(0,0,0,.2);
  visibility:hidden}
/* Bez animacji wjazdu. Zamrożona animacja (ukryta karta, uśpiona przeglądarka,
   oszczędzanie energii) zatrzymuje się na pierwszej klatce i przypina panel poza
   ekranem — czyli dokładnie objaw "czat jest za głównym ekranem". Otwarcie ma być
   natychmiastowe; ozdobne jest tylko przyciemnienie tła, którego zamarcie niczego
   nie blokuje. */
.panel.on{visibility:visible}
.panel .gora{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);flex:0 0 auto}
.panel .gora .uchwyt{position:absolute;top:7px;left:50%;transform:translateX(-50%);
  width:38px;height:4px;border-radius:99px;background:var(--line)}
.panel .gora b{flex:1;font-size:15px;font-weight:650}
.panel .gora .tryb{font-size:11.5px;line-height:1.2;color:var(--muted);border:1px solid var(--line);
  border-radius:999px;padding:3px 9px;white-space:nowrap;cursor:pointer;background:transparent}
.panel .gora .tryb.plan{color:var(--accent);border-color:var(--accent);font-weight:600}
.panel .gora button{background:transparent;border:0;color:var(--muted);font-size:24px;
  line-height:1;padding:2px 6px;cursor:pointer}
.panel .srodek{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:16px}
.panel .dol{flex:0 0 auto;border-top:1px solid var(--line);padding:10px 12px;
  padding-bottom:calc(10px + env(safe-area-inset-bottom))}
.panel .dol form{display:flex;gap:8px}
.panel .dol textarea{flex:1;min-width:0;resize:none;max-height:110px;padding:11px 14px;
  border:1px solid var(--line);border-radius:20px;background:var(--surface);color:var(--text);
  font-size:15px;line-height:1.4}
.panel .dol button{flex:0 0 auto;width:42px;height:42px;align-self:flex-end;border:0;
  border-radius:50%;background:var(--accent);color:#fff;font-size:18px;cursor:pointer}
.panel .dol button[disabled]{opacity:.45}

.czat{display:flex;flex-direction:column;gap:11px}
.bab{max-width:88%;padding:11px 14px;border-radius:17px;font-size:15px;line-height:1.5;
  white-space:pre-wrap;word-wrap:break-word}
.bab.ja{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:5px}
.bab.on{align-self:flex-start;background:var(--surface);border:1px solid var(--line);border-bottom-left-radius:5px}
.bab.blad{align-self:flex-start;background:var(--surface);border:1px solid var(--line);
  border-left:3px solid var(--danger);color:var(--muted);font-size:14px}
.bab .pliki{display:block;margin-top:9px;padding-top:9px;border-top:1px solid var(--line);
  color:var(--muted);font-size:12.5px;white-space:normal}
.bab.ja .pliki{border-top-color:rgba(255,255,255,.35);color:rgba(255,255,255,.85)}
.mysli{align-self:flex-start;display:flex;gap:5px;padding:13px 15px;background:var(--surface);
  border:1px solid var(--line);border-radius:17px;border-bottom-left-radius:5px}
.mysli i{width:7px;height:7px;border-radius:50%;background:var(--muted);animation:puls 1.3s infinite}
.mysli i:nth-child(2){animation-delay:.18s}
.mysli i:nth-child(3){animation-delay:.36s}
@keyframes puls{0%,60%,100%{opacity:.25}30%{opacity:.9}}
.podpowiedzi{display:flex;flex-wrap:wrap;gap:7px;margin:14px 0 0}
.podpowiedzi button{background:var(--surface);border:1px solid var(--line);color:var(--muted);
  border-radius:999px;padding:8px 13px;font-size:13.5px;cursor:pointer;text-align:left}
.podpowiedzi button:active{border-color:var(--accent);color:var(--accent)}
.czat-pusty{color:var(--muted);font-size:14px;line-height:1.55}
.ai-info{margin:0 0 14px;padding:8px 12px;border:1px dashed var(--line);border-radius:var(--r-mala);
  color:var(--muted);font-size:12.5px;line-height:1.45}
/* Ostrzeżenie o wykluczeniach: ma się różnić od zwykłej uwagi, bo tu chodzi o alergię. */
.uwaga.alarm{border-left-color:#c0392b;color:var(--text);background:rgba(192,57,43,.07)}
.uwaga.alarm small{color:var(--muted)}

/* Szeroki ekran: panel dokuje po prawej i zwęża stronę zamiast ją zasłaniać. */
@media(min-width:900px){
  .panel{left:auto;right:0;top:0;bottom:0;width:390px;height:auto;border-radius:0;
    border-top:0;border-left:1px solid var(--line);
    box-shadow:-6px 0 28px rgba(0,0,0,.12)}
  /* w trybie zadokowanym tez bez animacji — z tego samego powodu */
  .panel .gora .uchwyt{display:none}
  .zaslona{display:none}
  body.panel-otwarty{padding-right:390px}
  body.panel-otwarty nav{right:390px}
  body.panel-otwarty .fab{display:none}
}
`;

// Panel wstrzykiwany do każdej strony po zalogowaniu.
function panelCzatu(dostepny) {
  if (!dostepny) return '';
  const podpowiedzi = [
    'Co dziś na obiad?',
    'Dodaj mleko do zakupów',
    'Zamień środowy obiad na coś szybszego',
    'Czego brakuje do jutrzejszej kolacji?'
  ];
  return '<button class="fab" id="fab" aria-label="Otwórz czat">\u{1F4AC}</button>'
    + '<div class="zaslona" id="zaslona"></div>'
    + '<aside class="panel" id="panel" aria-label="Czat">'
    // Plakietka trybu widoczna zawsze (zwykły · sonnet / planowanie · opus) i klikalna:
    // przełączenie trybu zaczyna nową rozmowę, bo tryb jest własnością sesji.
    + '<div class="gora"><span class="uchwyt"></span><b>Czat</b>'
    + '<button type="button" class="tryb" id="tryb-czatu"'
    + ' data-zwykly="' + esc(CZAT.MODELE.zwykly) + '" data-planowanie="' + esc(CZAT.MODELE.planowanie) + '"'
    + ' title="Przełącz tryb (zaczyna nową rozmowę)"></button>'
    + '<button id="czysc" title="Nowa rozmowa" aria-label="Nowa rozmowa">&#8635;</button>'
    + '<button id="zamknij" aria-label="Zamknij czat">&times;</button></div>'
    + '<div class="srodek" id="srodek">'
    // Stała informacja, nie jednorazowy popup: do czatu zagląda dziecko albo gość, dla
    // których „oczywiste" nie jest oczywiste. Widoczna zawsze, nie tylko w pustej rozmowie.
    + '<p class="ai-info">Rozmawiasz z asystentem AI (Claude). Może się mylić — także co do '
    + 'składników. Plan i zakupy zatwierdza człowiek.</p>'
    + '<div class="czat" id="czat"></div>'
    + '<div id="powitanie" class="czat-pusty">Zapytaj o cokolwiek z jadłospisu — mogę też '
    + 'zmienić plan albo dopisać coś do zakupów.'
    + '<div class="podpowiedzi" id="podpowiedzi">'
    + podpowiedzi.map((p) => '<button type="button">' + esc(p) + '</button>').join('')
    + '</div></div></div>'
    + '<div class="dol"><form id="f-czat">'
    + '<textarea id="tresc" rows="1" placeholder="Napisz wiadomość" aria-label="Wiadomość"></textarea>'
    + '<button type="submit" aria-label="Wyślij">&#8593;</button>'
    + '</form></div></aside>';
}

const SKRYPT_CZAT = SKRYPT_WSPOLNY + `
(function(){
  var panel=document.getElementById('panel'), fab=document.getElementById('fab'),
      zaslona=document.getElementById('zaslona'), srodek=document.getElementById('srodek'),
      czat=document.getElementById('czat'), form=document.getElementById('f-czat'),
      pole=document.getElementById('tresc'), przycisk=form.querySelector('button[type=submit]'),
      podp=document.getElementById('podpowiedzi'), powitanie=document.getElementById('powitanie'),
      zamknij=document.getElementById('zamknij'), czysc=document.getElementById('czysc');
  if(!panel)return;

  var KL='pc:czat', KL_OTW='pc:czat-otwarty', zajety=false, wHistorii=false;
  var szeroki=function(){return window.matchMedia('(min-width:900px)').matches};

  function esc(s){return String(s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}

  // Otwarty czat dokłada wpis do historii, żeby "wstecz" zamykało panel zamiast
  // wyrzucać z przepisu. Na telefonie to odruch — otwierasz arkusz nad treścią
  // i cofasz się, żeby wrócić do tego, co pod spodem.
  function otworz(zHistorii){
    panel.classList.add('on');
    if(!szeroki())zaslona.classList.add('on');
    document.body.classList.add('panel-otwarty');
    try{sessionStorage.setItem(KL_OTW,'1')}catch(e){}
    if(!zHistorii&&!wHistorii){
      try{history.pushState({pcPanel:1},'',location.href);wHistorii=true}catch(e){}
    }
    srodek.scrollTop=srodek.scrollHeight;
    if(szeroki())pole.focus();
  }

  function zwin(){
    panel.classList.remove('on'); zaslona.classList.remove('on');
    document.body.classList.remove('panel-otwarty');
    try{sessionStorage.removeItem(KL_OTW)}catch(e){}
  }

  // Zamknięcie przyciskiem cofa historię, żeby nie zostawiać martwego wpisu,
  // przez który trzeba by kliknąć "wstecz" dwa razy.
  function zamknijPanel(){
    if(wHistorii){wHistorii=false;history.back();return}
    zwin();
  }

  window.addEventListener('popstate',function(){
    wHistorii=false;
    if(panel.classList.contains('on'))zwin();
  });

  // Uwaga: bez opakowania handler dostałby obiekt zdarzenia jako pierwszy argument,
  // czyli otworz() uznałoby, że otwarcie przyszło z historii, i nie dodało wpisu.
  fab.addEventListener('click',function(){otworz()});
  zamknij.addEventListener('click',zamknijPanel);
  zaslona.addEventListener('click',zamknijPanel);
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&panel.classList.contains('on'))zamknijPanel();
  });

  function dodaj(kto,tekst,pliki){
    var d=document.createElement('div');
    d.className='bab '+kto;
    d.innerHTML=esc(tekst)+(pliki&&pliki.length
      ? '<span class="pliki">Zmienione pliki: '+esc(pliki.join(', '))+'</span>' : '');
    czat.appendChild(d);
    srodek.scrollTop=srodek.scrollHeight;
    if(powitanie)powitanie.hidden=true;
    return d;
  }

  var hist=[];
  try{hist=JSON.parse(sessionStorage.getItem(KL)||'[]')}catch(e){}
  hist.forEach(function(m){dodaj(m.kto,m.tekst,m.pliki)});
  function zapisz(kto,tekst,pliki){
    hist.push({kto:kto,tekst:tekst,pliki:pliki});
    try{sessionStorage.setItem(KL,JSON.stringify(hist.slice(-40)))}catch(e){}
  }

  // Plakietka trybu: widoczna tylko przy planowaniu, bo to wtedy chodzi mocniejszy
  // (droższy) model i domownik ma to widzieć. Zapamiętana w sesji karty, bo sesja
  // czatu po stronie serwera przeżywa przeładowanie strony.
  // Plakietka trybu widoczna zawsze: „zwykły · sonnet" albo „planowanie · opus". Nazwy
  // modeli przychodzą z serwera w data-*, więc widać je od razu, nie dopiero po pierwszej
  // odpowiedzi (planowanie na mocnym modelu potrafi myśleć minutę, zanim coś powie).
  // Stan trzymany w sesji karty, bo rozmowa po stronie serwera przeżywa przeładowanie.
  var plakietka=document.getElementById('tryb-czatu'), trybNastepny='';
  function pokazTryb(tryb,model){
    if(!plakietka)return;
    var plan=tryb==='planowanie';
    var nazwa=model||(plan?plakietka.dataset.planowanie:plakietka.dataset.zwykly)||'';
    plakietka.textContent=(plan?'planowanie':'zwykły')+(nazwa?' · '+nazwa:'');
    plakietka.classList.toggle('plan',plan);
    try{if(plan)sessionStorage.setItem(KL+':tryb',nazwa);else sessionStorage.removeItem(KL+':tryb')}catch(e){}
  }
  (function(){var zt=null;try{zt=sessionStorage.getItem(KL+':tryb')}catch(e){}
    pokazTryb(zt!==null?'planowanie':'zwykly',zt||'')})();

  // Tryb należy do rozmowy, więc zmiana trybu = nowa rozmowa. Tryb „na następną
  // wiadomość" pamiętamy tutaj, bo serwer dowie się o nim dopiero przy wysyłce.
  function nowaRozmowa(tryb){
    hist=[];czat.innerHTML='';
    if(powitanie)powitanie.hidden=false;
    try{sessionStorage.removeItem(KL)}catch(e){}
    trybNastepny=tryb==='planowanie'?'planowanie':'';
    pokazTryb(trybNastepny||'zwykly');
    return fetch('/api/czat/nowa',{method:'POST'}).catch(function(){});
  }
  czysc.addEventListener('click',function(){nowaRozmowa();toast('Zaczynamy od nowa — tryb zwykły')});
  if(plakietka)plakietka.addEventListener('click',function(){
    var naPlan=!plakietka.classList.contains('plan');
    if(!confirm(naPlan
      ?'Zacząć nową rozmowę w trybie planowania? Chodzi wtedy mocniejszy model ('+(plakietka.dataset.planowanie||'')+').'
      :'Wrócić do trybu zwykłego? To zaczyna nową rozmowę; obecna przepadnie.'))return;
    nowaRozmowa(naPlan?'planowanie':'');
    toast(naPlan?'Nowa rozmowa: planowanie':'Nowa rozmowa: tryb zwykły');
  });

  function rosnij(){pole.style.height='auto';pole.style.height=Math.min(pole.scrollHeight,110)+'px'}
  pole.addEventListener('input',rosnij);

  function wyslij(tekst,tryb){
    if(zajety||!tekst.trim())return;
    zajety=true;przycisk.disabled=true;
    dodaj('ja',tekst);zapisz('ja',tekst);
    pole.value='';rosnij();

    var czeka=document.createElement('div');
    czeka.className='mysli';czeka.innerHTML='<i></i><i></i><i></i>';
    czat.appendChild(czeka);srodek.scrollTop=srodek.scrollHeight;

    // Tryb z przycisku albo ustawiony plakietką na tę rozmowę; plakietka od razu,
    // nie dopiero po odpowiedzi.
    var t=tryb||trybNastepny;trybNastepny='';
    if(t==='planowanie')pokazTryb('planowanie');

    post('/api/czat',{wiadomosc:tekst,tryb:t||''}).then(function(d){
      czeka.remove();
      if(d.blad){dodaj('blad',d.blad);zapisz('blad',d.blad);}
      else{
        pokazTryb(d.tryb,d.model);
        dodaj('on',d.tekst,d.pliki);zapisz('on',d.tekst,d.pliki);
        // Zmiana w plikach albo w zakupach dotyczy tego, co widać pod spodem.
        if(d.pliki&&d.pliki.length)toast('Zmieniono pliki — odśwież widok, żeby zobaczyć');
      }
    }).catch(function(){
      czeka.remove();
      var m='Brak połączenia z serwerem.';dodaj('blad',m);zapisz('blad',m);
    }).then(function(){zajety=false;przycisk.disabled=false;});
  }

  form.addEventListener('submit',function(e){e.preventDefault();wyslij(pole.value)});
  pole.addEventListener('keydown',function(e){
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();wyslij(pole.value)}
  });
  podp.addEventListener('click',function(e){
    if(e.target.tagName==='BUTTON')wyslij(e.target.textContent);
  });

  // „Zaplanuj następny tydzień" (lista jadłospisów, koniec planu): nowa rozmowa w trybie
  // planowania — mocniejszy model na całą sesję — z gotową pierwszą prośbą z datami.
  var zaplanuj=document.getElementById('zaplanuj');
  if(zaplanuj)zaplanuj.addEventListener('click',function(){
    var prosba=zaplanuj.dataset.prosba||'Ułóż jadłospis na następny tydzień.';
    zaplanuj.disabled=true;
    nowaRozmowa('planowanie').then(function(){otworz();wyslij(prosba,'planowanie');zaplanuj.disabled=false;});
  });

  // Po przejściu na inną stronę wracamy do otwartego panelu tylko w trybie zadokowanym;
  // na telefonie arkusz zasłaniałby to, co użytkownik właśnie kliknął.
  // Po przejściu na inną stronę wracamy do otwartego panelu tylko w trybie zadokowanym
  // (na telefonie zasłaniałby to, co kliknięto), a wejście na /czat otwiera go wprost.
  try{
    if(window.PC_OTWORZ_CZAT) otworz();
    else if(sessionStorage.getItem(KL_OTW)&&szeroki()) otworz(true);
  }catch(e){}
})();
`;

// ---------------------------------------------------------------- HTTP

function ciasteczka(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function zalogowany(req) {
  return ciasteczka(req).pc_auth === TOKEN;
}

function odpowiedz(res, kod, typ, tresc) {
  // Strony: "no-cache" — przeglądarka odświeża je przy każdym wejściu, ale wolno jej
  // trzymać kopię, dzięki czemu działa bfcache i "wstecz" wraca natychmiast, w to samo
  // miejsce listy. "no-store" to blokuje i każdy powrót był pełnym przeładowaniem
  // ze skokiem na górę strony.
  // Odpowiedzi API zostają przy "no-store" — to stan listy zakupów, który ma być świeży.
  const strona = typ === 'text/html';
  const naglowki = {
    'Content-Type': typ + '; charset=utf-8',
    'Cache-Control': strona ? 'no-cache, must-revalidate' : 'no-store'
  };
  if (res._ciastko) naglowki['Set-Cookie'] = res._ciastko;
  res.writeHead(kod, naglowki);
  res.end(tresc);
}

const html = (res, tresc, kod) => odpowiedz(res, kod || 200, 'text/html', tresc);
const json = (res, dane, kod) => odpowiedz(res, kod || 200, 'application/json', JSON.stringify(dane));

// Zbieramy bufory i dekodujemy dopiero na końcu. Sklejanie po kawałku ("b += d")
// dekodowałoby każdą porcję osobno, więc znak dwubajtowy na granicy porcji — a przy
// polskich nazwach to kwestia czasu — rozpadłby się na U+FFFD.
function czytajBody(req) {
  return new Promise((resolve) => {
    const bufs = [];
    let len = 0;
    req.on('data', (d) => {
      len += d.length;
      if (len > 1e6) { req.destroy(); return; }
      bufs.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')));
  });
}

async function router(req, res) {
  const u = new URL(req.url, 'http://x');
  const sciezka = decodeURIComponent(u.pathname);

  // --- logowanie
  if (sciezka === '/login') {
    if (req.method === 'POST') {
      const body = await czytajBody(req);
      const pin = new URLSearchParams(body).get('pin') || '';
      if (pin.trim() === String(CONFIG.pin)) {
        res.writeHead(302, {
          'Set-Cookie': 'pc_auth=' + TOKEN + '; Path=/; Max-Age=31536000; SameSite=Lax',
          Location: '/'
        });
        return res.end();
      }
      return html(res, layout('Wejście', stronaLogin(true), false, null), 401);
    }
    return html(res, layout('Wejście', stronaLogin(false), false, null));
  }
  if (!zalogowany(req)) {
    if (sciezka.indexOf('/api/') === 0) return json(res, { blad: 'Sesja wygasła — odśwież stronę i podaj PIN.' }, 401);
    return html(res, layout('Wejście', stronaLogin(false), false, null), 401);
  }

  // Każde urządzenie dostaje własny identyfikator, żeby rozmowy w czacie się nie mieszały —
  // ciasteczko PIN-u jest wspólne dla całego domu i do tego się nie nadaje.
  if (!ciasteczka(req).pc_dev) {
    res._ciastko = 'pc_dev=' + crypto.randomBytes(8).toString('hex')
      + '; Path=/; Max-Age=31536000; SameSite=Lax';
  }

  // --- API listy zakupów
  if (sciezka.indexOf('/api/zakupy') === 0) {
    try {
      if (sciezka === '/api/zakupy') {
        const r = await B.readList(LISTA);
        const uwaga = r.appLanguage && r.appLanguage !== r.language
          ? 'Lista „' + r.list.name + '" ma w aplikacji Bring! język ' + r.appLanguage
            + ', więc na telefonie nazwy z katalogu zobaczysz po ' + r.appLanguage.slice(0, 2) + '.'
          : '';
        return json(res, { list: r.list, purchase: r.purchase, recently: r.recently, uwaga });
      }
      const dane = JSON.parse((await czytajBody(req)) || '{}');
      const items = dane.items;
      if (!Array.isArray(items) || !items.length) return json(res, { blad: 'Brak pozycji.' }, 400);

      const fn = sciezka === '/api/zakupy/dodaj' ? B.addItems
        : sciezka === '/api/zakupy/kup' ? B.completeItems
        : sciezka === '/api/zakupy/usun' ? B.removeItems : null;
      if (!fn) return json(res, { blad: 'Nieznana operacja.' }, 404);

      const r = await fn(LISTA, items);
      return json(res, { list: r.list, results: r.results });
    } catch (e) {
      return json(res, { blad: e.message }, 500);
    }
  }

  // --- strony
  if (sciezka === '/') return html(res, layout('Dziś', stronaDzis(), '/'));

  if (sciezka === '/jadlospisy') {
    return html(res, layout('Jadłospisy', stronaJadlospisy(), '/jadlospisy'));
  }
  if (sciezka.indexOf('/jadlospis/') === 0) {
    const p = U.plan(decodeURIComponent(sciezka.slice('/jadlospis/'.length)));
    if (!p) return html(res, layout('Nie znaleziono', pusto('\u{1F4C5}', 'Nie ma takiego jadłospisu.'),
      '/jadlospisy', '/jadlospisy'), 404);
    return html(res, layout(p.tydzien.tytul, stronaJadlospis(p), '/jadlospisy', '/jadlospisy'));
  }
  if (sciezka === '/przepisy') {
    return html(res, layout('Przepisy', stronaPrzepisy(), '/przepisy', null, SKRYPT_PRZEPISY));
  }

  // Dwa osobne adresy, bo ten sam slug żyje w obu miejscach — kopia tygodniowa może
  // się różnić od książkowej i link z planu musi trafiać w tę z tofu, a nie w wzorzec.
  if (sciezka.indexOf('/ksiazka/') === 0) {
    const doc = U.przepis('ksiazka', decodeURIComponent(sciezka.slice('/ksiazka/'.length)));
    if (!doc) return html(res, layout('Nie znaleziono', pusto('\u{1F4D6}', 'Nie ma takiego przepisu w książce.'),
      '/przepisy', '/przepisy'), 404);
    return html(res, layout(doc.tytul, stronaPrzepis(doc), '/przepisy', '/przepisy', SKRYPT_PRZEPIS));
  }
  if (sciezka.indexOf('/tydzien/') === 0) {
    const czesci = sciezka.slice('/tydzien/'.length).split('/').map(decodeURIComponent);
    const doc = czesci.length === 2 ? U.przepis('tydzien', czesci[1], czesci[0]) : null;
    if (!doc) return html(res, layout('Nie znaleziono', pusto('\u{1F4D6}', 'Nie ma takiego przepisu.'),
      '/przepisy', '/przepisy'), 404);
    return html(res, layout(doc.tytul, stronaPrzepis(doc), '/przepisy', '/przepisy', SKRYPT_PRZEPIS));
  }
  // Stare linki z czasów jednego worka — kierujemy do przepisu tego tygodnia.
  if (sciezka.indexOf('/przepis/') === 0) {
    const t = U.tydzienBiezacy();
    const s = U.slug(decodeURIComponent(sciezka.slice('/przepis/'.length)));
    if (t && U.przepisyTygodnia(t.slug).some((d) => d.slug === s)) {
      res.writeHead(302, { Location: linkPrzepisu(t.slug, s) });
      return res.end();
    }
    return html(res, layout('Nie znaleziono', pusto('\u{1F4D6}', 'Nie ma takiego przepisu.'),
      '/przepisy', '/przepisy'), 404);
  }
  if (sciezka === '/zakupy') {
    return html(res, layout('Zakupy', stronaZakupy(), '/zakupy', null, SKRYPT_ZAKUPY));
  }

  // Stan składników przepisu — całą robotę wykonuje lib/skladniki.js, tu zostaje
  // tylko przekład HTTP na wywołanie. Ilości bierzemy z pliku przepisu, a nie z tego,
  // co przyszło z telefonu: telefon mówi CO dopisać, przepis mówi ILE.
  if (sciezka.indexOf('/api/skladniki') === 0) {
    try {
      const dane = req.method === 'POST' ? JSON.parse((await czytajBody(req)) || '{}') : {};
      const slug = String(dane.przepis || u.searchParams.get('przepis') || '');
      const slugTygodnia = String(dane.tydzien || u.searchParams.get('tydzien') || '');

      // Zakupy robi się z tygodnia, nie z książki: książkowy przepis nie należy do
      // żadnego tygodnia, więc nie ma do czego przypiąć stanu.
      if (!slugTygodnia) return json(res, { blad: 'Ten przepis jest w książce — dodaj go najpierw do jadłospisu.' }, 400);

      const wynik = sciezka === '/api/skladniki/przelacz'
        ? await SKL.przelacz(slugTygodnia, slug, dane.nazwa,
            dane.zalatwione === null ? null : !!dane.zalatwione)
        : sciezka === '/api/skladniki/reset'
          ? await SKL.wyczysc(slugTygodnia, slug)
          : sciezka === '/api/skladniki/dodaj'
            ? await SKL.dopisz(LISTA, slugTygodnia, slug,
                (dane.items || []).map((i) => i && i.name).filter(Boolean))
            : await SKL.stan(slugTygodnia, slug);

      if (wynik.blad) return json(res, { blad: wynik.blad }, 404);
      return json(res, {
        raport: wynik.raport || null,
        uwaga: wynik.uwaga || null,
        skladniki: wynik.skladniki
      });
    } catch (e) {
      return json(res, { blad: e.message }, 500);
    }
  }

  // Książka zmienia się tylko stąd — przyciskiem, świadomie. Czat ma do niej zakaz
  // zapisu (web/czat-uprawnienia.json), żeby prośba z telefonu nie przerobiła
  // ulubionego przepisu przy okazji poprawiania czegoś innego.
  if (sciezka.indexOf('/api/ksiazka/') === 0) {
    if (req.method !== 'POST') return json(res, { blad: 'Tylko POST.' }, 405);
    try {
      const dane = JSON.parse((await czytajBody(req)) || '{}');
      const wynik = sciezka === '/api/ksiazka/dodaj'
        ? await KSIAZKA.dodaj(String(dane.tydzien || ''), String(dane.przepis || ''), dane.tytul)
        : sciezka === '/api/ksiazka/usun'
          ? await KSIAZKA.usun(String(dane.przepis || ''))
          : null;
      if (!wynik) return json(res, { blad: 'Nie znam takiej operacji.' }, 404);
      return json(res, wynik, wynik.blad ? 400 : 200);
    } catch (e) {
      return json(res, { blad: e.message }, 500);
    }
  }

  // --- czat
  // Czat jest panelem, nie stroną, ale stare zakładki i historia mogą tu trafić.
  // Serwujemy zwykłą stronę z otwartym panelem zamiast przekierowania: przekierowanie
  // przy cofaniu odbija użytkownika z powrotem do przodu i "wstecz" przestaje działać.
  if (sciezka === '/czat') {
    return html(res, layout('Dziś', stronaDzis(), '/', null,
      CZAT_DOSTEPNY ? 'window.PC_OTWORZ_CZAT=1;' : ''));
  }
  if (sciezka === '/api/czat/nowa') {
    CZAT.zapomnij(ciasteczka(req).pc_dev || 'wspolne');
    return json(res, { ok: true });
  }
  if (sciezka === '/api/czat') {
    if (req.method !== 'POST') return json(res, { blad: 'Zła metoda.' }, 405);
    try {
      const dane = JSON.parse((await czytajBody(req)) || '{}');
      const id = ciasteczka(req).pc_dev || 'wspolne';
      // Tryb z przycisku „Zaplanuj tydzień"; poza tym czat sam wykrywa planowanie
      // z pierwszej wiadomości nowej rozmowy.
      const w = await CZAT.zapytaj(id, dane.wiadomosc, dane.tryb === 'planowanie' ? 'planowanie' : undefined);
      return json(res, w);
    } catch (e) {
      return json(res, { blad: e.message }, 500);
    }
  }

  return html(res, layout('Nie znaleziono', pusto('\u{1F937}', 'Nie ma takiej strony.'), null, '/'), 404);
}

// ---------------------------------------------------------------- start

function adresyLan() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((n) => {
    (ifaces[n] || []).forEach((a) => {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    });
  });
  return out;
}

module.exports = { md, recipeLink, ingredients, planRows, todayRows };

if (require.main !== module) return;

const server = http.createServer((req, res) => {
  router(req, res).catch((e) => {
    process.stderr.write('[web] ' + (e && e.stack || e) + '\n');
    if (!res.headersSent) html(res, layout('Błąd', '<div class="uwaga">' + esc(e.message) + '</div>', null, '/'), 500);
  });
});

// Dostępność czatu sprawdzamy raz, przed nasłuchem — strony pytają o nią synchronicznie,
// a bez działającego Claude Code nie ma sensu pokazywać przycisku, który nic nie zrobi.
CZAT.sprawdz().then((w) => {
  CZAT_DOSTEPNY = w.ok;

  server.listen(PORT, '0.0.0.0', () => {
    const adr = adresyLan();
    process.stdout.write('\n  PrivateChief — aplikacja domowa\n\n');
    process.stdout.write('  PIN: ' + CONFIG.pin + '\n');
    process.stdout.write('  Dom: ' + ROOT + '  (' + U.SKAD_DOM + ')\n\n');
    if (adr.length) {
      process.stdout.write('  Na telefonie otworz jeden z adresow:\n');
      adr.forEach((a) => process.stdout.write('     http://' + a + ':' + PORT + '\n'));
    } else {
      process.stdout.write('  Nie widze adresu w sieci lokalnej — sprawdz polaczenie WiFi.\n');
    }
    process.stdout.write('\n  Na tym komputerze: http://localhost:' + PORT + '\n');
    process.stdout.write(w.ok
      ? '  Czat: ' + w.wersja + (w.klucz ? ' (klucz API)' : ' (login Claude Code)')
        + ' — model: ' + CZAT.MODELE.zwykly + ', planowanie: ' + CZAT.MODELE.planowanie + '\n'
      : '  Czat NIEDOSTEPNY: ' + w.powod + '\n');
    process.stdout.write('  Zatrzymanie: Ctrl+C\n\n');
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stderr.write('\n  Port ' + PORT + ' jest zajety. Zmien "port" w ' + CONFIG_FILE + '\n'
      + '  albo zatrzymaj poprzednio uruchomiona aplikacje.\n\n');
    process.exit(1);
  }
  throw e;
});
