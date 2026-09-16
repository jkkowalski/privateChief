# PrivateChief

Domowy szef kuchni na własnym komputerze. Claude układa jadłospis dla rodziny — pod
alergie, sprzęt w kuchni, czas i apetyt — pisze przepisy i wysyła listę zakupów do
aplikacji Bring!. Domownicy dostają na telefony (w domowym Wi-Fi) widok „Dziś", przepisy
z odhaczaniem składników, listę zakupów i czat, który potrafi zmienić plan albo dopisać
coś do zakupów.

Wszystko po polsku, bez zależności z npm, bez chmury i bez telemetrii: dane rodziny
zostają w jednym katalogu na Twoim dysku.

## Czym to jest, a czym nie jest

- **Narzędzie domowe**, nie usługa. Działa w sieci lokalnej; nikt poza domem go nie widzi
  i tak ma zostać (sekcja „Bezpieczeństwo").
- **Nie jest poradą lekarską ani dietetyczną i nie jest wyrobem medycznym.** Nie
  diagnozuje, nie leczy, nie zastępuje specjalisty. Alergie i diety, które wpiszesz, są
  Twoimi deklaracjami — aplikacja je uwzględnia, ale nie ustala i nie ocenia. Jeżeli ktoś
  w domu wymaga diety leczniczej, ustalcie ją z lekarzem lub dietetykiem.
- **Czat i planowanie to sztuczna inteligencja** (Claude). Może się mylić, także co do
  składników. Dlatego plan i lista zakupów zawsze wymagają zatwierdzenia przez człowieka,
  a wykluczenia z profilu sprawdza dodatkowo deterministyczny filtr w kodzie
  (`lib/alergeny.js`) — jako drugie sito, nie zamiast czytania etykiet w sklepie.
- Dla dzieci nie liczy kalorii ani nie układa diet redukcyjnych, niezależnie od tego, co
  wpiszesz.

## Wymagania

- Windows (skrót `web\start.cmd`); na innych systemach `node web/app.js`.
- [Node.js](https://nodejs.org) 18 lub nowszy. Nic więcej się nie instaluje.
- **Claude Code** zainstalowany i zalogowany na tym komputerze (`claude`, potem `/login`)
  **albo** klucz API Anthropic — w zmiennej `ANTHROPIC_API_KEY` lub jako `claudeApiKey`
  w `konfiguracja/web.json` domu. Bez jednego z dwóch działa wszystko poza czatem.
- Konto Bring! — opcjonalnie, do wysyłki listy zakupów.

Czat ma dwa tryby na dwóch modelach: **zwykły** (pytania z kuchni, drobne zmiany —
domyślnie alias `sonnet`, tani i szybki) i **planowanie** (cała sesja układania tygodnia —
domyślnie alias `opus`). Planowanie uruchamia przycisk „Zaplanuj następny tydzień"
w zakładce Jadłospisy; rozpoznawane jest też z pierwszej wiadomości nowej rozmowy
(„ułóż jadłospis…"). Tryb jest własnością rozmowy do „Nowej rozmowy", a w panelu widać
plakietkę z modelem. Modele zmienisz w `konfiguracja/web.json`: `claudeModel`
i `claudeModelPlanowanie` (aliasy `sonnet`/`opus`/`haiku` albo pełne identyfikatory).
Plan ułożony z aplikacji zapisuje się od razu jako **propozycja** (pole `status`
w nagłówku) — oglądasz go w zakładce Jadłospisy, a zatwierdzasz w czacie.

## Instalacja

1. Pobierz kod (`git clone` albo archiwum) — np. do `C:\PrivateChief`.
2. Załóż **dom** — katalog na dane rodziny, osobny od kodu:

   ```bash
   node narzedzia/dom.js zaloz C:\Users\Ania\Dom
   ```

   Powstaną w nim katalogi na dane, kopia skilla, konfiguracja serwera MCP i własne
   repozytorium gita. Kod zapamięta, gdzie jest dom (`dom.txt`).
3. Jeśli używasz Bring!: skopiuj `konfiguracja/bring.example.json` na
   `konfiguracja/bring.json` w domu i wpisz e-mail oraz hasło do Bring!. Sprawdź:
   `node mcp/bring/server.js --check`.
4. Otwórz katalog domu w Claude Code i napisz „ułóż jadłospis na tydzień" — skill
   `rodzinny-jadlospis` przeprowadzi wywiad o rodzinie i zapisze wszystko w plikach.
5. Uruchom `web\start.cmd`. W oknie zobaczysz PIN i adres, który wpisujesz na telefonie.

Po aktualizacji kodu odśwież kopię skilla w domu: `node narzedzia/dom.js aktualizuj`.

## Jak to jest zbudowane

Dwa katalogi. **Kod** (to repozytorium) da się aktualizować, kopiować i publikować bez
dotykania danych. **Dom** to jeden katalog do kopii zapasowej, z prywatnym gitem:

| Kod | Dom |
|---|---|
| `lib/` — układ plików, składniki, stan ptaszków, książka, filtr wykluczeń | `rodzina/` — domownicy, kuchnia, kto gotuje, spiżarnia |
| `mcp/bring/` — serwer MCP i logika Bring! | `jadlospisy/<tydzień>/` — plan, przepisy tygodnia, lista |
| `web/` — aplikacja na telefony i czat | `ksiazka/` — przepisy ulubione (dodaje się przyciskiem) |
| `narzedzia/` — `dom.js`, `sprawdz.js`, migracje | `dane/` — stan aplikacji; `konfiguracja/` — hasła i PIN (poza gitem) |
| `.claude/skills/rodzinny-jadlospis/` — źródło skilla | `.claude/skills/` — kopia skilla; `.mcp.json`; `CLAUDE.md` |

Pliki są w Markdown z nagłówkiem JSON — czytelne dla człowieka, jednoznaczne dla
programu. Umowa formatu: [FORMAT.md](FORMAT.md). Przepis w tygodniu to zapis jednego
gotowania i wolno go zmieniać; przepis w książce to wzorzec — dlatego są osobno.

Czat w aplikacji uruchamia `claude -p` w katalogu domu z uprawnieniami z
`web/czat-uprawnienia.json` i zapisuje każdą turę, która zmieniła pliki, jako commit
w repozytorium domu. Serwer MCP daje sesji narzędzia do listy Bring! i do stanu
składników (co już dopisane, co ze spiżarni, czego brakuje) — tego samego, który widzą
domownicy w aplikacji.

## Bezpieczeństwo

Model zagrożeń jest prosty i trzeba go znać, zanim ktoś „wystawi to na zewnątrz":

- **Tylko sieć domowa.** PIN ma cztery cyfry — chroni przed przypadkowym wejściem
  domownika, nie przed internetem. **Nie przekierowuj portu na routerze.** Do dostępu
  spoza domu użyj sieci nakładkowej (np. Tailscale): telefon „jest" wtedy w domu,
  a `tailscale cert` daje HTTPS.
- **Czat jest dostępny dla każdego, kto zna PIN** — także dla dzieci i gości. Jego
  uprawnienia (`web/czat-uprawnienia.json`) to granica bezpieczeństwa: bez poleceń
  systemowych, bez sieci, bez dostępu do haseł, bez zapisu do książki. Rozszerzaj je
  ze świadomością, komu je dajesz.
- **Hasło do Bring! leży czystym tekstem** w `konfiguracja/bring.json` domu (Bring! nie
  ma innej metody logowania). Włącz szyfrowanie dysku.
- **Zero telemetrii.** Jedyne połączenia wychodzące: `api.getbring.com`
  i `web.getbring.com` (Twoje konto i katalog nazw Bring!) oraz Anthropic — przez
  Claude Code albo API, wyłącznie dla czatu i planowania.
- Podatności zgłaszaj według [SECURITY.md](SECURITY.md).

## Bring!

Bring! nie udostępnia publicznego API. Serwer używa tego samego nieoficjalnego interfejsu
co biblioteki społecznościowe i integracja Home Assistant, z kluczem klienckim aplikacji
webowej Bring!. Może przestać działać bez ostrzeżenia, a korzystanie z niego podlega
regulaminowi Bring!. Testuj na prywatnej liście — zapis na listę wspólną wysyła
powiadomienia całej rodzinie.

## Projekt niekomercyjny

Nie ma płatnej wersji, płatnego wsparcia ani hostowanej usługi i nie będzie ich w tym
repozytorium. Gdyby kiedykolwiek pojawiła się możliwość darowizny, darowizna nie kupuje
niczego — ani funkcji, ani wsparcia, ani pierwszeństwa; projekt jest taki sam dla
wszystkich. To nie jest ozdobnik: od tego zależą wyłączenia dla wolnego oprogramowania
w prawie unijnym, opisane w [docs/hosting-i-zgodnosc.md](docs/hosting-i-zgodnosc.md).

Licencja: [Apache-2.0](LICENSE). Nazwa „PrivateChief" nie przechodzi z kodem (licencja,
§ 6). Jak pomagać: [CONTRIBUTING.md](CONTRIBUTING.md) — w skrócie: żadnych danych
osobowych w zgłoszeniach.

## Dokumentacja

- [FORMAT.md](FORMAT.md) — format plików: przepis, jadłospis, spiżarnia, stan składników.
- [mcp/bring/README.md](mcp/bring/README.md) — serwer MCP: konfiguracja, narzędzia, katalog nazw.
- [docs/hosting-i-zgodnosc.md](docs/hosting-i-zgodnosc.md) — dlaczego to jest narzędzie
  domowe, a nie usługa: RODO, AI Act, regulaminy, open source, darowizny.
