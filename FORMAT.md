# Format plików PrivateChief

Umowa między trzema stronami: **skillem** (pisze pliki), **aplikacją webową** (czyta je
i pokazuje domownikom) oraz **narzędziami** w `narzedzia/`. Dopóki wszyscy trzymają się
tego opisu, zmiana w jednym miejscu nie psuje pozostałych.

## Dlaczego nie sama proza

Wcześniej aplikacja zgadywała z tekstu: która tabela w planie jest jadłospisem, czy
`(spiżarnia)` w nawiasie dotyczy produktu czy wariantu przepisu, do którego pliku odnosi
się „Kurczak z niedzieli + bulgur". Każde z tych zgadywań kiedyś strzeliło — raz wiersze
bilansu kalorycznego wyświetliły się jako dania, raz przyprawa trafiła do koszyka jako
świeża papryka. Dane, które mają być przetwarzane, są teraz zapisane wprost.

## Dlaczego nie osobne pliki .json

Pliki mają nadal dać się czytać i poprawiać ręcznie, a jadłospis wędruje też do PDF-a
i do czatu. Dlatego **jeden plik**: nagłówek maszynowy na górze, treść dla człowieka pod
spodem. Nic się nie dubluje, więc nie ma jak się rozjechać.

## Nagłówek: JSON między `---`

Plik zaczyna się linią `---`, potem JSON, potem `---`. Bez tego nagłówka plik nadal
działa — aplikacja wraca wtedy do odczytywania prozy, jak dawniej.

```
---
{
  "tytul": "Leczo z indykiem, cukinią, papryką i ciecierzycą + kasza pęczak",
  "porcje": 5
}
---

# Leczo z indykiem, ...
```

JSON, a nie YAML, z jednego powodu: `JSON.parse` jest wbudowany, a projekt nie ma
i nie ma mieć zależności zewnętrznych.

## Gdzie co leży

```
ksiazka/<Tytuł przepisu>.md        przepisy ulubione — kurowane, w gicie
jadlospisy/<od>_do_<do>/
  jadlospis.md                     plan tygodnia
  przepisy/<slug>.md               przepisy TEGO tygodnia
  lista-zakupow.md                 zatwierdzona lista
rodzina/                           domownicy, kuchnia, spiżarnia
dane/                              stan i cache — POZA repozytorium
```

**Książka i tydzień to nie to samo i celowo się nie schodzą.** Przepis w książce jest
wzorcem, do którego wracacie; przepis w tygodniu jest zapisem jednego gotowania i wolno
go zmieniać. Gdy w środę zabrakło twarogu i poszło tofu, poprawiamy kopię tygodniową —
książka zostaje nietknięta. Przeniesienie zmiany do książki jest zawsze osobną,
świadomą decyzją człowieka (przycisk w aplikacji), nigdy skutkiem ubocznym.

Być w książce **to znaczy** być ulubionym — nie ma pola `ulubione` i nie ma tam historii
ani ocen. Plik w książce nazywa się tytułem dania, bo tam się szuka po nazwie; plik
w tygodniu nazywa się slugiem, bo na niego wskazuje plan i adres w aplikacji.

Katalog `dane/` (ptaszki przy składnikach, cache katalogu Bring!, sesja) jest w
`.gitignore`: to stan działania, nie treść. Zmienia się przy każdym dotknięciu telefonu
i nie ma czego wersjonować. Pisze do niego aplikacja i serwer MCP — nie edytor.

## Przepis — `ksiazka/<Tytuł>.md` albo `jadlospisy/<tydzień>/przepisy/<slug>.md`

Pola nagłówka (wszystkie opcjonalne poza `tytul`):

| Pole | Typ | Znaczenie |
|---|---|---|
| `tytul` | tekst | pełna nazwa dania |
| `porcje` | liczba | ile porcji wychodzi |
| `porcje_uwaga` | tekst | doprecyzowanie, np. „2 osoby × 2 dni, Marek większa" |
| `czas_aktywny_min` | liczba | minuty przy garnku |
| `czas_calkowity_min` | liczba | minuty od wejścia do kuchni do podania |
| `trudnosc` | tekst | „bardzo łatwe", „łatwe", „średnie" |
| `bialko_g` | liczba | białko na porcję w gramach |
| `kcal` | obiekt | kcal na porcję per osoba: `{"Ania": 610, "Marek": 700}` |
| `tagi` | lista tekstów | swobodne etykiety: „omega-3", „bez gotowania", „błonnik: wysoki" |

Czasy nieregularne („5 min wieczorem", „ok. 2 h") zostają w treści — pola liczbowe
wypełniamy tylko wtedy, gdy liczba jest jednoznaczna.

### Składniki

Zostają w treści, bo to je najczęściej czyta się i poprawia w pliku. Format jest jednak
ścisły: **pionowe kreski**, nie nawiasy i myślniki.

```markdown
## Składniki
- pierś z indyka | 750 g
- passata pomidorowa | 400 ml | spiżarnia
- sól | | spiżarnia
- jogurt naturalny | po łyżce | opcjonalnie
```

Pierwsze pole to **nazwa produktu** — sama nazwa, bez etykiet typu „do podania:" i bez
kilku produktów w jednej linii. Drugie to ilość (może być pusta). Dalsze pola to
znaczniki; aplikacja rozumie `spiżarnia` (nie trafia do zakupów) i `opcjonalnie`.

Nazwa jest tym, co pojedzie do Bring!, więc ma być nazwą z półki: „papryka",
a nie „papryka słodka wędzona, 2 łyżeczki".

### Spiżarnia domu — `rodzina/spizarnia.md`

Aplikacja czyta ten plik i traktuje wypisane w nim produkty jak spiżarniowe **we
wszystkich przepisach**, także tych napisanych wcześniej. Znacznik `spiżarnia` przy
składniku mówi, co wiedział autor przepisu; ten plik mówi, co stoi w szafce dzisiaj —
wystarczy jedno z dwóch, żeby pozycja nie trafiła do zakupów.

Wpisy muszą być **nazwami produktów**, bo porównanie idzie po nazwie i po katalogu
Bring!. „Sól" odhaczy sól we wszystkich przepisach, „Mleko" złapie też „mleko 2%".
Opis zbiorczy w rodzaju „Duży wybór przypraw" nie zadziała — żeby pieprz przestał
lądować na liście, musi być wpisany z nazwy.

Sekcja `## Do ustalenia` jest **pomijana** świadomie: plik sam mówi, że te produkty
traktujemy jako „sprawdź, czy jest", więc odhaczanie ich byłoby nadinterpretacją.

## Jadłospis — `jadlospisy/<od>_do_<do>/jadlospis.md`

Katalog tygodnia nazywa się zakresem dat (`2026-09-16_do_2026-09-22`); to z niego bierze
się `od` i `do`, gdy nagłówek ich nie ma. Tydzień „bieżący" to ten obejmujący dziś,
a gdy żaden nie obejmuje — najbliższy przyszły.

Nagłówek:

| Pole | Typ | Znaczenie |
|---|---|---|
| `od`, `do` | data `RRRR-MM-DD` | zakres planu |
| `osoby` | lista tekstów | kto je w tym tygodniu |

Tabela posiłków ma **stałe kolumny**, z `Przepis` zawierającym nazwę pliku z
`przepisy/` **tego tygodnia**, bez rozszerzenia (puste, gdy przepisu nie ma):

```markdown
| Dzień | Data | Posiłek | Danie | Przepis | Czas | Porcje | Uwagi |
|---|---|---|---|---|---|---|---|
| Śr | 2026-09-16 | Obiad | Leczo z indykiem… | leczo-z-indykiem-cukinia-i-ciecierzyca | 60 min | 5 | opcja TM6 |
```

Kolumna `Data` w pełnym formacie zastępuje wyłuskiwanie `DD.MM` z pierwszej kolumny,
a `Przepis` zastępuje zgadywanie po podobieństwie nazw.

**Pozostałe tabele w planie** (bilans kaloryczny, korekty porcji) są zwykłą treścią —
aplikacja rozpoznaje tabelę posiłków po kolumnach `Danie` i `Przepis`, a resztę pokazuje
tak, jak stoi.

## Stan składników — `dane/stan-przepisow.json`

Pamięć „co z tego przepisu jest już załatwione". Klucz to **tydzień i przepis**, nie sam
przepis:

```json
{ "2026-09-16_do_2026-09-22/leczo-z-indykiem-cukinia-i-ciecierzyca": {
    "pierś z indyka": { "zalatwione": true, "kiedy": "2026-09-15T18:04:11.201Z" } } }
```

Tydzień w kluczu robi jedną ważną rzecz: **nowy tydzień startuje czysto sam z siebie**.
Gdy leczo wraca za miesiąc, wrześniowe ptaszki go nie dotyczą i nikt nie musi pamiętać
o czyszczeniu — wcześniej trzeba było i właśnie o tym się zapominało.

„Załatwione" znaczy „nie trzeba tego kupować" i jest **trwałe** — inaczej niż obecność
na liście Bring!, która znika po zakupach. Gdyby ptaszek zależał od listy, po powrocie
ze sklepu wszystko odhaczyłoby się z powrotem.

Plik zmienia aplikacja i narzędzia MCP (`skladniki_przepisu`, `dopisz_z_przepisu`,
`odhacz_skladnik`, `wyczysc_przepis`) — nigdy edytor tekstu.

## Narzędzia

```bash
node narzedzia/sprawdz.js          # kontrola zgodności plików z tym opisem
node narzedzia/migruj.js --proba   # migracja starego formatu: podgląd bez zapisu
node narzedzia/migruj.js           # migracja: zapis
```

`sprawdz.js` warto puścić po ręcznych poprawkach i po zmianach w skillu — wypisuje
pliki, których aplikacja nie zrozumie, zanim zauważysz to na telefonie.
