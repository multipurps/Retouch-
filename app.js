/* Retoucher — client-side object removal.
   Everything happens on-device: the image never leaves the browser. */

(() => {
  'use strict';

  const MAX_DIM = 1800; // cap working resolution for speed

  const dropZone   = document.getElementById('dropZone');
  const fileInput  = document.getElementById('fileInput');
  const canvasWrap = document.getElementById('canvasWrap');
  const imgCanvas  = document.getElementById('imgCanvas');
  const maskCanvas = document.getElementById('maskCanvas');
  const cursorCanvas = document.getElementById('cursorCanvas');
  const stage      = document.getElementById('stage');
  const processing = document.getElementById('processing');
  const processingLabel = document.getElementById('processingLabel');

  const brushToolBtn = document.getElementById('brushToolBtn');
  const eraseToolBtn = document.getElementById('eraseToolBtn');
  const brushDownBtn = document.getElementById('brushDownBtn');
  const brushUpBtn   = document.getElementById('brushUpBtn');
  const brushReadout = document.getElementById('brushReadout');
  const brushReadout2= document.getElementById('brushReadout2');
  const undoBtn     = document.getElementById('undoBtn');
  const redoBtn     = document.getElementById('redoBtn');
  const removeBtn   = document.getElementById('removeBtn');
  const newBtn      = document.getElementById('newBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const zoomInBtn   = document.getElementById('zoomInBtn');
  const zoomOutBtn  = document.getElementById('zoomOutBtn');
  const zoomResetBtn= document.getElementById('zoomResetBtn');
  const installBtn  = document.getElementById('installBtn');
  const loupe       = document.getElementById('loupe');
  const loupeCanvas = document.getElementById('loupeCanvas');

  const ictx = imgCanvas.getContext('2d', { willReadFrequently: true });
  const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  const cctx = cursorCanvas.getContext('2d');
  const lctx = loupeCanvas.getContext('2d');

  let W = 0, H = 0;
  let tool = 'brush';
  let brushR = 40;
  let drawing = false;
  let lastPt = null;
  let zoom = 1;
  const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const LOUPE_ZOOM = 2.6;
  const LOUPE_SIZE = 132;

  // history of full-resolution image states (after each committed removal)
  let history = [];
  let historyIdx = -1;

  // ---------- Load image ----------

  function loadImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, MAX_DIM / Math.max(w, h));
      W = Math.round(w * scale);
      H = Math.round(h * scale);

      [imgCanvas, maskCanvas, cursorCanvas].forEach(c => {
        c.width = W; c.height = H;
        c.style.width = W + 'px';
        c.style.height = H + 'px';
      });
      canvasWrap.style.width = W + 'px';
      canvasWrap.style.height = H + 'px';

      ictx.clearRect(0, 0, W, H);
      ictx.drawImage(img, 0, 0, W, H);
      mctx.clearRect(0, 0, W, H);

      dropZone.style.display = 'none';
      canvasWrap.style.display = 'block';

      history = [ictx.getImageData(0, 0, W, H)];
      historyIdx = 0;

      zoom = fitZoom();
      applyZoom();
      updateButtons();
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  function fitZoom() {
    const availW = stage.clientWidth - 28;
    const availH = stage.clientHeight - 28;
    if (W <= availW && H <= availH) return 1;
    return Math.max(0.1, Math.min(availW / W, availH / H));
  }

  fileInput.addEventListener('change', e => loadImageFile(e.target.files[0]));
  dropZone.addEventListener('click', () => fileInput.click());
  ['dragenter', 'dragover'].forEach(ev =>
    dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('drag'); }));
  dropZone.addEventListener('drop', e => loadImageFile(e.dataTransfer.files[0]));

  newBtn.addEventListener('click', () => {
    if (!confirm('Open a new photo? Unsaved edits will be lost.')) return;
    canvasWrap.style.display = 'none';
    dropZone.style.display = 'block';
    fileInput.value = '';
    history = []; historyIdx = -1;
    mctx.clearRect(0, 0, W, H);
    updateButtons();
  });

  // ---------- Coordinate helpers ----------

  function canvasPointFromClient(clientX, clientY) {
    const rect = imgCanvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    const y = ((clientY - rect.top) / rect.height) * H;
    return { x, y };
  }

  // ---------- Drawing (mask) ----------

  function strokeAt(pt, prev) {
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    mctx.lineWidth = brushR * 2;
    mctx.strokeStyle = tool === 'brush' ? '#d1503a' : 'rgba(0,0,0,1)';
    mctx.globalCompositeOperation = tool === 'brush' ? 'source-over' : 'destination-out';
    mctx.beginPath();
    if (prev) { mctx.moveTo(prev.x, prev.y); mctx.lineTo(pt.x, pt.y); }
    else { mctx.moveTo(pt.x, pt.y); mctx.lineTo(pt.x + 0.01, pt.y + 0.01); }
    mctx.stroke();
  }

  function drawCursor(pt) {
    cctx.clearRect(0, 0, W, H);
    if (!pt) return;
    cctx.beginPath();
    cctx.arc(pt.x, pt.y, brushR, 0, Math.PI * 2);
    cctx.strokeStyle = tool === 'brush' ? 'rgba(209,80,58,.9)' : 'rgba(95,179,163,.9)';
    cctx.lineWidth = 1.5;
    cctx.stroke();
  }

  // ---------- Magnifier loupe (touch only) ----------

  function updateLoupe(pt, clientX, clientY) {
    const sw = LOUPE_SIZE / LOUPE_ZOOM;
    const sh = sw;
    let sx = pt.x - sw / 2;
    let sy = pt.y - sh / 2;
    sx = Math.max(0, Math.min(W - sw, sx));
    sy = Math.max(0, Math.min(H - sh, sy));

    lctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    lctx.imageSmoothingEnabled = false;
    lctx.drawImage(imgCanvas, sx, sy, sw, sh, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    lctx.globalAlpha = 0.45;
    lctx.drawImage(maskCanvas, sx, sy, sw, sh, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    lctx.globalAlpha = 1;

    // crosshair + true brush-edge circle so the exact touch point is unambiguous
    const cx = ((pt.x - sx) / sw) * LOUPE_SIZE;
    const cy = ((pt.y - sy) / sh) * LOUPE_SIZE;
    const rr = brushR * (LOUPE_SIZE / sw);
    lctx.strokeStyle = tool === 'brush' ? 'rgba(209,80,58,.95)' : 'rgba(95,179,163,.95)';
    lctx.lineWidth = 1.5;
    lctx.beginPath(); lctx.arc(cx, cy, rr, 0, Math.PI * 2); lctx.stroke();
    lctx.strokeStyle = 'rgba(255,255,255,.9)';
    lctx.beginPath(); lctx.moveTo(cx - 6, cy); lctx.lineTo(cx + 6, cy); lctx.stroke();
    lctx.beginPath(); lctx.moveTo(cx, cy - 6); lctx.lineTo(cx, cy + 6); lctx.stroke();

    // position the loupe above the finger, clamped to viewport, offset so the
    // finger never covers the area it's currently painting
    let lx = clientX - LOUPE_SIZE / 2;
    let ly = clientY - LOUPE_SIZE - 46;
    if (ly < 8) ly = clientY + 46; // flip below if too close to top
    lx = Math.max(6, Math.min(window.innerWidth - LOUPE_SIZE - 6, lx));
    loupe.style.left = lx + 'px';
    loupe.style.top = ly + 'px';
    loupe.classList.add('show');
  }
  function hideLoupe() { loupe.classList.remove('show'); }

  // ---------- Pointer / touch handling ----------
  // One finger (or mouse) paints. Two fingers pinch-zoom / pan.

  let pinch = null; // { startDist, startZoom, startMidX, startMidY, startScrollL, startScrollT }

  function dist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  function mid(a, b) { return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }

  imgCanvas.addEventListener('mousedown', e => {
    if (canvasWrap.style.display === 'none') return;
    drawing = true;
    const pt = canvasPointFromClient(e.clientX, e.clientY);
    strokeAt(pt, null);
    lastPt = pt;
    removeBtn.disabled = false;
  });
  imgCanvas.addEventListener('mousemove', e => {
    const pt = canvasPointFromClient(e.clientX, e.clientY);
    drawCursor(pt);
    if (!drawing) return;
    strokeAt(pt, lastPt);
    lastPt = pt;
  });
  window.addEventListener('mouseup', () => { drawing = false; lastPt = null; });
  imgCanvas.addEventListener('mouseleave', () => { if (!drawing) drawCursor(null); });

  imgCanvas.addEventListener('touchstart', e => {
    if (canvasWrap.style.display === 'none') return;
    e.preventDefault();
    if (e.touches.length === 2) {
      drawing = false; lastPt = null; hideLoupe();
      const [a, b] = e.touches;
      pinch = {
        startDist: dist(a, b),
        startZoom: zoom,
        startScrollL: stage.scrollLeft,
        startScrollT: stage.scrollTop,
        prevMid: mid(a, b),
      };
      return;
    }
    pinch = null;
    drawing = true;
    const t = e.touches[0];
    const pt = canvasPointFromClient(t.clientX, t.clientY);
    strokeAt(pt, null);
    lastPt = pt;
    removeBtn.disabled = false;
    updateLoupe(pt, t.clientX, t.clientY);
  }, { passive: false });

  imgCanvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 2 && pinch) {
      const [a, b] = e.touches;
      const d = dist(a, b);
      const newZoom = Math.max(0.15, Math.min(6, pinch.startZoom * (d / pinch.startDist)));
      const m = mid(a, b);
      zoom = newZoom;
      applyZoom();
      // pan so the pinch midpoint stays visually anchored
      stage.scrollLeft = pinch.startScrollL - (m.x - pinch.prevMid.x);
      stage.scrollTop  = pinch.startScrollT - (m.y - pinch.prevMid.y);
      return;
    }
    if (!drawing) return;
    const t = e.touches[0];
    const pt = canvasPointFromClient(t.clientX, t.clientY);
    strokeAt(pt, lastPt);
    lastPt = pt;
    updateLoupe(pt, t.clientX, t.clientY);
  }, { passive: false });

  imgCanvas.addEventListener('touchend', e => {
    if (e.touches.length === 0) {
      drawing = false; lastPt = null; pinch = null; hideLoupe();
    } else if (e.touches.length === 1) {
      pinch = null;
    }
  });
  imgCanvas.addEventListener('touchcancel', () => { drawing = false; lastPt = null; pinch = null; hideLoupe(); });

  brushToolBtn.addEventListener('click', () => setTool('brush'));
  eraseToolBtn.addEventListener('click', () => setTool('erase'));
  function setTool(t) {
    tool = t;
    brushToolBtn.classList.toggle('active', t === 'brush');
    eraseToolBtn.classList.toggle('active', t === 'erase');
  }

  function setBrush(v) {
    brushR = Math.max(6, Math.min(200, v));
    brushReadout.textContent = brushR;
    brushReadout2.textContent = brushR;
  }
  brushDownBtn.addEventListener('click', () => setBrush(brushR - 6));
  brushUpBtn.addEventListener('click', () => setBrush(brushR + 6));

  // ---------- Zoom ----------

  function applyZoom() {
    canvasWrap.style.transform = `scale(${zoom})`;
    canvasWrap.style.transformOrigin = 'top left';
    zoomResetBtn.textContent = Math.round(zoom * 100) + '%';
  }
  zoomInBtn.addEventListener('click', () => {
    const i = ZOOM_LEVELS.findIndex(z => z >= zoom);
    zoom = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, (i === -1 ? ZOOM_LEVELS.length - 1 : i) + 1)];
    applyZoom();
  });
  zoomOutBtn.addEventListener('click', () => {
    const i = ZOOM_LEVELS.findIndex(z => z >= zoom);
    zoom = ZOOM_LEVELS[Math.max(0, i - 1)];
    applyZoom();
  });
  zoomResetBtn.addEventListener('click', () => { zoom = 1; applyZoom(); });

  // ---------- Undo / redo ----------

  function updateButtons() {
    undoBtn.disabled = historyIdx <= 0;
    redoBtn.disabled = historyIdx >= history.length - 1;
    downloadBtn.disabled = history.length === 0;
    newBtn.disabled = history.length === 0;
  }
  undoBtn.addEventListener('click', () => {
    if (historyIdx <= 0) return;
    historyIdx--;
    ictx.putImageData(history[historyIdx], 0, 0);
    updateButtons();
  });
  redoBtn.addEventListener('click', () => {
    if (historyIdx >= history.length - 1) return;
    historyIdx++;
    ictx.putImageData(history[historyIdx], 0, 0);
    updateButtons();
  });

  // ---------- Download ----------

  downloadBtn.addEventListener('click', () => {
    imgCanvas.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'retouched.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  });

  // ---------- Inpainting ----------

  removeBtn.addEventListener('click', async () => {
    const maskData = mctx.getImageData(0, 0, W, H);
    let any = false;
    for (let i = 3; i < maskData.data.length; i += 4) {
      if (maskData.data[i] > 10) { any = true; break; }
    }
    if (!any) return;

    processing.classList.add('show');
    processingLabel.textContent = 'reconstructing…';
    removeBtn.disabled = true;
    await nextFrame();

    const srcData = ictx.getImageData(0, 0, W, H);
    const mask = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      mask[i] = maskData.data[p + 3] > 10 ? 1 : 0;
    }

    const result = await inpaint(srcData, mask, W, H);

    ictx.putImageData(result, 0, 0);
    mctx.clearRect(0, 0, W, H);
    cctx.clearRect(0, 0, W, H);

    history = history.slice(0, historyIdx + 1);
    history.push(result);
    historyIdx = history.length - 1;
    updateButtons();

    processing.classList.remove('show');
  });

  function nextFrame() {
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
  }

  // Multi-resolution diffusion inpainting (Laplace fill).
  async function inpaint(imageData, mask0, w0, h0) {
    const levels = [];
    {
      const rgb = new Float32Array(w0 * h0 * 3);
      for (let i = 0, p = 0; i < w0 * h0; i++, p += 4) {
        rgb[i * 3] = imageData.data[p];
        rgb[i * 3 + 1] = imageData.data[p + 1];
        rgb[i * 3 + 2] = imageData.data[p + 2];
      }
      levels.push({ w: w0, h: h0, rgb, mask: mask0 });
    }
    while (levels[levels.length - 1].w > 24 && levels[levels.length - 1].h > 24) {
      const prev = levels[levels.length - 1];
      const nw = Math.max(4, Math.round(prev.w / 2));
      const nh = Math.max(4, Math.round(prev.h / 2));
      const rgb = new Float32Array(nw * nh * 3);
      const mask = new Uint8Array(nw * nh);
      const sx = prev.w / nw, sy = prev.h / nh;
      for (let y = 0; y < nh; y++) {
        for (let x = 0; x < nw; x++) {
          const x0 = Math.floor(x * sx), x1 = Math.min(prev.w - 1, Math.floor((x + 1) * sx));
          const y0 = Math.floor(y * sy), y1 = Math.min(prev.h - 1, Math.floor((y + 1) * sy));
          let r = 0, g = 0, b = 0, n = 0, m = 0;
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              const idx = yy * prev.w + xx;
              if (prev.mask[idx]) { m = 1; continue; }
              r += prev.rgb[idx * 3]; g += prev.rgb[idx * 3 + 1]; b += prev.rgb[idx * 3 + 2]; n++;
            }
          }
          const di = y * nw + x;
          if (n > 0) { rgb[di * 3] = r / n; rgb[di * 3 + 1] = g / n; rgb[di * 3 + 2] = b / n; }
          mask[di] = m;
        }
      }
      levels.push({ w: nw, h: nh, rgb, mask });
      if (nw <= 24 || nh <= 24) break;
    }

    let coarse = levels[levels.length - 1];
    initMasked(coarse);
    diffuse(coarse, 260);

    for (let li = levels.length - 2; li >= 0; li--) {
      const level = levels[li];
      upsampleInto(coarse, level);
      const iters = li === 0 ? 60 : Math.max(40, Math.round(120 / (levels.length - li)));
      diffuse(level, iters);
      coarse = level;
      if (li % 2 === 0) await nextFrame();
    }

    const out = new ImageData(w0, h0);
    out.data.set(imageData.data);
    const final = levels[0];
    for (let i = 0, p = 0; i < w0 * h0; i++, p += 4) {
      if (mask0[i]) {
        out.data[p] = clamp8(final.rgb[i * 3]);
        out.data[p + 1] = clamp8(final.rgb[i * 3 + 1]);
        out.data[p + 2] = clamp8(final.rgb[i * 3 + 2]);
        out.data[p + 3] = 255;
      }
    }
    return out;
  }

  function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  function initMasked(level) {
    const { w, h, rgb, mask } = level;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i]) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; n++; }
    }
    const avg = n > 0 ? [r / n, g / n, b / n] : [128, 128, 128];
    for (let i = 0; i < w * h; i++) {
      if (mask[i]) { rgb[i * 3] = avg[0]; rgb[i * 3 + 1] = avg[1]; rgb[i * 3 + 2] = avg[2]; }
    }
  }

  function diffuse(level, iterations) {
    const { w, h, rgb, mask } = level;
    for (let it = 0; it < iterations; it++) {
      for (let y = 0; y < h; y++) {
        const rowOff = y * w;
        for (let x = 0; x < w; x++) {
          const i = rowOff + x;
          if (!mask[i]) continue;
          let r = 0, g = 0, b = 0, n = 0;
          if (x > 0)     { const j = i - 1;  r += rgb[j*3]; g += rgb[j*3+1]; b += rgb[j*3+2]; n++; }
          if (x < w - 1) { const j = i + 1;  r += rgb[j*3]; g += rgb[j*3+1]; b += rgb[j*3+2]; n++; }
          if (y > 0)     { const j = i - w;  r += rgb[j*3]; g += rgb[j*3+1]; b += rgb[j*3+2]; n++; }
          if (y < h - 1) { const j = i + w;  r += rgb[j*3]; g += rgb[j*3+1]; b += rgb[j*3+2]; n++; }
          if (n === 0) continue;
          rgb[i*3]   = r / n;
          rgb[i*3+1] = g / n;
          rgb[i*3+2] = b / n;
        }
      }
    }
  }

  function upsampleInto(coarse, level) {
    const { w, h, rgb, mask } = level;
    const sx = coarse.w / w, sy = coarse.h / h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const cx = Math.min(coarse.w - 1, Math.floor(x * sx));
        const cy = Math.min(coarse.h - 1, Math.floor(y * sy));
        const ci = cy * coarse.w + cx;
        rgb[i*3]   = coarse.rgb[ci*3];
        rgb[i*3+1] = coarse.rgb[ci*3+1];
        rgb[i*3+2] = coarse.rgb[ci*3+2];
      }
    }
  }

  // ---------- Keyboard shortcuts (desktop) ----------
  window.addEventListener('keydown', e => {
    if (canvasWrap.style.display === 'none') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoBtn.click(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redoBtn.click(); }
    if (e.key === 'b') setTool('brush');
    if (e.key === 'e') setTool('erase');
    if (e.key === '[') setBrush(brushR - 6);
    if (e.key === ']') setBrush(brushR + 6);
  });

  // ---------- PWA install ----------
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.style.display = 'inline-block';
  });
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.style.display = 'none';
  });
  window.addEventListener('appinstalled', () => { installBtn.style.display = 'none'; });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  window.addEventListener('resize', () => {
    if (canvasWrap.style.display !== 'none' && W) { /* keep current zoom on resize */ }
  });

})();
