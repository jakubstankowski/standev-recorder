// Cały tor nagrywania w osobnym wątku: składanie obrazu (ekran + kamerka), kodowanie
// H.264/AAC przez WebCodecs i zapis MP4 prosto do pliku.
// Główny wątek karty w tle jest dławiony przez przeglądarkę (to dawało zacięcia i gubienie
// klatek), a ten worker nie, więc nagranie jest płynne także wtedy, gdy pracujesz w innym oknie.
importScripts('vendor/mp4-muxer.min.js');

const KEYFRAME_SEC = 2;
const CAM_STALL_MS = 2000;
const sources = { screen: null, cam: null };
const MAX_QUEUE = 8;
const ENCODER_STALL_MS = 3000;
const FLUSH_TIMEOUT_MS = 5000;
const WARMUP_TIMEOUT_MS = 10000;

let canvas, ctx, opts, timer, statsTimer, previewTimer;
let videoEncoder, audioEncoder, muxer, fileStream, memParts;
let t0, paused = false, pauseStart = 0, pausedTotal = 0, frameNo = 0, audioSamples = 0;
let previewOn = true, previewPending = false, stopping = false, vcfg, lastOutputAt = 0, encoderRestarts = 0;
let decoderConfig = null, muxedFirst = false, warmFed = 0, warmOut = 0, tsBase = 0;
const latest = { screen: null, cam: null };
const counts = { screen: 0, cam: 0, out: 0, dropped: 0, encoded: 0, queueMax: 0 };
const readers = [];
let bytes = 0;

function fail(err) {
  postMessage({ type: 'error', message: String(err?.message || err) });
}

async function pickVideoCodec(w, h, fps, bitrate) {
  // High profile; poziom 5.2 pokrywa 4K60, 5.1 i 4.2 jako zapas
  for (const codec of ['avc1.640034', 'avc1.640033', 'avc1.64002A']) {
    for (const hw of ['prefer-hardware', 'no-preference']) {
      const cfg = {
        codec, width: w, height: h, bitrate, framerate: fps,
        // 'realtime': enkoder nie zbiera klatek na zapas, więc kolejka się nie zapycha.
        // Jakość trzyma wysoki bitrate.
        hardwareAcceleration: hw, latencyMode: 'realtime', bitrateMode: 'variable', avc: { format: 'avc' },
      };
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
    }
  }
  throw new Error('Przeglądarka nie potrafi zakodować H.264 w ' + w + '×' + h);
}

async function pickAudioCodec(sampleRate, numberOfChannels) {
  const aac = { codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate: 320_000 };
  if ((await AudioEncoder.isConfigSupported(aac)).supported) return { cfg: aac, mux: 'aac' };
  const opus = { codec: 'opus', sampleRate, numberOfChannels, bitrate: 256_000 };
  if ((await AudioEncoder.isConfigSupported(opus)).supported) return { cfg: opus, mux: 'opus' };
  throw new Error('Brak kodeka audio (AAC/Opus)');
}

async function pump(readable, onValue) {
  const reader = readable.getReader();
  readers.push(reader);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onValue(value);
  }
}

// Źródło obrazu (ekran albo kamerka). Błąd lub koniec strumienia nie może przejść po cichu:
// wcześniej ostatnia klatka zostawała na płótnie i nagranie powielało „zamrożoną twarz”.
function attachVideo(key, readable) {
  sources[key]?.reader.cancel().catch(() => {});
  const reader = readable.getReader();
  readers.push(reader);
  const src = { lastAt: performance.now(), lost: false, reader };
  sources[key] = src;
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (sources[key] !== src) { value.close(); continue; } // klatka ze starego, wymienionego strumienia
      latest[key]?.close();
      latest[key] = value;
      src.lastAt = performance.now();
      counts[key]++;
    }
  })()
    .then(() => { if (sources[key] === src) sourceLost(key, 'strumień się zakończył'); })
    .catch((e) => { if (sources[key] === src) sourceLost(key, String(e?.message || e)); });
}

function sourceLost(key, reason) {
  const src = sources[key];
  if (stopping || !src || src.lost) return;
  src.lost = true;
  src.reader.cancel().catch(() => {});
  // Ekran może legalnie stać w miejscu, więc jego ostatnia klatka zostaje. Kamerkę chowamy,
  // żeby w nagraniu nie było stopklatki udającej obraz na żywo.
  if (key === 'cam') { latest.cam?.close(); latest.cam = null; }
  postMessage({ type: 'source-lost', key, reason });
}

function now() {
  return performance.now() - t0 - pausedTotal;
}

function drawContain(s, x, y, w, h) {
  const r = Math.min(w / s.displayWidth, h / s.displayHeight);
  const dw = s.displayWidth * r, dh = s.displayHeight * r;
  ctx.drawImage(s, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawCover(s, x, y, w, h, mirror) {
  const r = Math.max(w / s.displayWidth, h / s.displayHeight);
  const sw = w / r, sh = h / r;
  ctx.save();
  if (mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); x = 0; y = 0; }
  ctx.drawImage(s, (s.displayWidth - sw) / 2, (s.displayHeight - sh) / 2, sw, sh, x, y, w, h);
  ctx.restore();
}

function drawCamBubble(k, W, H) {
  const size = (opts.camSize / 100) * W;
  const w = size, h = opts.camShape === 'circle' ? size : size * 9 / 16;
  const m = Math.round(W * 0.02);
  const x = opts.camPos.includes('r') ? W - w - m : m;
  const y = opts.camPos.includes('b') ? H - h - m : m;
  ctx.save();
  ctx.beginPath();
  if (opts.camShape === 'circle') ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2);
  else ctx.roundRect(x, y, w, h, w * 0.04);
  ctx.closePath();
  ctx.save();
  ctx.clip();
  drawCover(k, x, y, w, h, opts.camMirror);
  ctx.restore();
  ctx.lineWidth = Math.max(3, W * 0.0025);
  ctx.strokeStyle = '#6d4aff';
  ctx.stroke();
  ctx.restore();
}

function tick() {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (latest.screen) drawContain(latest.screen, 0, 0, W, H);
  if (latest.cam) {
    if (!opts.hasScreen) drawCover(latest.cam, 0, 0, W, H, opts.camMirror);
    else drawCamBubble(latest.cam, W, H);
  }
  if (paused) return;
  const queue = videoEncoder.encodeQueueSize;
  counts.queueMax = Math.max(counts.queueMax, queue);
  // Enkoder nie nadąża: pomijamy klatkę, ale tylko gdy enkoder wciąż wydaje dane.
  // Sprzętowy enkoder trzyma kilka klatek i oddaje wynik dopiero po kolejnych; gdyby przestać
  // go karmić przy długiej kolejce, oba czekałyby na siebie bez końca (zawieszone nagranie).
  const encoderAlive = performance.now() - lastOutputAt < 250;
  if (queue > MAX_QUEUE * 4 || (queue > MAX_QUEUE && encoderAlive)) { counts.dropped++; return; }
  const frame = new VideoFrame(canvas, { timestamp: tsBase + Math.round(now() * 1000) });
  videoEncoder.encode(frame, { keyFrame: frameNo % (opts.fps * KEYFRAME_SEC) === 0 });
  frame.close();
  frameNo++;
  counts.out++;
}

function onAudio(data) {
  if (paused || stopping) { data.close(); return; }
  // Znaczniki czasu liczone z próbek: ciągłe audio bez dziur i dryfu względem pauzy
  const timestamp = Math.round((audioSamples / data.sampleRate) * 1e6);
  audioSamples += data.numberOfFrames;
  const copy = new AudioData({
    format: data.format, sampleRate: data.sampleRate, numberOfFrames: data.numberOfFrames,
    numberOfChannels: data.numberOfChannels, timestamp, data: extractAudio(data),
  });
  data.close();
  audioEncoder.encode(copy);
  copy.close();
}

function extractAudio(data) {
  const planar = data.format.endsWith('-planar');
  const planes = planar ? data.numberOfChannels : 1;
  let size = 0;
  for (let i = 0; i < planes; i++) size += data.allocationSize({ planeIndex: i });
  const buf = new ArrayBuffer(size);
  let off = 0;
  for (let i = 0; i < planes; i++) {
    const n = data.allocationSize({ planeIndex: i });
    data.copyTo(new Uint8Array(buf, off, n), { planeIndex: i });
    off += n;
  }
  return buf;
}

function createVideoEncoder() {
  videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      lastOutputAt = performance.now();
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
      // Klatki z rozgrzewki nie trafiają do pliku. Enkoder w trybie realtime oddaje klatki
      // po kolei, więc odrzucamy tyle pierwszych wyników, ile klatek rozgrzewkowych podano.
      if (warmOut < warmFed) { warmOut++; return; }
      if (!muxedFirst) {
        muxedFirst = true;
        if (!meta?.decoderConfig) meta = { ...meta, decoderConfig };
      }
      counts.encoded++;
      bytes += chunk.byteLength;
      try { muxer.addVideoChunk(chunk, meta); } catch (e) { fail(e); }
    },
    error: (e) => { console.warn('Enkoder wideo:', e); restartVideoEncoder(); },
  });
  videoEncoder.configure(vcfg);
  warmFed = warmOut = 0;
  frameNo = 0; // pierwsza klatka nowego enkodera musi być kluczowa
}

function restartVideoEncoder() {
  if (stopping) return;
  if (++encoderRestarts > 10) { fail(new Error('Enkoder wideo przestał odpowiadać')); return; }
  try { videoEncoder.close(); } catch {}
  createVideoEncoder();
  lastOutputAt = performance.now();
  postMessage({ type: 'encoder-restart', count: encoderRestarts });
}

// Sprzętowy enkoder potrafi kilka sekund rozkręcać się po starcie. Karmimy go czarnymi klatkami,
// aż zacznie wydawać dane; dopiero wtedy rusza zegar nagrania, więc w pliku nie ma przerwy na początku.
async function warmUpEncoder() {
  const deadline = performance.now() + WARMUP_TIMEOUT_MS;
  const startedAt = performance.now();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let i = 0;
  lastOutputAt = 0;
  while (lastOutputAt < startedAt) {
    if (performance.now() > deadline) throw new Error('Enkoder wideo nie uruchomił się');
    if (videoEncoder.encodeQueueSize < MAX_QUEUE) {
      const f = new VideoFrame(canvas, { timestamp: i * 16667 });
      videoEncoder.encode(f, { keyFrame: i === 0 });
      f.close();
      warmFed++;
      i++;
    }
    await new Promise((r) => setTimeout(r, 1000 / opts.fps));
  }
  frameNo = 0; // pierwsza prawdziwa klatka będzie kluczowa
  tsBase = i * 16667; // czas nagrania ciągnie się dalej od rozgrzewki (muxer i tak przesuwa plik do zera)
}

// Obietnica z limitem czasu: zawieszony enkoder nie może zablokować zapisu pliku
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);
}

async function start(d) {
  opts = { ...d.opts, fps: d.fps };
  canvas = new OffscreenCanvas(d.width, d.height);
  ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  vcfg = await pickVideoCodec(d.width, d.height, d.fps, d.bitrate);
  const acodec = d.audio ? await pickAudioCodec(d.audioInfo.sampleRate, d.audioInfo.channels) : null;

  let target;
  if (d.fileHandle) {
    fileStream = await d.fileHandle.createWritable();
    target = new Mp4Muxer.FileSystemWritableFileStreamTarget(fileStream);
  } else {
    memParts = [];
    // W trybie 'fragmented' muxer pisze wyłącznie na koniec, więc pozycja = suma poprzednich części
    target = new Mp4Muxer.StreamTarget({ onData: (chunk, _position) => memParts.push(chunk.slice()) });
  }
  muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: 'avc', width: d.width, height: d.height, frameRate: d.fps },
    audio: acodec ? { codec: acodec.mux, numberOfChannels: d.audioInfo.channels, sampleRate: d.audioInfo.sampleRate } : undefined,
    // Plik na dysku: klasyczny MP4 (najlepsza zgodność z edytorami). W pamięci: fragmenty.
    fastStart: d.fileHandle ? false : 'fragmented',
    firstTimestampBehavior: 'offset',
  });

  createVideoEncoder();
  await warmUpEncoder();
  if (acodec) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        // Kodek oddaje pierwsze fragmenty z ujemnym czasem (przesunięcie startowe), który Chrome
        // przekazuje jako ogromną liczbę; muxer by ich nie przyjął, więc je pomijamy
        if (chunk.timestamp < 0 || chunk.timestamp > Number.MAX_SAFE_INTEGER) return;
        bytes += chunk.byteLength;
        try { muxer.addAudioChunk(chunk, meta); } catch (e) { console.warn('Audio chunk pominięty:', e.message); }
      },
      error: fail,
    });
    audioEncoder.configure(acodec.cfg);
  }

  t0 = performance.now();
  lastOutputAt = t0;
  if (d.screen) attachVideo('screen', d.screen);
  if (d.cam) attachVideo('cam', d.cam);
  if (d.audio) {
    pump(d.audio, onAudio)
      .then(() => { if (!stopping) postMessage({ type: 'source-lost', key: 'audio', reason: 'strumień dźwięku się zakończył' }); })
      .catch((e) => { if (!stopping) postMessage({ type: 'source-lost', key: 'audio', reason: String(e?.message || e) }); });
  }
  timer = setInterval(tick, 1000 / d.fps);
  statsTimer = setInterval(() => {
    // Kamerka nadaje klatki bez przerwy, więc 2 s ciszy oznacza, że utknęła
    if (sources.cam && !sources.cam.lost && performance.now() - sources.cam.lastAt > CAM_STALL_MS) {
      sourceLost('cam', 'brak klatek przez ' + CAM_STALL_MS / 1000 + ' s');
    }
    // Enkoder nic nie wydał od kilku sekund mimo podawania klatek: tworzymy go od nowa
    if (!paused && performance.now() - lastOutputAt > ENCODER_STALL_MS) restartVideoEncoder();
    postMessage({ type: 'stats', ...counts, bytes });
    for (const k in counts) counts[k] = 0;
  }, 1000);
  previewTimer = setInterval(async () => {
    // Kolejny obraz podglądu dopiero po potwierdzeniu poprzedniego: gdy karta jest w tle,
    // główny wątek odbiera wolno, a nieodebrane obrazy zapychały pamięć karty graficznej
    // i dławiły enkoder.
    if (!previewOn || previewPending) return;
    previewPending = true;
    const pw = 960, ph = Math.round((960 * canvas.height) / canvas.width);
    const bmp = await createImageBitmap(canvas, { resizeWidth: pw, resizeHeight: ph, resizeQuality: 'low' });
    postMessage({ type: 'preview', bmp }, [bmp]);
  }, 100);
  postMessage({ type: 'started', codec: vcfg.codec, hw: vcfg.hardwareAcceleration, audio: acodec?.mux || null });
}

async function stop() {
  stopping = true;
  clearInterval(timer);
  clearInterval(statsTimer);
  clearInterval(previewTimer);
  readers.forEach((r) => r.cancel().catch(() => {}));
  sources.screen = sources.cam = null;
  latest.screen?.close();
  latest.cam?.close();
  if (!muxer || !timer || videoEncoder?.state !== 'configured') {
    // Start się nie udał: nie ma czego zapisać
    await fileStream?.abort().catch(() => {});
    postMessage({ type: 'done', bytes: 0, failed: true });
    close();
    return;
  }
  const flushed = await withTimeout(Promise.all([videoEncoder.flush(), audioEncoder?.flush()]), FLUSH_TIMEOUT_MS)
    .catch((e) => console.warn('Flush:', e));
  if (flushed === 'timeout') console.warn('Enkoder nie opróżnił kolejki w czasie, zapisuję to, co jest');
  // Jawne zwolnienie enkodera sprzętowego; karty graficzne mają limit równoległych sesji
  try { videoEncoder.close(); } catch {}
  try { audioEncoder?.close(); } catch {}
  muxer.finalize();
  if (fileStream) {
    await fileStream.close();
    postMessage({ type: 'done', bytes });
  } else {
    const blob = new Blob(memParts, { type: 'video/mp4' });
    postMessage({ type: 'done', bytes, blob });
  }
  close();
}

onmessage = ({ data }) => {
  const run = (p) => p.catch(fail);
  if (data.type === 'start') run(start(data));
  else if (data.type === 'opts') Object.assign(opts, data.opts);
  else if (data.type === 'source') attachVideo(data.key, data.readable);
  else if (data.type === 'preview') previewOn = data.on;
  else if (data.type === 'preview-ack') previewPending = false;
  else if (data.type === 'pause' && !paused) { paused = true; pauseStart = performance.now(); }
  else if (data.type === 'resume' && paused) { pausedTotal += performance.now() - pauseStart; paused = false; }
  else if (data.type === 'stop') run(stop());
};
