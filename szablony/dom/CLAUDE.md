# Dom

To jest **dom** — katalog z danymi jednej rodziny: kto je, co lubi, jadłospisy, przepisy,
książka, lista zakupów. Kod aplikacji leży osobno, w `{{KOD}}`, i to tam się go zmienia;
tutaj są wyłącznie dane. Rozmawiamy i piszemy po polsku.

**Zachowanie agenta opisuje skill `rodzinny-jadlospis`** (`.claude/skills/rodzinny-jadlospis/SKILL.md`):
wywiad o rodzinie, układanie planu, przepisy, lista zakupów, wysyłka do Bring!, nauka po
tygodniu. To on jest źródłem prawdy — nie powielaj tych reguł tutaj. Skill w tym
katalogu jest **kopią** z kodu; po aktualizacji kodu odśwież ją:

```bash
node "{{KOD}}\narzedzia\dom.js" aktualizuj
```

## Układ domu

| Ścieżka | Co w niej |
|---|---|
| `rodzina/` | domownicy, kuchnia, kto gotuje, spiżarnia, historia |
| `jadlospisy/<tydzień>/` | `jadlospis.md`, `przepisy/` tego tygodnia, `lista-zakupow.md` |
| `ksiazka/` | przepisy ulubione — **nie zmieniaj ich w sesji**; do książki dodaje człowiek przyciskiem w aplikacji |
| `ustawienia.md` | lista Bring!, horyzont planu, posiłki, dzień zakupów |
| `dane/` | stan aplikacji (ptaszki przy składnikach, cache) — nie ruszaj edytorem, od tego są narzędzia MCP |
| `konfiguracja/` | `bring.json` (hasło do Bring!), `web.json` (PIN aplikacji) — **poza gitem, nie wypisuj, nie kopiuj** |
| `FORMAT.md` | umowa formatu plików między skillem a aplikacją (kopia z kodu) |

Książka jest osobno od tygodnia celowo: przepis w tygodniu to zapis jednego gotowania
i wolno go zmieniać, przepis w książce to wzorzec. Wstawiając ulubione danie do planu,
**kopiuj** plik z `ksiazka/` do `jadlospisy/<tydzień>/przepisy/` i pracuj na kopii.

## Narzędzia

- Aplikacja dla telefonów: `{{KOD}}\web\start.cmd` (znajduje ten dom przez `dom.txt` obok kodu).
- Kontrola formatu plików — uruchamiaj **z tego katalogu**, narzędzie rozpoznaje dom po
  bieżącym katalogu:

```bash
node "{{KOD}}\narzedzia\sprawdz.js"
```

- Serwer MCP Bring! jest podpięty przez `.mcp.json` (wskazuje na kod). Narzędzia listy:
  `lists`, `get_items`, `add_items`, `remove_items`, `complete_items`; narzędzia stanu
  przepisu: `skladniki_przepisu`, `dopisz_z_przepisu`, `odhacz_skladnik`,
  `wyczysc_przepis`. **Zaglądaj do stanu, zanim dopiszesz cokolwiek na listę** — domownicy
  dopisują składniki z telefonów i widać to właśnie tam.

## Git

Ten katalog ma własne, prywatne repozytorium. Czat z aplikacji robi commit `czat: <prośba>`
po każdej turze, która zmieni pliki; książka — commit na każdy awans i usunięcie.
Cofnięcie nietrafionej zmiany: `git revert <commit>`.
