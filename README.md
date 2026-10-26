# standev-recorder

Nagrywanie ekranu w przeglądarce: ekran, dźwięk systemowy, mikrofon i kamerka. Do 4K, 60 fps, zapis do MP4, bez limitów długości.

Bez instalacji i bez budowania: statyczna strona plus jeden worker.

## Funkcje

- Tryby: **Prezentacja**, **Ekran z kamerą**, **Sama kamera** albo ustawienia własne
- Ekran, okno albo karta, dźwięk systemowy, mikrofon i kamerka, każde źródło włączane osobno
- Kamerka jako nakładka: róg, kształt (koło/prostokąt), rozmiar, odbicie lustrzane
- Rozdzielczość natywna źródła (domyślnie) albo świadome powiększenie do 2K/4K
- 30/60 fps, bitrate 25–120 Mb/s, H.264 kodowany sprzętowo, dźwięk AAC (albo Opus)
- Zapis prosto na dysk w trakcie nagrywania (File System Access API), więc długość nie jest ograniczona przez RAM
- Pauza, licznik czasu i rozmiaru, lista nagrań z odtwarzaniem
- Na żywo widać prawdziwą rozdzielczość ekranu i kamerki, FPS kamerki i ostrzeżenia o przeciążeniu

## Jak to działa

Cały tor nagrywania działa w workerze ([recorder-worker.js](recorder-worker.js)):

1. Klatki ekranu i kamerki przychodzą przez `MediaStreamTrackProcessor`.
2. Worker składa je na `OffscreenCanvas` (kamerka jako nakładka).
3. `VideoEncoder` / `AudioEncoder` (WebCodecs) kodują H.264 i AAC.
4. [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) składa MP4 i zapisuje go prosto do pliku.

Główny wątek karty w tle jest dławiony przez przeglądarkę, a worker nie, więc nagranie jest płynne także wtedy, gdy pracujesz w innym oknie.

Zabezpieczenia:

- Kamerka, która przestaje nadawać klatki (2 s ciszy) albo zgłasza błąd, jest automatycznie podłączana ponownie. Do nagrania nie trafia stopklatka udająca obraz na żywo.
- Utrata kamerki, dźwięku albo ekranu pokazuje komunikat. Nagrywanie pozostałych źródeł trwa dalej.
- Enkoder jest rozgrzewany przed startem. Jeśli w trakcie przestanie odpowiadać, jest tworzony od nowa.
- Zapis pliku przy Stop ma limit czasu, więc zawieszony enkoder nie blokuje zapisu.
- Gdy start się nie powiedzie, kamera, mikrofon, worker i pusty plik są sprzątane.

## Uruchomienie

Potrzebny jest Chrome albo Edge (Chromium 116+). Strona musi działać z `localhost` albo przez HTTPS.

```bash
npx --yes http-server -p 5173 -c-1 .
```

Na Windows możesz też kliknąć dwukrotnie `start.bat`.

Otwórz `http://localhost:5173`, kliknij **Wybierz folder zapisu**, wybierz tryb i kliknij **Nagrywaj**.

## Wskazówki

- Żeby nagrać dźwięk z komputera, zaznacz „Udostępnij dźwięk systemowy” w oknie wyboru ekranu Chrome.
- Powiększanie do 2K/4K daje więcej pikseli w pliku, ale nie więcej szczegółów niż ma źródło. Interfejs pokazuje, kiedy obraz jest powiększany.
- Gdy pojawi się ostrzeżenie o przeciążeniu, zmniejsz FPS do 30 albo rozdzielczość.
- Kliknięcie „Zatrzymaj udostępnianie” na pasku Chrome kończy i zapisuje nagranie.

## Testy

[test/harness.js](test/harness.js) podmienia ekran, kamerkę i mikrofon na sztuczne źródła i daje narzędzia do sprawdzania gotowego pliku: liczbę klatek i przerwy w MP4 (`__mp4`) oraz to, czy obraz kamerki zmienia się przez całe nagranie (`__camMotion`). Wczytaj go z konsoli na stronie aplikacji:

```js
await import('/test/harness.js');
```

## Licencje

mp4-muxer (MIT), dołączony w [vendor/](vendor/).
