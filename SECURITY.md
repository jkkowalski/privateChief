# Bezpieczeństwo

## Model, w którym to ma działać

PrivateChief to narzędzie na jeden dom: aplikacja słucha w sieci lokalnej, dostęp jest na
czterocyfrowy PIN, a czat wykonuje polecenia każdego, kto ten PIN zna. To jest świadomy
kompromis dla kuchni, nie dla internetu. Zgłoszenie „PIN da się zgadnąć z internetu" nie
jest podatnością — jest opisem projektu; odpowiedzią jest „nie wystawiaj aplikacji poza
dom" (README, sekcja „Bezpieczeństwo").

W zakresie są natomiast:

- wyjście czatu poza uprawnienia z `web/czat-uprawnienia.json` (dostęp do haseł, do
  książki, do plików poza domem, wykonanie poleceń systemowych);
- odczyt lub zapis poza katalogiem domu przez adres URL, nazwę przepisu albo tytuł
  wpisany w aplikacji (np. przy dodawaniu do książki);
- wyciek hasła do Bring! lub PIN-u do logów, odpowiedzi HTTP, plików w repozytorium;
- obejście PIN-u w sieci lokalnej;
- zapis na listę Bring! bez działania użytkownika.

## Jak zgłosić

Najlepiej przez prywatne zgłoszenie podatności w GitHubie (zakładka *Security* →
*Report a vulnerability*), żeby opis nie był publiczny, zanim powstanie poprawka. Jeśli to
niemożliwe — zwykłe zgłoszenie z dopiskiem „bezpieczeństwo", ale bez szczegółów
umożliwiających wykorzystanie; o resztę dopytamy prywatnie.

**Nie wklejaj danych rodziny** — plików z `rodzina/`, przepisów z imionami, wpisów
z listy zakupów, haseł. Do odtworzenia problemu wystarczy zmyślony domownik.

To projekt hobbystyczny: odpowiedź w ciągu kilku dni, poprawka bez gwarantowanego
terminu, bez programu nagród. Za zgłoszenie dziękujemy w historii zmian, jeśli chcesz.
