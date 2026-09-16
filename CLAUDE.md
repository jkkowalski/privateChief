# PrivateChief — kod

Domowy agent do planowania jadłospisów i robienia z nich listy zakupów w Bring!.
Rozmawiamy i piszemy po polsku.

To repozytorium to **kod**. Dane rodziny leżą w osobnym katalogu — **domu** — który ma
własne, prywatne repozytorium (sekcja „Kod i dom"). Sesje planowania jadłospisu otwiera
się w domu, nie tutaj; tutaj zmienia się aplikację.

**Zachowanie agenta opisuje skill `rodzinny-jadlospis`**
(`.claude/skills/rodzinny-jadlospis/SKILL.md`): wywiad o rodzinie, układanie planu,
przepisy, lista zakupów, wysyłka do Bring!, nauka po tygodniu. Jego źródło prawdy jest
tutaj; dom dostaje kopię (`node narzedzia/dom.js aktualizuj`). Zmieniając skill, podbij
numer wersji w jego nagłówku — po nim widać, że kopia w domu została w tyle. Nie powielaj
reguł skilla w tym pliku i nie wymyślaj własnego przebiegu.

## Kod i dom

| | kod (to repozytorium) | dom (katalog rodziny) |
|---|---|---|
| Co | `lib/`, `mcp/`, `web/`, `narzedzia/`, skill, `FORMAT.md`, `docs/`, `szablony/` | `rodzina/`, `jadlospisy/`, `ksiazka/`, `ustawienia.md`, `dane/`, `konfiguracja/`, kopia skilla, `.mcp.json`, własny `CLAUDE.md` |
| Git | ten; może być publiczny | własny, prywatny — tam trafiają commity czatu i książki |
| Sekrety | **żadnych** — warunek publikacji | `konfiguracja/bring.json` (hasło Bring!), `konfiguracja/web.json` (PIN) — w `.gitignore` domu |

Rozdział jest celowy: kod da się aktualizować, kopiować i publikować bez dotykania danych,
a dom jest jednym katalogiem do kopii zapasowej.

Gdzie leży dom, wie **`lib/uklad.js`** (`znajdzDom`), w tej kolejności: `PC_DOM` →
bieżący katalog, jeśli wygląda jak dom → `dom.txt` obok kodu → sam katalog kodu (stary
układ, gdy kod i dom były jednym). Nie sklejaj ścieżek ręcznie w nowym kodzie;
`node narzedzia/dom.js gdzie` pokazuje, co kod widzi i skąd to wie.

Zakładanie domu: `node narzedzia/dom.js zaloz <katalog>` — tworzy katalogi, kopiuje
skill i `FORMAT.md`, pisze `.mcp.json` wskazujący na ten kod, zakłada repozytorium
i `dom.txt`. Danych rodziny narzędzie nigdy nie nadpisuje; nadpisuje tylko to, czego
źródłem prawdy jest kod.

## Układ katalogu

| Ścieżka | Co w niej |
|---|---|
| `.claude/skills/rodzinny-jadlospis/` | skill z całą logiką szefa kuchni — źródło prawdy |
| `lib/` | wspólne moduły aplikacji i serwera MCP: `uklad.js` (gdzie co leży), `skladniki.js` (czego trzeba kupić), `stan.js` (ptaszki), `ksiazka.js` (awans i usunięcie) |
| `mcp/bring/` | serwer MCP + `bring.js`, wspólna logika Bring! (`README.md` opisuje szczegóły) |
| `web/` | aplikacja dla domowników na telefony (`start.cmd`, `app.js`, `czat.js`, `czat-uprawnienia.json`) |
| `narzedzia/` | `dom.js` (zakładanie domu), `sprawdz.js` (kontrola formatu), `migruj.js`, `migruj-uklad.js` |
| `szablony/dom/` | pliki zakładane w nowym domu (`CLAUDE.md`, `gitignore`) |
| `docs/` | analizy i decyzje, m.in. hosting w sieci i zgodność z prawem |
| `FORMAT.md` | umowa formatu plików między skillem, aplikacją i narzędziami |

**Książka jest osobno od tygodnia i to jest celowe.** Przepis w tygodniu to zapis
jednego gotowania i wolno go zmieniać; przepis w książce to wzorzec, do którego rodzina
wraca. Gdyby to był jeden plik, „zabrakło twarogu, daj tofu" po cichu przerobiłoby
ulubioną sałatkę na zawsze. Awans do książki robi człowiek przyciskiem w aplikacji —
ani skill, ani czat tam nie piszą.

## Aplikacja webowa (web/)

Uruchamiana przez `web/start.cmd` z katalogu kodu; dom znajduje przez `dom.txt`. Słucha na
porcie z `konfiguracja/web.json` domu (domyślnie 8765) na wszystkich interfejsach —
domownicy wchodzą z telefonów po `http://<ip>:8765`. Wejście na PIN, zapamiętywany
w ciasteczku; PIN i sekret siedzą w `konfiguracja/web.json` (poza gitem domu). Aplikacja
czyta pliki domu, a zapisuje wyłącznie do Bring!, do `dane/` (ptaszki) i — przyciskami
książki — do `ksiazka/`.

**Aplikacja czyta to, co pisze skill, więc format plików jest umową między nimi.**
Zmieniając szablony w skillu, sprawdź, czy nadal działa:

- tabela jadłospisu — kolumny `Dzień | Data | Posiłek | Danie | Przepis | …`; z tego
  powstaje widok „Dziś";
- kolumna `Przepis` niesie nazwę pliku z `przepisy/` **tego tygodnia** bez rozszerzenia;
  gdy jej nie ma, aplikacja wraca do zgadywania po wspólnych członach nazwy;
- sekcja `## Składniki` z pozycjami `- nazwa | ilość | znacznik`; znacznik
  `spiżarnia` wyłącza pozycję z przycisku „dodaj do zakupów";
- `rodzina/spizarnia.md` — aplikacja czyta go i traktuje wypisane produkty jak
  spiżarniowe we **wszystkich** przepisach, więc wpisy muszą być nazwami produktów
  („Sól"), a nie opisem zbiorczym („Duży wybór przypraw").

Pełna umowa formatu jest w [FORMAT.md](FORMAT.md), a `node narzedzia/sprawdz.js`
(uruchomione z domu albo z `PC_DOM`) wypisuje pliki, których aplikacja nie zrozumie.

Zmiany testuj na **osobnym domu**: `node narzedzia/dom.js zaloz <katalog-testowy>`,
potem `PC_DOM=<katalog-testowy> PC_PORT=8899 PC_LIST=Apteka node web/app.js` — druga
instancja na prywatnej liście Bring!, bez dotykania Domu ani prawdziwych plików.
(`PC_ROOT` to starsza nazwa `PC_DOM`; nadal działa.)

### Czat (web/czat.js)

Panel czatu (przycisk na każdej stronie; od 900 px dokuje po prawej) woła `claude -p`
**w katalogu domu**, więc sesja wczytuje kopię skilla, `.mcp.json` domu i narzędzia
Bring! — logiki szefa kuchni **nie powielamy** po stronie aplikacji.
Wymaga jednorazowego `claude` + `/login` w terminalu: CLI ma własne uwierzytelnienie,
niezależne od aplikacji Claude na komputerze (tokeny w `~/.claude/.credentials.json`
są puste, bo aplikacja wstrzykuje je potomnym sesjom doraźnie).

Uprawnienia opisuje `web/czat-uprawnienia.json` — ścieżki są względne wobec domu —
i to jest **granica bezpieczeństwa tej aplikacji**: czat jest dostępny dla każdego, kto
zna PIN, także dla dzieci i gości. Świadomie odcięte: `Bash`, sieć, `konfiguracja/**`
(hasło do Bring!, PIN), `dane/**` (stan rusza narzędziami MCP, nie edytorem),
`.claude/**`, `.mcp.json`, `CLAUDE.md`. Książkę czat **czyta, ale jej nie zapisuje** —
inaczej „zamień twaróg na tofu" przerobiłoby ulubiony przepis zamiast jednej środowej
kolacji. Dodając cokolwiek do `allow`, pamiętaj, komu to dajesz.

Każda tura, która zmieni pliki, dostaje własny commit `czat: <prośba>` **w repozytorium
domu**, wyłącznie na ścieżkach zmienionych w tej turze — dlatego dom jest repozytorium
gita i dlatego warto je trzymać w czystości. Cofnięcie nietrafionej zmiany z telefonu
to `git revert <commit>` z komputera.

Jedno urządzenie = jedna rozmowa (ciasteczko `pc_dev`), wywołania idą pojedynczo.

**Dwa tryby rozmowy, dwa modele** (`czat.js`: `KONTEKST`, `MODELE`): *zwykły* — pytania
z kuchni, alias `sonnet`; *planowanie* — cała sesja układania tygodnia, alias `opus`.
Tryb jest cechą **sesji**, nie wiadomości: ustala go pierwsza wiadomość (przycisk
„Zaplanuj następny tydzień" przekazuje `tryb: 'planowanie'`, poza tym `wykryjPlanowanie`
patrzy na treść) i dziedziczą go kolejne tury, bo wywiad o miniony tydzień nie może
w połowie przeskoczyć na słabszy model. `--model` idzie też przy `--resume`. Modele
z `konfiguracja/web.json` (`claudeModel`, `claudeModelPlanowanie`). Kontekst planowania
każe zapisać plan od razu z `"status": "propozycja"` — panel nie renderuje tabel, więc
plan ogląda się w zakładce Jadłospisy, a zatwierdza w czacie. `argumenty(tryb, sessionId)`
jest wyeksportowane po to, żeby test sprawdzał argumenty CLI bez uruchamiania Claude.

## Serwer MCP Bring!

Podpięty przez `.mcp.json` **w domu** (pisze go `dom.js`, z `PC_DOM` w `env`). Aplikacja
Claude na komputerze **nie czyta** `.mcp.json` i wymaga osobnego wpisu
w `claude_desktop_config.json` — tego samego kształtu, z `env.PC_DOM`.

Narzędzia listy: `lists`, `get_items`, `add_items`, `remove_items`, `complete_items`.
Narzędzia stanu przepisu: `skladniki_przepisu`, `dopisz_z_przepisu`, `odhacz_skladnik`,
`wyczysc_przepis` — to ta sama pamięć, którą widzą domownicy w aplikacji (`dane/` domu).
**Zaglądaj tam, zanim dopiszesz cokolwiek na listę**: bez tego dopisujesz drugi raz to,
co ktoś dodał wczoraj z telefonu. Obie rodziny narzędzi siedzą w jednym serwerze, żeby
sesja nie płaciła za drugi start procesu.

Po każdej zmianie w `server.js` trzeba **zrestartować Claude Code** — proces serwera wstaje
przy starcie sesji i nie przeładowuje się sam. Test bez restartu (z domu albo z `PC_DOM`):

```bash
node mcp/bring/server.js --check
```

Wypisuje konto, rozmiar katalogu nazw i listy wraz z UUID oraz językiem, w jakim pokazuje
je aplikacja.

Przy zmianach w serwerze testuj na **prywatnej** liście (np. Apteka), nigdy na wspólnej —
zapis na listę dzieloną wysyła powiadomienie pozostałym domownikom. Po teście posprzątaj
po sobie.

## Bezpieczeństwo

Hasło do Bring! leży w `konfiguracja/bring.json` domu czystym tekstem (poza gitem domu).
Nie wypisuj go w odpowiedziach, nie kopiuj do innych plików i nie wystawiaj serwera
publicznie — to lokalny serwer stdio i tak ma zostać. Kod nie zawiera żadnych sekretów
ani danych rodziny i ma tak zostać: to warunek, żeby dało się go publikować.
