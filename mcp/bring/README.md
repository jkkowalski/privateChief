# Serwer MCP: Bring!

Lokalny serwer MCP, który pozwala Claude'owi czytać i zapisywać listę zakupów w aplikacji
**Bring!** — po to, żeby składniki z jadłospisu trafiały prosto na listę.

- Jeden plik, zero zależności (`server.js`), wymaga tylko Node ≥ 18 — nic się nie instaluje z npm.
- Rozmawia z nieoficjalnym API Bring! (`api.getbring.com`), tym samym, którego używają
  biblioteki społecznościowe i integracja Home Assistant. Bring! nie udostępnia API publicznie,
  więc zmiana po ich stronie może zepsuć integrację — wtedy widać to jako błąd HTTP w odpowiedzi narzędzia.

## Konfiguracja (jednorazowo)

1. Skopiuj wzór i wpisz **własne** dane logowania do Bring!:

   ```bash
   cp mcp/bring/credentials.example.json "<katalog domu>/konfiguracja/bring.json"
   ```

   Następnie otwórz `konfiguracja/bring.json` w katalogu domu i uzupełnij `email` oraz `password`.
   Plik zostaje na dysku lokalnie (zwykły tekst) — nie trafia do `.mcp.json` ani do repozytorium.
   Alternatywa bez pliku: ustaw zmienne środowiskowe `BRING_EMAIL` i `BRING_PASSWORD`.

2. Sprawdź połączenie i odczytaj UUID list:

   ```bash
   node "<katalog kodu>\mcp\bring\server.js" --check
   ```

   Wynik to nazwa konta, rozmiar katalogu nazw i lista `nazwa [UUID]` — te wartości wpisz
   w `ustawienia.md` w polu „Lista Bring”. Możesz też wpisać nazwę lub UUID w `konfiguracja/bring.json`
   jako `defaultList`, wtedy narzędzia nie będą pytać o listę.

3. Zrestartuj Claude Code (serwery MCP wczytują się przy starcie sesji) i zatwierdź
   serwer `bring` z pliku `.mcp.json` w katalogu domu.

## Narzędzia

| Narzędzie | Do czego |
|---|---|
| `lists` | listy zakupów na koncie + ich UUID |
| `get_items` | co jest do kupienia / ostatnio kupione |
| `add_items` | dodaje pozycje (np. składniki z jadłospisu) |
| `remove_items` | usuwa pozycje z listy |
| `complete_items` | oznacza pozycje jako kupione |

`add_items` przyjmuje pozycje jako tekst albo obiekt z ilością:

```json
{ "items": ["masło", { "name": "mleko", "specification": "2 l" }] }
```

## Nazwy produktów, czyli po co tłumaczenie

Bring! trzyma pozycje z własnego katalogu pod **niemieckimi kluczami** — „ciecierzyca” leży
na serwerze jako `Kichererbsen` — a aplikacja dopiero przy wyświetlaniu podmienia je na nazwy
z pliku `articles.<język>.json`. Gdyby serwer wysyłał polskie nazwy dosłownie, na liście
zrobiłby się duplikat: `Ciecierzyca` (własna pozycja) obok katalogowej `Kichererbsen`,
a `remove_items` po polskiej nazwie nie trafiłby w pozycję dodaną z telefonu.

Dlatego serwer tłumaczy w obie strony:

- **przy zapisie** polska nazwa → klucz katalogowy, więc pozycja ląduje w tej samej szufladce,
  co dodana ręcznie w aplikacji;
- **przy odczycie** klucz katalogowy → polska nazwa, więc Claude widzi „Papier toaletowy”,
  a nie „WC-Papier”.

Dopasowanie jest celowo ostrożne — najpierw dokładne, potem dwa bezpieczne przybliżenia:
zapytanie z dodatkowym określeniem (`papryka czerwona` → `Papryka`) i sama końcówka fleksyjna
(`ziemniak` → `Ziemniaki`). Jeżeli nic nie pasuje pewnie, nazwa idzie na listę **dosłownie**,
jako własna pozycja — lepiej to, niż kupić ogórki konserwowe zamiast ogórków. W raporcie
z `add_items` takie pozycje są oznaczone jako „spoza katalogu”.

Katalog pobierany jest raz na sesję z `web.getbring.com`. Gdy się nie uda, serwer pracuje
dalej na surowych nazwach i mówi o tym w odpowiedzi.

### Język listy w aplikacji

Każda lista ma w Bring! własne ustawienie `listArticleLanguage` — to ono decyduje, w jakim
języku **telefon** pokazuje nazwy katalogowe. Jest niezależne od `language` w `credentials.json`
(czyli języka, w którym rozmawia z Tobą Claude). Gdy oba się różnią, narzędzia dopisują
ostrzeżenie: pozycja dodana jako „Ciecierzyca” pojawi się na telefonie jako „Kichererbsen”.
Ustawienie zmienia się w aplikacji Bring!, nie tutaj.

## Co zwracają narzędzia zapisujące

Bring! odpowiada `204 No Content` na **każdy** zapis — także wtedy, gdy kasujemy coś, czego
na liście nie ma. Dlatego serwer najpierw czyta listę, a potem grupuje wynik wg tego, co
faktycznie się stało:

```
Lista "Dom" [a4e77b4b-...]
Dodano (2):
  - Ciecierzyca  (400 g)
  - pierś z kurczaka  (600 g)  — spoza katalogu, jako własna pozycja
Już było na liście (zaktualizowano ilość) (1):
  - Papryka  (2 szt.)
```

`remove_items` i `complete_items` w ten sam sposób wydzielają pozycje pominięte
(„Nie było na liście”, „Nie było do kupienia”), zamiast raportować sukces na wyrost.

Wywołania narzędzi wykonywane są pojedynczo, jedno po drugim — inaczej dwa równoległe
zapisy zdążyłyby odczytać ten sam, nieaktualny stan listy i raport rozminąłby się z prawdą.

## Zmienne środowiskowe (opcjonalne)

| Zmienna | Znaczenie |
|---|---|
| `BRING_EMAIL`, `BRING_PASSWORD` | dane logowania zamiast `credentials.json` |
| `BRING_CREDENTIALS` | inna ścieżka do pliku z danymi logowania |
| `BRING_LIST` | domyślna lista (nazwa lub UUID) |
| `BRING_LANGUAGE` | język nazw produktów, domyślnie `pl-PL` (pole `language` w `credentials.json`) |
| `BRING_COUNTRY` | kraj konta, domyślnie `PL` |
| `BRING_API_KEY`, `BRING_API_BASE` | nadpisanie klucza/adresu API (gdyby Bring! je zmienił) |
| `BRING_ARTICLES_BASE` | adres katalogu nazw, domyślnie `https://web.getbring.com/locale/` |
