# standev-recorder

Nagrywanie ekranu w przeglądarce: ekran, dźwięk systemowy, mikrofon i kamerka. Minimum 2K, 60 fps, zapis do MP4, bez limitów długości.

Jeden plik HTML, bez instalacji i bez budowania.

## Funkcje

- Ekran, okno albo karta, dźwięk systemowy, mikrofon i kamerka, każde źródło włączane osobno
- Kamerka jako nakładka: róg, kształt (koło/prostokąt), rozmiar, odbicie lustrzane
- Rozdzielczość: natywna z minimum 1440p (domyślnie), 2K, 4K albo natywna
- 30/60 fps, bitrate 25–120 Mb/s, dźwięk 320 kb/s
- MP4 (H.264 + AAC), w starszych przeglądarkach WebM
- Sam ekran bez skalowania jest nagrywany 1:1, bez przerysowywania
- Zapis na dysk w trakcie nagrywania (File System Access API), więc długość nie jest ograniczona przez RAM
- Pauza, licznik czasu i rozmiaru, lista nagrań z odtwarzaniem

## Uruchomienie

Potrzebny jest Chrome albo Edge (Chromium 126+). Strona musi działać z `localhost` albo przez HTTPS.

```bash
npx --yes http-server -p 5173 -c-1 .
```

Na Windows możesz też kliknąć dwukrotnie `start.bat`.

Otwórz `http://localhost:5173`, kliknij **Wybierz folder zapisu**, potem **Nagrywaj**.

## Wskazówki

- Żeby nagrać dźwięk z komputera, zaznacz „Udostępnij dźwięk systemowy” w oknie wyboru ekranu Chrome.
- Na ekranie 1080p tryb „min. 2K” powiększa obraz do 1440p. Plik będzie w 2K, ale ostrość zostanie na poziomie źródła.
- Kliknięcie „Zatrzymaj udostępnianie” na pasku Chrome kończy i zapisuje nagranie.

## Technologie

`getDisplayMedia`, `getUserMedia`, `MediaRecorder`, `MediaStreamTrackProcessor`, Web Audio API, File System Access API, Tailwind CSS.
