/* =========================================================
   Camera — logic chính
   - Chế độ: Video (Thường / GIF / Tua nhanh), Ảnh, Quét (Tài liệu / Mã QR)
   - Lưu thẳng vào thư mục đã chọn (File System Access API), không có thì tải về
   - Thư mục được thêm cả vào Photos (cùng origin github.io → dùng chung IndexedDB 'photos')
   - Nút ảnh góc dưới bên phải mở thẳng Photos
   ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const t = (k, v) => I18N.t(k, v);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* bỏ qua */ } }
};

const app = $('#app'), video = $('#video'), toastEl = $('#toast');
const PHOTOS_URL = new URL('../photos/', location.href).href;

const FILTERS = {
  none: '', sepia: 'sepia(100%)', grayscale: 'grayscale(100%)', vivid: 'brightness(1.2) saturate(1.5)',
  invert: 'invert(100%)', saturate: 'saturate(200%)', contrast: 'contrast(200%)', brightness: 'brightness(150%)'
};
const DOC_FILTER = 'grayscale(100%) contrast(150%) brightness(110%)';
const TIMERS = [0, 3, 5, 10];
const GIF_MAX_S = 5, GIF_FPS = 10, GIF_W = 480;
const TL_EVERY_MS = 1000, TL_MAX_FRAMES = 600, TL_PLAY_FPS = 15;

const S = {
  mode: store.get('camera.mode') || 'photo',
  sub: { video: store.get('camera.sub.video') || 'normal', scan: store.get('camera.sub.scan') || 'document' },
  filter: 'none',
  mirror: store.get('camera.mirror') !== '0',
  grid: store.get('camera.grid') === '1',
  timer: 0,
  muted: false,
  stream: null, devices: [], devIdx: 0,
  rec: null,           // { type, stop() } khi đang quay
  counting: null       // { cancel() } khi đang đếm ngược
};

/* ---------- Thông báo ---------- */
let toastT;
function toast(msg, ms = 3200) {
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ---------- Trạng thái giao diện ---------- */
const curSub = () => S.mode === 'photo' ? '' : S.sub[S.mode];
function paintState() {
  app.dataset.mode = S.mode; app.dataset.sub = curSub(); app.dataset.timer = S.timer;
  app.classList.toggle('mirror', S.mirror); app.classList.toggle('grid', S.grid);
  $$('.mode').forEach(b => b.setAttribute('aria-selected', b.dataset.mode === S.mode));
  $$('.sub button').forEach(b => b.setAttribute('aria-selected', b.closest('.sub').dataset.for === S.mode && b.dataset.sub === S.sub[S.mode]));
  $('#btnMirror').selected = S.mirror; $('#btnGrid').selected = S.grid;
  $('#timerBadge').textContent = S.timer ? S.timer + 's' : '';
  $('#shutter').setAttribute('aria-label', t(S.rec ? 'shutter.stop' : (S.mode === 'video' ? 'shutter.record' : 'shutter.photo')));
  video.style.filter = S.mode === 'scan' ? '' : FILTERS[S.filter];
}
function setMode(m) {
  if (S.rec || S.counting) return;
  S.mode = m; store.set('camera.mode', m);
  if (m === 'scan') app.classList.remove('filters');
  $('#btnFilter').selected = app.classList.contains('filters');
  paintState(); qrReset();
  if (m === 'scan' && S.sub.scan === 'qr') qrStart();
}
function setSub(sub) {
  if (S.rec || S.counting) return;
  S.sub[S.mode] = sub; store.set('camera.sub.' + S.mode, sub);
  paintState(); qrReset();
  if (S.mode === 'scan' && sub === 'qr') qrStart();
}
$$('.mode').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$$('.sub button').forEach(b => b.onclick = () => setSub(b.dataset.sub));

/* ---------- Công cụ ---------- */
$('#btnMirror').addEventListener('click', () => { S.mirror = !S.mirror; store.set('camera.mirror', S.mirror ? '1' : '0'); paintState(); });
$('#btnGrid').addEventListener('click', () => { S.grid = !S.grid; store.set('camera.grid', S.grid ? '1' : '0'); paintState(); });
$('#btnFilter').addEventListener('click', () => { $('#btnFilter').selected = app.classList.toggle('filters'); });
$('#btnTimer').addEventListener('click', () => {
  S.timer = TIMERS[(TIMERS.indexOf(S.timer) + 1) % TIMERS.length];
  $('#btnTimer').selected = S.timer > 0;
  paintState();
  toast(S.timer ? t('timer.sec', { n: S.timer }) : t('timer.off'), 1400);
});
$('#btnMic').addEventListener('click', () => {
  S.muted = !S.muted; $('#btnMic').selected = S.muted;
  if (S.stream) S.stream.getAudioTracks().forEach(tr => { tr.enabled = !S.muted; });
});
$('#filters').addEventListener('click', e => {
  const c = e.target.closest('md-filter-chip'); if (!c) return;
  S.filter = c.dataset.f;
  setTimeout(() => $$('#filters md-filter-chip').forEach(x => { x.selected = x === c; }), 0);   /* sau khi chip tự đảo trạng thái */
  paintState();
});

/* ---------- Camera ---------- */
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast(t('msg.no_camera'), 5000); return false; }
  try {
    if (S.stream) S.stream.getTracks().forEach(tr => tr.stop());
    const dev = S.devices[S.devIdx];
    const vid = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (dev && dev.deviceId) vid.deviceId = { exact: dev.deviceId };
    try { S.stream = await navigator.mediaDevices.getUserMedia({ video: vid, audio: true }); }
    catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
      S.stream = await navigator.mediaDevices.getUserMedia({ video: vid, audio: false });   /* không có micrô */
    }
    S.stream.getAudioTracks().forEach(tr => { tr.enabled = !S.muted; });
    video.srcObject = new MediaStream(S.stream.getVideoTracks());
    await video.play().catch(() => {});
    S.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    $('#btnSwitch').hidden = S.devices.length < 2;
    $('#btnMic').disabled = !S.stream.getAudioTracks().length;
    return true;
  } catch (err) {
    console.error('Camera:', err);
    toast(t('msg.cam_error'), 6000);
    return false;
  }
}
$('#btnSwitch').onclick = async () => {
  if (S.rec || S.counting || S.devices.length < 2) return;
  S.devIdx = (S.devIdx + 1) % S.devices.length;
  await startCamera();
};

/* ---------- Thư mục lưu ảnh ---------- */
const idbOpen = (name) => new Promise((res, rej) => {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => r.result.createObjectStore('dirs', { keyPath: 'id', autoIncrement: true });
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const idbTx = async (name, mode, fn) => {
  const db = await idbOpen(name);
  return new Promise((res, rej) => {
    const tx = db.transaction('dirs', mode), rq = fn(tx.objectStore('dirs'));
    tx.oncomplete = () => { db.close(); res(rq && rq.result); }; tx.onerror = tx.onabort = () => rej(tx.error);
  });
};
const camDB = {
  all: () => idbTx('camera', 'readonly', s => s.getAll()),
  add: h => idbTx('camera', 'readwrite', s => s.add({ handle: h })),
  del: id => idbTx('camera', 'readwrite', s => s.delete(id))
};
/* Photos nằm cùng origin (tuanphong3108.github.io) nên đọc/ghi thẳng DB 'photos' để nó tự theo dõi thư mục */
async function addToPhotos(handle) {
  try {
    const rows = await idbTx('photos', 'readonly', s => s.getAll());
    for (const r of rows) {
      try { if (await r.handle.isSameEntry(handle)) return; } catch (e) { /* bỏ qua */ }
      try { if (await r.handle.resolve(handle)) return; } catch (e) { /* bỏ qua */ }   /* đã nằm trong thư mục cha được theo dõi → thêm nữa sẽ bị trùng ảnh */
    }
    await idbTx('photos', 'readwrite', s => s.add({ handle }));
    const bc = new BroadcastChannel('photos-handoff'); bc.postMessage({ type: 'dirs-changed' }); setTimeout(() => bc.close(), 500);
  } catch (e) { console.warn('Không thể thêm thư mục vào Photos:', e); }
}

let FOLDERS = [];
const activeId = () => +store.get('camera.saveDir') || 0;
const activeFolder = () => FOLDERS.find(f => f.id === activeId()) || null;
async function loadFolders() { try { FOLDERS = await camDB.all(); } catch (e) { FOLDERS = []; } if (!activeFolder() && FOLDERS.length) store.set('camera.saveDir', FOLDERS[0].id); }

async function perm(handle, ask) {
  try {
    const o = { mode: 'readwrite' };
    if ((await handle.queryPermission(o)) === 'granted') return true;
    return ask && (await handle.requestPermission(o)) === 'granted';
  } catch (e) { return false; }
}
async function addFolderHandle(dh) {
  for (const f of FOLDERS) { try { if (await f.handle.isSameEntry(dh)) { store.set('camera.saveDir', f.id); toast(t('folders.dup')); return 'dup'; } } catch (e) { /* bỏ qua */ } }
  let id; try { id = await camDB.add(dh); } catch (e) { id = Date.now(); }
  FOLDERS.push({ id, handle: dh });
  store.set('camera.saveDir', id);
  addToPhotos(dh);
  toast(t('folders.added', { name: dh.name }));
  return 'added';
}
async function pickFolder() {
  if (!window.showDirectoryPicker) { toast(t('folders.unsupported'), 5000); return false; }
  let dh;
  try { dh = await window.showDirectoryPicker({ mode: 'readwrite', id: 'camera', startIn: 'pictures' }); }
  catch (e) { if (e.name !== 'AbortError') toast(t('folders.fail')); return false; }
  return addFolderHandle(dh);
}

/* Hộp thoại quản lý thư mục */
const dlgFolders = $('#dlgFolders');
async function drawFolders() {
  const list = $('#folderList'); list.textContent = '';
  const act = activeId();
  for (const f of FOLDERS) {
    const ok = await perm(f.handle, false);
    const row = document.createElement('div'); row.className = 'frow' + (f.id === act ? ' active' : ''); row.dataset.id = f.id;
    row.innerHTML = '<md-icon data-i="folder"></md-icon><div class="fn"><b></b><span></span></div>';
    $('b', row).textContent = f.handle.name;
    $('span', row).textContent = f.id === act ? t('folders.active') : (ok ? '' : t('folders.reauth'));
    if (f.id !== act) {
      const sel = document.createElement('md-text-button'); sel.dataset.act = 'select'; sel.textContent = t('folders.select'); row.appendChild(sel);
    }
    const del = document.createElement('md-icon-button'); del.dataset.act = 'remove'; del.title = t('folders.remove'); del.setAttribute('aria-label', t('folders.remove'));
    del.innerHTML = '<md-icon data-i="close"></md-icon>'; row.appendChild(del);
    list.appendChild(row);
  }
  paintIcons(list);
  $('#folderEmpty').hidden = FOLDERS.length > 0;
}
$('#folderList').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'), row = e.target.closest('.frow'); if (!b || !row) return;
  const id = +row.dataset.id;
  if (b.dataset.act === 'select') store.set('camera.saveDir', id);
  else {
    try { await camDB.del(id); } catch (err) { /* bỏ qua */ }
    FOLDERS = FOLDERS.filter(f => f.id !== id);
    if (activeId() === id) { FOLDERS.length ? store.set('camera.saveDir', FOLDERS[0].id) : store.del('camera.saveDir'); }
  }
  drawFolders();
});
$('#btnAddFolder').onclick = async () => { if (await pickFolder()) drawFolders(); };
$('#btnFoldersDone').onclick = () => dlgFolders.close();
async function openFolders() { await drawFolders(); dlgFolders.show(); }

/* ---------- Lưu tệp ---------- */
let lastThumb = null;
function setThumb(blob) {
  if (!blob || !/^image\//.test(blob.type)) return;
  if (lastThumb) URL.revokeObjectURL(lastThumb);
  lastThumb = URL.createObjectURL(blob);
  $('#thumbImg').src = lastThumb; $('#thumbImg').hidden = false; $('#thumbIcon').hidden = true;
}
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function uniqueName(dir, name) {
  const dot = name.lastIndexOf('.'), stem = name.slice(0, dot), ext = name.slice(dot);
  for (let i = 1; i < 100; i++) {
    const n = i === 1 ? name : `${stem}-${i}${ext}`;
    try { await dir.getFileHandle(n); } catch (e) { if (e.name === 'NotFoundError') return n; throw e; }
  }
  return name;
}
let lastSaved = null;   /* { handle | file, name } của ảnh / GIF vừa lưu: nút ảnh gửi nó sang Photos */
async function saveBlob(blob, name) {
  setThumb(blob);
  const isImg = /^image\//.test(blob.type);
  const f = activeFolder();
  if (f) {
    if (await perm(f.handle, true)) {
      try {
        name = await uniqueName(f.handle, name);
        const fh = await f.handle.getFileHandle(name, { create: true });
        const w = await fh.createWritable(); await w.write(blob); await w.close();
        if (isImg) lastSaved = { handle: fh, name };
        toast(t('msg.saved_folder', { folder: f.handle.name, name })); return;
      } catch (e) { console.error('Ghi tệp:', e); }
    }
    toast(t('msg.perm_denied'), 4500);
  }
  if (isImg) lastSaved = { file: new File([blob], name, { type: blob.type }), name };
  try { download(blob, name); if (!f) toast(t('msg.saved_download', { name })); } catch (e) { toast(t('msg.save_failed')); }
}

/* ---------- Vẽ khung hình ra canvas ---------- */
function drawFrame(ctx, w, h, filter) {
  ctx.save();
  ctx.filter = filter || 'none';
  if (S.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();
}
const vsize = () => ({ w: video.videoWidth || 1280, h: video.videoHeight || 720 });
const canvasBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

async function takePhoto(isDoc) {
  const { w, h } = vsize(), c = document.createElement('canvas'); c.width = w; c.height = h;
  drawFrame(c.getContext('2d'), w, h, isDoc ? DOC_FILTER : FILTERS[S.filter]);
  const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  const blob = await canvasBlob(c, 'image/jpeg', .95);
  await saveBlob(blob, `${isDoc ? 'scan' : 'photo'}-${stamp()}.jpg`);
}

/* ---------- Đồng hồ khi quay ---------- */
let recClock;
function recTimerStart() {
  const t0 = Date.now(), el = $('#recTime'); el.textContent = '00:00'; $('#recTimer').classList.add('on');
  recClock = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }, 250);
}
function recTimerStop() { clearInterval(recClock); $('#recTimer').classList.remove('on'); }
function setRecording(on) { app.classList.toggle('recording', on); on ? recTimerStart() : recTimerStop(); paintState(); }

/* ---------- Video thường ---------- */
function pickMime() {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function recordStream(stream, label) {
  return new Promise(resolve => {
    const mime = pickMime(), chunks = [];
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = () => resolve(new Blob(chunks, { type: (mr.mimeType || 'video/webm').split(';')[0] }));
    mr.start(500);
    S.rec = { type: label, stop: () => { if (mr.state !== 'inactive') mr.stop(); } };
  });
}
const extOf = b => b.type.includes('mp4') ? 'mp4' : 'webm';
async function startVideo() {
  setRecording(true); toast(t('msg.recording'), 1500);
  const blob = await recordStream(S.stream, 'video');
  S.rec = null; setRecording(false);
  await saveBlob(blob, `video-${stamp()}.${extOf(blob)}`);
}

/* ---------- GIF ---------- */
async function startGif() {
  const { w: vw, h: vh } = vsize(), w = GIF_W, h = Math.round(w * vh / vw);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }), frames = [];
  let stop = false;
  S.rec = { type: 'gif', stop: () => { stop = true; } };
  setRecording(true);
  const t0 = performance.now();
  while (!stop && performance.now() - t0 < GIF_MAX_S * 1000) {
    const s = performance.now();
    drawFrame(ctx, w, h, FILTERS[S.filter]);
    frames.push(ctx.getImageData(0, 0, w, h).data);
    await sleep(Math.max(0, 1000 / GIF_FPS - (performance.now() - s)));
  }
  S.rec = null; setRecording(false);
  if (!frames.length) return;
  toast(t('msg.gif_encoding'), 60000);
  const enc = new GifEncoder(w, h, 1000 / GIF_FPS);
  for (let i = 0; i < frames.length; i++) { enc.addFrame(frames[i]); if (i % 3 === 2) await sleep(0); }
  toastEl.classList.remove('show');
  await saveBlob(enc.finish(), `gif-${stamp()}.gif`);
}

/* ---------- Tua nhanh (Time Lapse) ---------- */
async function startTimeLapse() {
  const { w: vw, h: vh } = vsize(), w = Math.min(1280, vw), h = Math.round(w * vh / vw);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), shots = [];
  let stop = false;
  S.rec = { type: 'timelapse', stop: () => { stop = true; } };
  setRecording(true);
  while (!stop && shots.length < TL_MAX_FRAMES) {
    drawFrame(ctx, w, h, FILTERS[S.filter]);
    shots.push(await canvasBlob(c, 'image/jpeg', .8));
    const until = performance.now() + TL_EVERY_MS;
    while (!stop && performance.now() < until) await sleep(50);
  }
  S.rec = null; setRecording(false);
  if (!shots.length) return;
  toast(t('msg.tl_rendering'), 120000);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const octx = out.getContext('2d'), stream = out.captureStream(TL_PLAY_FPS);
  const done = recordStream(stream, 'render');
  for (const s of shots) {
    const bm = await createImageBitmap(s); octx.drawImage(bm, 0, 0); bm.close();
    await sleep(1000 / TL_PLAY_FPS);
  }
  S.rec.stop(); const blob = await done; S.rec = null;
  toastEl.classList.remove('show');
  await saveBlob(blob, `timelapse-${stamp()}.${extOf(blob)}`);
}

/* ---------- Nút chụp / đếm ngược ---------- */
function countdown(sec) {
  return new Promise(resolve => {
    const el = $('#count'); let n = sec, done = false;
    const show = () => { el.innerHTML = '<span>' + n + '</span>'; el.classList.add('on'); };
    const end = ok => { if (done) return; done = true; clearInterval(iv); el.classList.remove('on'); S.counting = null; app.classList.remove('counting'); paintState(); resolve(ok); };
    S.counting = { cancel: () => end(false) };
    app.classList.add('counting'); show(); toast(t('msg.countdown', { n: sec }), 1500);
    const iv = setInterval(() => { n--; n > 0 ? show() : end(true); }, 1000);
  });
}
let shooting = false;   /* chống bấm chồng: một lần chụp chỉ lưu một tệp */
async function shutter() {
  if (S.counting) { S.counting.cancel(); return; }
  if (S.rec) { S.rec.stop(); return; }
  if (shooting) return;
  shooting = true;
  try { await shutterRun(); } finally { shooting = false; }
}
async function shutterRun() {
  if (!S.stream) { if (!(await startCamera())) return; }
  const f = activeFolder(); if (f) await perm(f.handle, true);   /* xin quyền ngay lúc bấm (cần thao tác của người dùng) */
  if (S.mode === 'scan' && S.sub.scan === 'qr') return;
  if (S.timer > 0 && !(await countdown(S.timer))) return;
  if (S.mode === 'photo') await takePhoto(false);
  else if (S.mode === 'scan') await takePhoto(true);
  else if (S.sub.video === 'gif') await startGif();
  else if (S.sub.video === 'timelapse') await startTimeLapse();
  else await startVideo();
}
$('#shutter').onclick = shutter;
window.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('md-dialog, #gs')) return;
  if (e.key === 'Escape' && S.counting) S.counting.cancel();
  else if ((e.key === ' ' || e.key === 'Enter') && !e.target.closest('button, md-icon-button, md-menu-item')) { e.preventDefault(); shutter(); }
});

/* ---------- Quét mã QR ---------- */
let qrTimer = null, qrDet = null, qrHide;
function qrReset() { clearInterval(qrTimer); qrTimer = null; $('#qrChip').classList.remove('show'); }
function qrStart() {
  if (!('BarcodeDetector' in window)) { toast(t('msg.no_qr'), 4500); return; }
  qrDet = qrDet || new BarcodeDetector({ formats: ['qr_code'] });
  clearInterval(qrTimer);
  qrTimer = setInterval(async () => {
    if (video.readyState < 2) return;
    try {
      const r = await qrDet.detect(video);
      if (!r.length) return;
      const v = r[0].rawValue; $('#qrText').textContent = v; $('#qrChip').dataset.v = v;
      $('#qrOpen').hidden = !/^https?:\/\//i.test(v);
      $('#qrChip').classList.add('show');
      clearTimeout(qrHide); qrHide = setTimeout(() => $('#qrChip').classList.remove('show'), 6000);
    } catch (e) { /* bỏ qua */ }
  }, 300);
}
$('#qrCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#qrChip').dataset.v || ''); toast(t('msg.copied'), 1500); } catch (e) { /* bỏ qua */ } };
$('#qrOpen').onclick = () => openLink($('#qrChip').dataset.v);

/* ---------- Mở liên kết / Photos ---------- */
/* Dùng <a target=_blank rel=noopener> (không phải window.open) để Chrome cho PWA đã cài "bắt" liên kết, giống Photos / Media Player */
function openLink(url) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
}

/* Mở ảnh trong Photos (cùng origin github.io nên dùng chung BroadcastChannel / IndexedDB), giống cách Photos mở video bằng Media Player:
   1) Photos đang mở: gửi handle qua BroadcastChannel 'photos-handoff', Photos trả "ack" và phóng to ảnh đó.
   2) Chưa mở: lưu vào IndexedDB 'photos-handoff' rồi mở Photos?handoff=1, Photos tự đọc và mở ảnh.
   Photos đã cài thành PWA (cờ photos_pwa) thì link cũng mở thẳng cửa sổ ứng dụng. */
const photosInstalled = () => { try { return localStorage.getItem('photos_pwa') === '1'; } catch (e) { return false; } };
function handoffSave(id, items) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('photos-handoff', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('queue', { autoIncrement: true });
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const db = r.result, tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').add({ id, t: Date.now(), items });
      tx.oncomplete = () => { db.close(); res(); }; tx.onerror = tx.onabort = () => rej(tx.error);
    };
  });
}
/* Chưa chụp ảnh nào trong phiên này: lấy ảnh mới nhất trong thư mục lưu (tên có dạng photo-YYYYMMDD-HHMMSS nên xếp theo tên là ra mới nhất) */
async function newestInFolder() {
  const f = activeFolder(); if (!f || !(await perm(f.handle, true))) return null;
  let best = null;
  try {
    for await (const h of f.handle.values()) {
      if (h.kind === 'file' && /^(photo|scan|gif)-\d{8}-\d{6}.*\.(jpe?g|gif)$/i.test(h.name) && (!best || h.name > best.name)) best = h;
    }
  } catch (e) { return null; }
  return best ? { handle: best, name: best.name } : null;
}
async function openInPhotos() {
  const item = lastSaved || await newestInFolder();
  if (!item) { openLink(PHOTOS_URL); return; }
  const items = [item.handle || item.file];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let bc = null;
  try { bc = new BroadcastChannel('photos-handoff'); } catch (e) { /* dùng cách 2 */ }
  const ack = new Promise(res => {
    if (!bc) return res(false);
    const tm = setTimeout(() => res(false), 900);
    bc.onmessage = e => { if (e.data && e.data.type === 'ack' && e.data.id === id) { clearTimeout(tm); res(true); } };
  });
  try { bc && bc.postMessage({ type: 'open', id, items }); } catch (e) { /* bỏ qua */ }
  if (await ack) {
    if (photosInstalled()) {
      /* launch_handler navigate-existing của Photos sẽ tải lại cửa sổ đang mở → để sẵn ảnh trong hàng đợi, trang tải lại sẽ mở lại đúng ảnh */
      try { await handoffSave(id, items); } catch (e) { /* bỏ qua */ }
      openLink(PHOTOS_URL + '?handoff=focus');
    } else toast(t('msg.opened_photos'));
    bc.close(); return;
  }
  try { await handoffSave(id, items); } catch (e) { toast(t('msg.photos_fail')); bc && bc.close(); openLink(PHOTOS_URL); return; }
  openLink(PHOTOS_URL + '?handoff=1');
  bc && setTimeout(() => bc.close(), 4000);
}
$('#thumb').onclick = openInPhotos;

/* ---------- Menu 3 chấm + hộp thoại ---------- */
const menu = $('#menu');
$('#btnMenu').onclick = () => { menu.open = !menu.open; };
$('#miFolders').onclick = openFolders;
$('#miAbout').onclick = () => $('#dlgAbout').show();
$('#btnAboutDone').onclick = () => $('#dlgAbout').close();
$('#miGs').onclick = () => openGettingStarted();

const dlgLang = $('#dlgLang');
function syncLangRadios() { $$('md-radio', dlgLang).forEach(r => { r.checked = r.value === I18N.lang; }); }
$('#miLang').onclick = () => { syncLangRadios(); dlgLang.show(); };
$$('md-list-item[data-lang]', dlgLang).forEach(li => li.onclick = async () => { await I18N.set(li.dataset.lang); syncLangRadios(); });
$('#btnLangDone').onclick = () => dlgLang.close();
document.addEventListener('i18n', () => { paintState(); paintIcons(); });

/* ---------- Hướng dẫn bắt đầu (iframe, giống music-player / photos) ---------- */
const gsBox = $('#gs'), gsFrame = $('#gsFrame');
function openGettingStarted() {
  store.set('camera.gsPending', '1');
  gsFrame.src = 'getting_started.html';
  gsBox.hidden = false;
  requestAnimationFrame(() => gsBox.classList.add('show'));
}
function closeGettingStarted() {
  gsBox.classList.remove('show');
  setTimeout(() => { gsBox.hidden = true; gsFrame.src = 'about:blank'; }, 250);
}
window.addEventListener('message', async e => {
  if (e.source !== gsFrame.contentWindow || !e.data || e.data.type !== 'gs-done') return;
  store.set('camera.gsDone', '1'); store.del('camera.gsPending');
  closeGettingStarted();
  for (const h of e.data.dirs || []) { try { await addFolderHandle(h); } catch (err) { /* bỏ qua */ } }
  if (e.data.lang && e.data.lang !== I18N.lang) await I18N.set(e.data.lang);
});

/* ---------- Khởi động ---------- */
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(err => console.warn('SW:', err)));
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('dragstart', e => e.preventDefault());

(async function init() {
  await I18N.ready;
  paintIcons(); paintState();
  await loadFolders();
  const t0 = performance.now();
  await startCamera();
  if (S.mode === 'scan' && S.sub.scan === 'qr') qrStart();
  await sleep(Math.max(0, 900 - (performance.now() - t0)));
  $('#splash').classList.add('out');
  const first = store.get('camera.gsPending') === '1' || (store.get('camera.gsDone') !== '1' && !FOLDERS.length);
  if (first) openGettingStarted(); else if (FOLDERS.length) store.set('camera.gsDone', '1');
})();
