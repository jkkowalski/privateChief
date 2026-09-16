# Jak pomagać

Dziękuję, że chcesz. Kilka zasad, które wynikają z tego, czym ten projekt jest — narzędziem
na dane o zdrowiu rodzin, bez zależności i bez chmury.

## Najważniejsze: żadnych danych osobowych

Do zgłoszeń i pull requestów **nie wklejaj** plików z `rodzina/`, przepisów z imionami
domowników, wpisów z listy zakupów ani rozmów z czatu. Zawierają alergie, diety, cele
wagowe i wiek dzieci — to dane o zdrowiu w rozumieniu RODO, a zgłoszenie na GitHubie
jest publiczne na zawsze. Do odtworzenia błędu wystarczy zmyślony domownik: „Osoba A,
alergia na orzechy". Zgłoszenie z prawdziwymi danymi zostanie usunięte, zanim ktoś je
przeczyta w całości.

To samo dotyczy zrzutów ekranu z aplikacji i wyników `narzedzia/sprawdz.js`.

## Zanim zaczniesz

- Załóż **osobny dom testowy**: `node narzedzia/dom.js zaloz <katalog>` i pracuj na nim
  (`PC_DOM=<katalog>`), nie na danych własnej rodziny. Do Bring! używaj prywatnej listy —
  zapis na listę wspólną wysyła powiadomienia domownikom.
- Przeczytaj `CLAUDE.md` (jak projekt jest poukładany) i `FORMAT.md` (umowa formatu
  między skillem a aplikacją). Zmiana w jednym miejscu psuje drugie, jeśli nie trzymać się
  umowy — `node narzedzia/sprawdz.js` mówi, czy się trzymasz.

## Zasady kodu

- **Zero zależności z npm.** Każda zależność to cudzy kod z dostępem do danych rodziny.
  Jeśli coś naprawdę wymaga biblioteki, najpierw zgłoszenie z uzasadnieniem.
- Po polsku: nazwy w kodzie, komentarze, komunikaty, commity. Komentarze mówią **dlaczego**,
  nie co — kod widać.
- Gdzie co leży, wie `lib/uklad.js`. Nie sklejaj ścieżek ręcznie.
- Sekretów nie ma w kodzie i ma tak zostać; `konfiguracja/` domu jest jedynym miejscem na
  hasła i PIN.
- Zmiana w skillu (`.claude/skills/rodzinny-jadlospis/SKILL.md`) = podbicie numeru wersji
  w jego nagłówku. Po tym numerze dom widzi, że jego kopia została w tyle.
- Uprawnienia czatu (`web/czat-uprawnienia.json`) to granica bezpieczeństwa aplikacji.
  Każde rozszerzenie `allow` wymaga w opisie PR-a zdania, komu to dajesz i po co.

## Pull requesty

Małe, jednotematyczne, z opisem problemu przed opisem rozwiązania. Jeśli zmieniasz
format plików — dopisz to do `FORMAT.md` i sprawdź, czy `sprawdz.js` i `migruj.js`
nadal rozumieją stare pliki: rodziny mają już zapisane tygodnie i nie będą ich
przepisywać.

Kod jest na licencji Apache-2.0; wysyłając zmianę, zgadzasz się na jej udostępnienie na
tych samych warunkach (licencja, § 5).
