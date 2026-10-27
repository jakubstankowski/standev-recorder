// Test harness: podmienia getDisplayMedia/getUserMedia na sztuczne źródła rysowane w workerze,
// żeby nie obciążały głównego wątku. Używane tylko do testów (wstrzykiwane z konsoli).
(() => {
  const workerSrc = `
    let tick = 0;
    onmessage = ({ data: { w, h, color, fps, id } }) => {
      const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
      setInterval(() => {
        // Kamerka (#00c) pulsuje jasnością całego kadru, więc każda klatka jest inna
        g.fillStyle = color === '#00c' ? 'rgb(0,0,' + (80 + ((tick * 6) % 170)) + ')' : color;
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff'; g.fillRect((tick * 16) % w, 0, 32, h);
        g.fillStyle = '#ff0'; g.font = (h / 8) + 'px sans-serif'; g.fillText(String(tick), 20, h / 2);
        tick++;
        const f = new VideoFrame(c, { timestamp: performance.now() * 1000 });
        postMessage({ id, f }, [f]);
      }, 1000 / fps);
    };`;
  const url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
  function fakeVideo(w, h, color, fps) {
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = gen.writable.getWriter();
    const wk = new Worker(url);
    // Odrzucamy klatki, gdy generator nie nadąża, żeby harness sam nie zapychał pamięci
    wk.onmessage = ({ data }) => {
      // window.__freezeCam = true symuluje kamerkę, która przestaje nadawać klatki
      if (color === '#00c' && window.__freezeCam) { data.f.close(); return; }
      if (writer.desiredSize <= 0) { data.f.close(); window.__dropped = (window.__dropped || 0) + 1; return; }
      writer.write(data.f).catch(() => data.f.close());
    };
    wk.postMessage({ w, h, color, fps, id: 1 });
    gen.addEventListener('ended', () => wk.terminate());
    const origStop = gen.stop.bind(gen);
    gen.stop = () => { wk.terminate(); origStop(); };
    return new MediaStream([gen]);
  }
  const ac = new AudioContext();
  function fakeAudio() {
    const o = ac.createOscillator(); const d = ac.createMediaStreamDestination();
    o.connect(d); o.start(); return d.stream;
  }
  navigator.mediaDevices.getDisplayMedia = async () => {
    const s = fakeVideo(2560, 1440, '#c00', 60); s.addTrack(fakeAudio().getAudioTracks()[0]); return s;
  };
  navigator.mediaDevices.getUserMedia = async (c) => (c.video ? fakeVideo(1280, 720, '#00c', 30) : fakeAudio());
  window.__dl = null;
  HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl = this.href; };
  // Parser fragmentowanego MP4 (moof/traf/trun): liczba próbek i najdłuższa przerwa na ścieżkę
  window.__mp4 = async (src) => {
    const buf = new DataView(await (await fetch(src)).arrayBuffer());
    const tracks = {}; // id -> { handler, timescale, samples, durations: [] }
    const boxes = (start, end, cb) => {
      for (let p = start; p + 8 <= end;) {
        let size = buf.getUint32(p); const type = String.fromCharCode(...[4, 5, 6, 7].map((i) => buf.getUint8(p + i)));
        let hdr = 8; if (size === 1) { size = Number(buf.getBigUint64(p + 8)); hdr = 16; } if (size === 0) size = end - p;
        cb(type, p + hdr, p + size); p += size;
      }
    };
    const walk = (start, end, path) => boxes(start, end, (type, s, e) => {
      if (['moov', 'trak', 'mdia', 'moof', 'traf', 'mvex'].includes(type)) return walk(s, e, [...path, type]);
      if (type === 'tkhd') { const v = buf.getUint8(s); walk.cur = buf.getUint32(s + (v ? 20 : 12)); tracks[walk.cur] ??= { samples: 0, durations: [] }; }
      if (type === 'mdhd') { const v = buf.getUint8(s); tracks[walk.cur].timescale = buf.getUint32(s + (v ? 20 : 12)); }
      if (type === 'hdlr') tracks[walk.cur].handler = String.fromCharCode(...[8, 9, 10, 11].map((i) => buf.getUint8(s + i)));
      if (type === 'trex') tracks[buf.getUint32(s + 4)].defDur = buf.getUint32(s + 12);
      if (type === 'tfhd') { const f = buf.getUint32(s) & 0xffffff; walk.cur = buf.getUint32(s + 4); let o = s + 8; if (f & 1) o += 8; if (f & 2) o += 4; walk.tfDur = f & 8 ? buf.getUint32(o) : undefined; }
      if (type === 'trun') {
        const f = buf.getUint32(s) & 0xffffff; const n = buf.getUint32(s + 4); let o = s + 8; if (f & 1) o += 4; if (f & 4) o += 4;
        const t = tracks[walk.cur]; t.samples += n;
        for (let i = 0; i < n; i++) {
          let d = walk.tfDur ?? t.defDur ?? 0;
          if (f & 0x100) { d = buf.getUint32(o); o += 4; }
          if (f & 0x200) o += 4; if (f & 0x400) o += 4; if (f & 0x800) o += 4;
          t.durations.push(d);
        }
      }
    });
    walk(0, buf.byteLength, []);
    return Object.values(tracks).map((t) => {
      const secs = t.durations.map((d) => d / t.timescale);
      const total = secs.reduce((a, b) => a + b, 0);
      const at = []; let acc = 0;
      secs.forEach((x) => { if (x > 0.1) at.push([+acc.toFixed(2), +x.toFixed(2)]); acc += x; });
      return { handler: t.handler, samples: t.samples, seconds: +total.toFixed(2), fps: +(t.samples / total).toFixed(1), maxSampleSec: +Math.max(...secs).toFixed(3), over100ms: secs.filter((x) => x > 0.1).length, gapsAt: at };
    });
  };

  // Ruch kamerki w nagraniu: porównuje obszar kółka kamerki (prawy dół) w kolejnych chwilach.
  // Sam licznik FPS nie wykryje powielanej stopklatki, ta różnica pikseli tak.
  window.__camMotion = async (src, step = 0.5) => {
    const v = document.createElement('video'); v.muted = true; v.src = src;
    await new Promise((r) => (v.onloadedmetadata = r));
    const c = document.createElement('canvas'); c.width = 256; c.height = 144;
    const g = c.getContext('2d', { willReadFrequently: true });
    const box = [222, 110, 26, 26]; // obszar kółka przy domyślnych ustawieniach (12%, prawy dół)
    let prev = null; const frozen = []; let samples = 0;
    for (let t = step; t < v.duration - 0.1; t += step) {
      v.currentTime = t; await new Promise((r) => { v.onseeked = r; setTimeout(r, 2000); });
      g.drawImage(v, 0, 0, 256, 144);
      const px = g.getImageData(...box).data;
      if (prev) {
        let diff = 0; for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] - prev[i]) + Math.abs(px[i + 1] - prev[i + 1]);
        if (diff / (px.length / 4) < 1) frozen.push(+t.toFixed(1));
      }
      prev = px; samples++;
    }
    return { samples, frozenAt: frozen };
  };

})();
