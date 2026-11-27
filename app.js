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
const TIMERS = [0, 3, 5, 10];
const GIF_MAX_S = 5, GIF_FPS = 10, GIF_W = 480;
const TL_EVERY_MS = 1000, TL_MAX_FRAMES = 600, TL_PLAY_FPS = 15;

const S = {
  mode: 'photo',   /* mở app luôn vào chế độ Ảnh */
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
  S.mode = m;
  if (m === 'scan') app.classList.remove('filters');
  $('#btnFilter').selected = app.classList.contains('filters');
  paintState(); qrReset(); scanSync();
  if (m === 'scan' && S.sub.scan === 'qr') qrStart();
}
function setSub(sub) {
  if (S.rec || S.counting) return;
  S.sub[S.mode] = sub; store.set('camera.sub.' + S.mode, sub);
  paintState(); qrReset(); scanSync();
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
const camDB = {   /* DB cũ của Camera: chỉ còn dùng để chuyển sang danh sách chung với Photos */
  all: () => idbTx('camera', 'readonly', s => s.getAll()),
  del: id => idbTx('camera', 'readwrite', s => s.delete(id))
};
/* Danh sách thư mục = danh sách thư mục theo dõi của Photos (cùng origin → dùng chung DB 'photos').
   Thêm / bỏ ở app nào thì app kia đổi theo; thư mục nào đang lưu ảnh thì Camera nhớ riêng (camera.saveDir). */
const phDB = {
  all: () => idbTx('photos', 'readonly', s => s.getAll()),
  add: h => idbTx('photos', 'readwrite', s => s.add({ handle: h })),
  del: id => idbTx('photos', 'readwrite', s => s.delete(id))
};
let dirsBC = null; try { dirsBC = new BroadcastChannel('photos-handoff'); } catch (e) { /* bỏ qua */ }
const notifyPhotos = (what, id) => { try { dirsBC && dirsBC.postMessage({ type: 'dirs-changed', src: 'camera', what, id }); } catch (e) { /* bỏ qua */ } };

let FOLDERS = [];
const activeId = () => +store.get('camera.saveDir') || 0;
const activeFolder = () => FOLDERS.find(f => f.id === activeId()) || null;
const knownIds = () => { try { return JSON.parse(store.get('camera.knownDirs') || 'null'); } catch (e) { return null; } };
const setKnown = () => store.set('camera.knownDirs', JSON.stringify(FOLDERS.map(f => f.id)));
const sameDir = async (a, b) => { try { return await a.isSameEntry(b); } catch (e) { return false; } };

/* Bản cũ lưu thư mục riêng trong DB 'camera': gộp sang danh sách chung rồi xóa */
async function migrateFolders() {
  if (store.get('camera.mig') === '1') return;
  let old = []; try { old = await camDB.all(); } catch (e) { /* bỏ qua */ }
  const oldAct = activeId();
  const rows = await phDB.all();
  for (const o of old) {
    let hit = null;
    for (const r of rows) if (await sameDir(r.handle, o.handle)) { hit = r; break; }
    if (!hit) { const id = await phDB.add(o.handle); hit = { id, handle: o.handle }; rows.push(hit); }
    if (o.id === oldAct) store.set('camera.saveDir', hit.id);
    try { await camDB.del(o.id); } catch (e) { /* bỏ qua */ }
  }
  store.set('camera.mig', '1');
  if (old.length) notifyPhotos('added');
}
async function loadFolders() {
  try { await migrateFolders(); } catch (e) { console.warn('Chuyển thư mục:', e); }
  try { FOLDERS = (await phDB.all()).map(r => ({ id: r.id, handle: r.handle })); } catch (e) { FOLDERS = []; }
  if (!activeFolder()) FOLDERS.length ? store.set('camera.saveDir', FOLDERS[0].id) : store.del('camera.saveDir');
  if (!knownIds()) setKnown();
}

/* Hộp thoại hỏi lưu ảnh vào thư mục nào (xếp hàng nếu có nhiều yêu cầu) */
let askChain = Promise.resolve();
function askFolder(msg, pre) {
  const run = () => new Promise(res => {
    if (FOLDERS.length <= 1) { FOLDERS[0] ? store.set('camera.saveDir', FOLDERS[0].id) : store.del('camera.saveDir'); return res(); }
    const dlg = $('#dlgPick'), list = $('#pickList'); let sel = FOLDERS.some(f => f.id === pre) ? pre : (activeFolder() || FOLDERS[0]).id;
    $('#pickMsg').textContent = msg; list.textContent = '';
    const sync = () => $$('md-radio', list).forEach(r => { r.checked = +r.value === sel; });
    for (const f of FOLDERS) {
      const li = document.createElement('md-list-item'); li.type = 'button';
      li.innerHTML = '<md-radio slot="start" name="pickdir" touch-target="wrapper"></md-radio><div slot="headline"></div>';
      $('md-radio', li).value = String(f.id); $('[slot=headline]', li).textContent = f.handle.name;
      li.onclick = () => { sel = f.id; sync(); };
      list.appendChild(li);
    }
    sync();
    const done = () => { dlg.removeEventListener('closed', done); store.set('camera.saveDir', sel); if (dlgFolders.open) drawFolders(); res(); };
    dlg.addEventListener('closed', done); dlg.show();
  });
  askChain = askChain.then(run, run); return askChain;
}
/* Đồng bộ với Photos: thư mục mới → hỏi lưu vào đâu; thư mục đang lưu bị bỏ → hỏi lại */
async function syncFolders() {
  let rows; try { rows = await phDB.all(); } catch (e) { return; }
  const was = knownIds() || FOLDERS.map(f => f.id), hadActive = activeId();
  FOLDERS = rows.map(r => ({ id: r.id, handle: r.handle })); setKnown();
  const added = FOLDERS.filter(f => !was.includes(f.id));
  if (!FOLDERS.length) { store.del('camera.saveDir'); if (dlgFolders.open) drawFolders(); return; }
  if (added.length) await askFolder(t('pick.added', { names: added.map(f => '“' + f.handle.name + '”').join(', ') }), FOLDERS.some(f => f.id === hadActive) ? hadActive : added[added.length - 1].id);   /* tick sẵn thư mục đang dùng, không phải thư mục mới */
  else if (!FOLDERS.some(f => f.id === hadActive)) await askFolder(t('pick.removed'), FOLDERS[0].id);
  else if (dlgFolders.open) drawFolders();
  if (!activeFolder()) store.set('camera.saveDir', FOLDERS[0].id);
}
if (dirsBC) dirsBC.addEventListener('message', e => { if (e.data && e.data.type === 'dirs-changed' && e.data.src === 'photos') syncFolders(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#splash').classList.contains('out')) syncFolders(); });

async function perm(handle, ask) {
  try {
    const o = { mode: 'readwrite' };
    if ((await handle.queryPermission(o)) === 'granted') return true;
    return ask && (await handle.requestPermission(o)) === 'granted';
  } catch (e) { return false; }
}
async function addFolderHandle(dh) {
  for (const f of FOLDERS) { if (await sameDir(f.handle, dh)) { store.set('camera.saveDir', f.id); toast(t('folders.dup')); return 'dup'; } }
  let id; try { id = await phDB.add(dh); } catch (e) { id = Date.now(); }
  FOLDERS.push({ id, handle: dh }); setKnown();
  store.set('camera.saveDir', id);
  notifyPhotos('added', id);
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
    const wasActive = activeId() === id;
    try { await phDB.del(id); } catch (err) { /* bỏ qua */ }
    FOLDERS = FOLDERS.filter(f => f.id !== id); setKnown(); notifyPhotos('removed', id);
    if (wasActive) { if (FOLDERS.length) await askFolder(t('pick.removed'), FOLDERS[0].id); else store.del('camera.saveDir'); }
  }
  drawFolders();
});
$('#btnAddFolder').onclick = async () => { if (await pickFolder()) drawFolders(); };
$('#btnFoldersDone').onclick = () => dlgFolders.close();
async function openFolders() { await drawFolders(); dlgFolders.show(); }

/* ---------- Lưu tệp ---------- */
let lastThumb = null;
function setThumbImg(blob) {
  if (lastThumb) URL.revokeObjectURL(lastThumb);
  lastThumb = URL.createObjectURL(blob);
  $('#thumbImg').src = lastThumb; $('#thumbImg').hidden = false; $('#thumbIcon').hidden = true;
}
function setThumb(blob) {
  if (!blob) return;
  if (/^image\//.test(blob.type)) return setThumbImg(blob);
  if (!/^video\//.test(blob.type)) return;
  /* Video: lấy một khung hình làm ảnh nhỏ */
  const v = document.createElement('video'), u = URL.createObjectURL(blob); v.muted = true; v.preload = 'auto'; v.src = u;
  const end = () => URL.revokeObjectURL(u);
  v.onloadeddata = () => { try { v.currentTime = 0.05; } catch (e) { end(); } };
  v.onseeked = () => {
    try {
      const c = document.createElement('canvas'); c.width = 160; c.height = Math.round(160 * (v.videoHeight || 90) / (v.videoWidth || 160)) || 90;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); c.toBlob(b => { if (b) setThumbImg(b); end(); }, 'image/jpeg', .8);
    } catch (e) { end(); }
  };
  v.onerror = end;
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
  const isImg = /^image\//.test(blob.type), isVid = /^video\//.test(blob.type);
  const f = activeFolder();
  if (f) {
    if (await perm(f.handle, true)) {
      try {
        name = await uniqueName(f.handle, name);
        const fh = await f.handle.getFileHandle(name, { create: true });
        const w = await fh.createWritable(); await w.write(blob); await w.close();
        if (isImg || isVid) lastSaved = { handle: fh, name };
        toast(t('msg.saved_folder', { folder: f.handle.name, name })); return;
      } catch (e) { console.error('Ghi tệp:', e); }
    }
    toast(t('msg.perm_denied'), 4500);
  }
  if (isImg || isVid) lastSaved = { file: new File([blob], name, { type: blob.type }), name };
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

async function takePhoto() {
  const { w, h } = vsize(), c = document.createElement('canvas'); c.width = w; c.height = h;
  drawFrame(c.getContext('2d'), w, h, FILTERS[S.filter]);
  const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  const blob = await canvasBlob(c, 'image/jpeg', .95);
  await saveBlob(blob, `photo-${stamp()}.jpg`);
}

/* ---------- Đồng hồ khi quay ---------- */
let recClock;
function recTimerStart() {
  const t0 = Date.now(), el = $('#recTime'); el.textContent = '00:00'; $('#recTimer').classList.add('on');
  recClock = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }, 250);
}
function recTimerStop() { clearInterval(recClock); $('#recTimer').classList.remove('on'); }
function setRecording(on) { app.classList.toggle('recording', on); on ? recTimerStart() : recTimerStop(); paintState(); }

/* ---------- Video thường & Tua nhanh (xuất MP4 chuẩn kèm đầy đủ metadata) ---------- */
function pickMp4Mime() {
  return [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.4D4028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4'
  ].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function pickFallbackMime() {
  return pickMp4Mime() || ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function recordStreamFallback(stream, label) {
  return new Promise(resolve => {
    const mime = pickFallbackMime(), chunks = [];
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = () => resolve(new Blob(chunks, { type: (mr.mimeType || 'video/webm').split(';')[0] }));
    mr.start(500);
    S.rec = { type: label, stop: () => { if (mr.state !== 'inactive') mr.stop(); } };
  });
}
const extOf = b => b.type.includes('mp4') ? 'mp4' : 'webm';
const activeCameraLabel = () => {
  const tr = S.stream && S.stream.getVideoTracks()[0];
  return (tr && tr.label) || (S.devices[S.devIdx] && S.devices[S.devIdx].label) || '';
};

async function finalizeMp4Blob(blob, meta) {
  if (!blob || !blob.type.includes('mp4') || !window.Mp4Recorder) return blob;
  try {
    const buf = await blob.arrayBuffer();
    const patched = window.Mp4Recorder.injectMetadataIntoMp4(buf, meta);
    return new Blob([patched], { type: 'video/mp4' });
  } catch (e) {
    console.warn('Tiêm metadata MP4:', e);
    return blob;
  }
}

async function startVideo() {
  const { w, h } = vsize();
  const track = S.stream && S.stream.getVideoTracks()[0];
  const fps = Math.round((track && track.getSettings && track.getSettings().frameRate) || 30) || 30;
  const audioTrack = !S.muted && S.stream ? S.stream.getAudioTracks()[0] : null;
  const metaOpts = {
    width: w & ~1, height: h & ~1, fps, mode: 'video',
    filter: S.filter, mirror: S.mirror, cameraLabel: activeCameraLabel()
  };

  /* 1. Ưu tiên WebCodecs (H.264 + AAC) → MP4 fast-start + full metadata + áp dụng sẵn bộ lọc & lật gương */
  if (window.Mp4Recorder && window.Mp4Recorder.createRealtimeRecorder) {
    try {
      const wcRec = await window.Mp4Recorder.createRealtimeRecorder({
        ...metaOpts,
        audioTrack,
        drawFrame: (ctx, cw, ch) => drawFrame(ctx, cw, ch, FILTERS[S.filter])
      });
      if (wcRec) {
        let doneResolve;
        const done = new Promise(r => { doneResolve = r; });
        S.rec = {
          type: 'video',
          stop: async () => {
            if (!S.rec) return;
            S.rec = null;
            setRecording(false);
            toast(t('msg.mp4_encoding'), 60000);
            try {
              const mp4Blob = await wcRec.stop();
              toastEl.classList.remove('show');
              doneResolve(mp4Blob);
            } catch (err) {
              console.error('WebCodecs stop:', err);
              toastEl.classList.remove('show');
              doneResolve(null);
            }
          }
        };
        setRecording(true); toast(t('msg.recording'), 1500);
        const blob = await done;
        if (blob && blob.size > 0) {
          await saveBlob(blob, `video-${stamp()}.mp4`);
          return;
        }
      }
    } catch (e) {
      console.warn('WebCodecs MP4 fallback:', e);
    }
  }

  /* 2. Fallback: MediaRecorder (ưu tiên video/mp4 rồi tiêm box metadata udta/XMP) */
  setRecording(true); toast(t('msg.recording'), 1500);
  let blob = await recordStreamFallback(S.stream, 'video');
  S.rec = null; setRecording(false);
  if (blob.type.includes('mp4') && window.Mp4Recorder) {
    blob = await finalizeMp4Blob(blob, window.Mp4Recorder.buildRecordingMetadata(metaOpts));
  }
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

/* ---------- Tua nhanh (Time Lapse — xuất MP4 chuẩn kèm metadata) ---------- */
async function startTimeLapse() {
  const { w: vw, h: vh } = vsize(), w = Math.min(1280, vw) & ~1, h = Math.round(w * vh / vw) & ~1;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), shots = [];
  let stop = false;
  S.rec = { type: 'timelapse', stop: () => { stop = true; } };
  setRecording(true);
  while (!stop && shots.length < TL_MAX_FRAMES) {
    drawFrame(ctx, w, h, FILTERS[S.filter]);
    shots.push(await canvasBlob(c, 'image/jpeg', .85));
    const until = performance.now() + TL_EVERY_MS;
    while (!stop && performance.now() < until) await sleep(50);
  }
  S.rec = null; setRecording(false);
  if (!shots.length) return;
  toast(t('msg.tl_rendering'), 120000);

  const metaOpts = {
    width: w, height: h, fps: TL_PLAY_FPS, mode: 'timelapse',
    filter: S.filter, mirror: S.mirror, cameraLabel: activeCameraLabel()
  };

  /* Ưu tiên đóng gói trực tiếp bằng WebCodecs H.264 → MP4 chuẩn + đủ metadata */
  if (window.Mp4Recorder && window.Mp4Recorder.encodeFramesToMp4) {
    try {
      const mp4Blob = await window.Mp4Recorder.encodeFramesToMp4(shots, metaOpts);
      if (mp4Blob && mp4Blob.size > 0) {
        toastEl.classList.remove('show');
        await saveBlob(mp4Blob, `timelapse-${stamp()}.mp4`);
        return;
      }
    } catch (e) {
      console.warn('TimeLapse WebCodecs fallback:', e);
    }
  }

  /* Fallback MediaRecorder */
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const octx = out.getContext('2d'), stream = out.captureStream(TL_PLAY_FPS);
  const done = recordStreamFallback(stream, 'render');
  for (const s of shots) {
    const bm = await createImageBitmap(s); octx.drawImage(bm, 0, 0); bm.close();
    await sleep(1000 / TL_PLAY_FPS);
  }
  S.rec.stop(); let blob = await done; S.rec = null;
  if (blob.type.includes('mp4') && window.Mp4Recorder) {
    blob = await finalizeMp4Blob(blob, window.Mp4Recorder.buildRecordingMetadata(metaOpts));
  }
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
  if (shooting || SC.open) return;
  shooting = true;
  try { await shutterRun(); } finally { shooting = false; }
}
async function shutterRun() {
  if (!S.stream) { if (!(await startCamera())) return; }
  const f = activeFolder(); if (f) await perm(f.handle, true);   /* xin quyền ngay lúc bấm (cần thao tác của người dùng) */
  if (S.mode === 'scan' && S.sub.scan === 'qr') return;
  if (S.timer > 0 && !(await countdown(S.timer))) return;
  if (S.mode === 'photo') await takePhoto();
  else if (S.mode === 'scan') await docShoot();
  else if (S.sub.video === 'gif') await startGif();
  else if (S.sub.video === 'timelapse') await startTimeLapse();
  else await startVideo();
}
$('#shutter').onclick = shutter;


/* ---------- Quét tài liệu (kiểu ChromeOS): khung bám tờ giấy → nắn phẳng → xem lại → thêm trang → lưu ảnh / PDF ---------- */
const SC = { pages: [], cur: 0, quad: null, miss: 0, timer: null, open: false, edit: null, cv: null };
window.__SC = SC;   // cho kiểm thử
/* ---------- Tải thư viện có hiện tiến trình (vòng tròn + số lượng dưới nút 3 chấm, bấm để xem chi tiết) ---------- */
const DL = new Map();
let dlRaf = 0;
function dlPaint() {
  if (dlRaf) return;
  dlRaf = requestAnimationFrame(() => {
    dlRaf = 0;
    const act = [...DL.values()].filter(d => !d.done), wrap = $('#dlWrap');
    wrap.hidden = !act.length;
    if (!act.length) { $('#dlPop').hidden = true; return; }
    const pct = d => Math.min(99, Math.round(d.loaded / d.total * 100));
    const loaded = act.reduce((s, d) => s + d.loaded, 0), total = act.reduce((s, d) => s + d.total, 0), ring = $('#dlRing');
    $('#dlNum').textContent = act.length;
    ring.indeterminate = !loaded || !total; if (!ring.indeterminate) ring.value = Math.min(.99, loaded / total);
    const list = $('#dlList'); list.textContent = '';
    for (const d of act) {
      const row = document.createElement('div'); row.className = 'dl-row';
      row.innerHTML = '<div class="t"><span></span><b></b></div><div class="bar"><i></i></div>';
      $('span', row).textContent = t('dl.' + d.id); $('b', row).textContent = d.total ? pct(d) + '%' : '…';
      $('i', row).style.width = (d.total ? pct(d) : 0) + '%'; list.appendChild(row);
    }
  });
}
$('#dlBtn').onclick = e => { e.stopPropagation(); const p = $('#dlPop'); p.hidden = !p.hidden; };
document.addEventListener('click', e => { if (!e.target.closest('#dlWrap')) $('#dlPop').hidden = true; });
/* Tải có đếm byte. url là một đường dẫn (trả về blob URL) hoặc danh sách [url, size] chỉ để tải trước vào cache (không trả gì).
   size = dung lượng dự kiến khi máy chủ nén/không báo Content-Length */
async function fetchLib(id, url, size) {
  const many = Array.isArray(url), files = many ? url : [[url, size]];
  const d = { id, loaded: 0, total: many ? files.reduce((n, f) => n + f[1], 0) : (size || 0), done: false }; DL.set(id, d); dlPaint();
  try {
    let blobUrl = null;
    for (const [u] of files) {
      const r = await fetch(u); if (!r.ok) throw new Error(r.status);
      const len = +r.headers.get('content-length') || 0; if (len && !d.total) d.total = len;
      if (!r.body) { const b = await r.blob(); d.loaded += b.size; blobUrl = URL.createObjectURL(b); continue; }
      const rd = r.body.getReader(), parts = [];
      for (;;) { const { done, value } = await rd.read(); if (done) break; if (!many) parts.push(value); d.loaded += value.length; if (d.total && d.loaded > d.total) d.total = d.loaded + 1; dlPaint(); }
      if (!many) blobUrl = URL.createObjectURL(new Blob(parts, { type: 'text/javascript' }));
    }
    return many ? null : blobUrl;
  } finally { d.done = true; dlPaint(); setTimeout(() => DL.delete(id), 0); }
}
/* Mô hình AI nhận diện góc tài liệu (~3,5 MB): tải khi vào Quét → Tài liệu; có rồi thì ưu tiên dùng, chưa có thì dùng OpenCV / bộ nhẹ */
let mlLoad = null;
function loadML() {
  if (mlLoad) return mlLoad;
  return mlLoad = import('./ml-detect.js').then(async m => { await fetchLib('ml', m.FILES); await m.load(); SC.ml = m; }).catch(e => { console.warn('ML:', e); mlLoad = null; });
}
/* OpenCV.js (vendor/opencv.js, ~10 MB) chỉ nạp khi vào chế độ quét tài liệu; chưa nạp xong thì dùng bộ nhận diện nhẹ trong scanner.js */
let cvLoad = null;
function loadCV() {
  if (cvLoad) return cvLoad;
  return cvLoad = fetchLib('opencv', 'vendor/opencv.js', 10378215).then(u => new Promise(res => {
    const sc = document.createElement('script'); sc.src = u;
    sc.onload = () => { URL.revokeObjectURL(u); const c = window.cv; if (!c) return res(null); if (c.Mat) return res({ c }); c.onRuntimeInitialized = () => res({ c }); };   /* bọc lại: cv là thenable, resolve thẳng sẽ lặp vô hạn */
    sc.onerror = () => res(null);
    document.head.appendChild(sc);
  })).catch(() => null).then(r => { SC.cv = r && r.c; if (!SC.cv) cvLoad = null; });   /* không trả cv ra khỏi then (thenable) */
}
/* Mô hình phân đoạn (U²-Net-P, ~16 MB, ~1 giây/khung): chỉ nạp sau cùng và chỉ chạy khi chụp / dò lại; giúp bìa cứng, tay cầm */
let segLoad = null;
function loadSeg() {
  if (segLoad) return segLoad;
  return segLoad = import('./seg-detect.js').then(async m => { await fetchLib('seg', m.FILES); await m.load(); SC.seg = m; }).catch(e => { console.warn('SEG:', e); segLoad = null; });
}
const detectQuad = (data, w, h, mask) => (SC.cv && Scanner.findQuadCV(SC.cv, data, w, h, mask)) || Scanner.findQuad(data, w, h);
/* Độ trùng (IoU) giữa tứ giác q (toạ độ 0–1) và mặt nạ w×h */
function quadIoU(q, mask, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.beginPath(); q.forEach((p, i) => x[i ? 'lineTo' : 'moveTo'](p[0] * w, p[1] * h)); x.fill();
  const d = x.getImageData(0, 0, w, h).data; let a = 0, u = 0;
  for (let i = 0; i < w * h; i++) { const p = d[i * 4] > 127, m = mask[i] > 127; if (p && m) a++; if (p || m) u++; }
  return u ? a / u : 0;
}
const dcv = $('#docCanvas'), dsmall = document.createElement('canvas'), scanView = $('#scanView');
function scanSync() {
  const on = S.mode === 'scan' && S.sub.scan === 'document';
  if (!on) {
    clearInterval(SC.timer); SC.timer = null; SC.quad = null; docDraw();
    if (S.mode !== 'scan') scanReset();
  } else { loadML(); loadCV().then(loadSeg); if (!SC.timer) SC.timer = setInterval(docTick, 350); }
  paintBadge();
}
function scanReset() { SC.pages.forEach(p => p.url && URL.revokeObjectURL(p.url)); SC.pages = []; SC.cur = 0; }
function paintBadge() {
  const b = $('#scanBadge'), on = S.mode === 'scan' && S.sub.scan === 'document' && !SC.open;
  const txt = SC.pages.length ? t('scan.page', { n: SC.pages.length + 1 }) : (SC.quad ? '' : t('scan.hint'));
  b.textContent = txt; b.classList.toggle('show', on && !!txt);
}
/* Tìm 4 góc tài liệu trong src (video / canvas): AI trước (cần điểm tin cậy ≥ 0,5), không được thì OpenCV / bộ nhẹ. Trả về toạ độ 0–1 hoặc null */
const quadOk = q => { let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4], r = q[(i + 2) % 4]; if ((n[0] - p[0]) * (r[1] - p[1]) - (n[1] - p[1]) * (r[0] - p[0]) <= 0) return false; a += p[0] * n[1] - n[0] * p[1]; } return Math.abs(a) / 2 > .08; };
async function findDoc(src, sw, sh, maxW, deep) {
  /* Trọng tài: AI góc, OpenCV (có mặt nạ phân đoạn khi deep) → chọn tứ giác khớp mặt nạ nhất; không có mặt nạ thì AI trước (điểm ≥ 0,5) rồi OpenCV */
  let qml = null;
  if (SC.ml) {
    try { const r = await SC.ml.detect(src); if (r && r.score >= .5 && quadOk(r.q)) qml = r.q.map(p => [Math.max(0, Math.min(1, p[0])), Math.max(0, Math.min(1, p[1]))]); } catch (e) { /* dùng cách cổ điển */ }
  }
  if (qml && !(deep && SC.seg)) return qml;
  const w = Math.min(sw, maxW), h = Math.round(w * sh / sw);
  dsmall.width = w; dsmall.height = h;
  const x = dsmall.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, w, h);
  let mask = null; if (deep && SC.seg) { try { mask = await SC.seg.mask(dsmall, w, h); } catch (e) { /* bỏ qua */ } }
  let q = null; try { q = detectQuad(x.getImageData(0, 0, w, h).data, w, h, mask); } catch (e) { /* bỏ qua */ }
  const qcv = q ? q.map(p => [p[0] / w, p[1] / h]) : null;
  if (qml && qcv && mask) {
    const sc = 96 / w, mw = 96, mh = Math.max(1, Math.round(h * sc)), mc = document.createElement('canvas'); mc.width = mw; mc.height = mh;
    const mx = mc.getContext('2d', { willReadFrequently: true }), id = mx.createImageData(mw, mh), s2 = document.createElement('canvas'); s2.width = w; s2.height = h;
    const si = s2.getContext('2d').createImageData(w, h); for (let i = 0; i < w * h; i++) si.data[i * 4] = si.data[i * 4 + 1] = si.data[i * 4 + 2] = mask[i], si.data[i * 4 + 3] = 255;
    s2.getContext('2d').putImageData(si, 0, 0); mx.drawImage(s2, 0, 0, mw, mh);
    const md = mx.getImageData(0, 0, mw, mh).data, sm = new Uint8Array(mw * mh); for (let i = 0; i < mw * mh; i++) sm[i] = md[i * 4];
    return quadIoU(qml, sm, mw, mh) >= quadIoU(qcv, sm, mw, mh) - .03 ? qml : qcv;
  }
  return qcv || qml;
}
let ticking = false;
async function docTick() {
  if (ticking || SC.open || video.readyState < 2 || !video.videoWidth || !window.Scanner) return;
  ticking = true;
  try {
    let q = await findDoc(video, video.videoWidth, video.videoHeight, 480);   /* ≥ 480px để bắt cạnh nhạt */
    if (SC.open) return;
    if (q) {
      SC.miss = 0;
      if (SC.quad && SC.quad.every((p, i) => Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) < .15)) q = q.map((p, i) => [(SC.quad[i][0] + p[0]) / 2, (SC.quad[i][1] + p[1]) / 2]);
      SC.quad = q;
    } else if (++SC.miss >= 3) SC.quad = null;
    docDraw(); paintBadge();
  } finally { ticking = false; }
}
function docDraw() {
  const r = $('#viewfinder').getBoundingClientRect(), dpr = window.devicePixelRatio || 1, W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (dcv.width !== W || dcv.height !== H) { dcv.width = W; dcv.height = H; }
  const c = dcv.getContext('2d'); c.clearRect(0, 0, W, H);
  if (!SC.quad || !video.videoWidth) return;
  const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  const P = SC.quad.map(p => [ox + p[0] * vw * s, oy + p[1] * vh * s]);
  c.beginPath(); P.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
  c.fillStyle = 'rgba(255,193,7,.18)'; c.fill(); c.lineWidth = 2 * dpr; c.strokeStyle = 'rgba(255,193,7,.85)'; c.stroke();
  /* Dấu góc đậm như ChromeOS */
  const side = Math.min(...P.map((p, i) => Math.hypot(p[0] - P[(i + 1) % 4][0], p[1] - P[(i + 1) % 4][1]))), L = Math.max(14 * dpr, side * .12);
  c.lineWidth = 6 * dpr; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = '#ffc107';
  P.forEach((p, i) => {
    const a = P[(i + 1) % 4], b = P[(i + 3) % 4], da = Math.hypot(a[0] - p[0], a[1] - p[1]) || 1, db = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    c.beginPath(); c.moveTo(p[0] + (a[0] - p[0]) / da * L, p[1] + (a[1] - p[1]) / da * L); c.lineTo(p[0], p[1]); c.lineTo(p[0] + (b[0] - p[0]) / db * L, p[1] + (b[1] - p[1]) / db * L); c.stroke();
  });
}
window.addEventListener('resize', () => { if (SC.timer) docDraw(); });

async function renderPage(pg) {
  const raw = pg.raw, id = raw.getContext('2d').getImageData(0, 0, raw.width, raw.height);
  const o = Scanner.warp(id.data, raw.width, raw.height, pg.quad, 2200);   /* giữ nguyên màu, không chỉnh sáng/tương phản */
  const c = document.createElement('canvas'); c.width = o.w; c.height = o.h;
  c.getContext('2d').putImageData(new ImageData(o.data, o.w, o.h), 0, 0);
  const blob = await canvasBlob(c, 'image/jpeg', .92);
  if (pg.url) URL.revokeObjectURL(pg.url);
  pg.blob = blob; pg.url = URL.createObjectURL(blob); pg.w = o.w; pg.h = o.h;
}
async function docShoot() {
  const { w, h } = vsize(), raw = document.createElement('canvas'); raw.width = w; raw.height = h;
  raw.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, w, h);            /* tài liệu luôn chụp không lật gương */
  const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  let quad = SC.quad ? SC.quad.map(p => [p[0] * w, p[1] * h]) : [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]];
  try {   /* dò lại trên chính khung vừa chụp (khung xem trước có thể đã trễ vài trăm ms) */
    const q2 = await findDoc(raw, w, h, 800, true);
    if (q2) quad = q2.map(p => [p[0] * w, p[1] * h]);
  } catch (e) { /* giữ khung đang hiện */ }
  const pg = { raw, quad }; await renderPage(pg);
  SC.pages.push(pg); SC.cur = SC.pages.length - 1; openScan();
}
function openScan() { SC.open = true; scanView.hidden = false; paintScan(); paintBadge(); }
function closeScan(discard) {
  SC.open = false; scanView.hidden = true; SC.edit = null; scanView.removeAttribute('data-edit'); $('#edBox').hidden = true; $('#svImg').hidden = false;
  if (discard) scanReset(); paintBadge();
}
function paintScan() {
  const n = SC.pages.length, pg = SC.pages[SC.cur]; if (!pg) return closeScan(true);
  $('#svImg').src = pg.url; scanView.classList.toggle('multi', n > 1);
  $('#svDel').hidden = n < 2; $('#svTitle').textContent = n > 1 ? t('scan.title', { n: SC.cur + 1, m: n }) : '';
  const box = $('#svThumbs'); box.textContent = '';
  SC.pages.forEach((p, i) => {
    const b = document.createElement('button'); b.className = i === SC.cur ? 'on' : '';
    b.innerHTML = '<img alt=""><b></b>'; $('img', b).src = p.url; $('b', b).textContent = i + 1;
    b.onclick = () => { SC.cur = i; paintScan(); }; box.appendChild(b);
  });
}
$('#svCancel').onclick = () => { if (SC.edit) endEdit(false); else closeScan(true); };
$('#svAdd').onclick = () => closeScan(false);
$('#svDel').onclick = () => { const p = SC.pages.splice(SC.cur, 1)[0]; if (p && p.url) URL.revokeObjectURL(p.url); SC.cur = Math.max(0, Math.min(SC.cur, SC.pages.length - 1)); paintScan(); };
async function scanSaveAs(kind) {
  const pages = SC.pages.slice(), st = stamp(); if (!pages.length) return;
  closeScan(false);
  if (kind === 'pdf') {
    const list = [];
    for (const p of pages) list.push({ jpeg: new Uint8Array(await p.blob.arrayBuffer()), w: p.w, h: p.h });
    download(new Blob([Scanner.pdf(list)], { type: 'application/pdf' }), `scan-${st}.pdf`); toast(t('msg.saved_download', { name: `scan-${st}.pdf` }));   /* PDF: tải xuống, không ghi vào thư mục lưu ảnh */
  } else {
    for (let i = 0; i < pages.length; i++) await saveBlob(pages[i].blob, `scan-${st}${pages.length > 1 ? '-' + (i + 1) : ''}.jpg`);
    if (pages.length > 1) toast(t('scan.saved_n', { n: pages.length }));
  }
  scanReset(); paintBadge();
}
$('#svPhoto').onclick = () => scanSaveAs('photo');
$('#svPdf').onclick = () => scanSaveAs('pdf');
$('#svShare').onclick = async () => {
  try {
    const pages = SC.pages, st = stamp(); let files;
    if (pages.length > 1) {
      const list = []; for (const p of pages) list.push({ jpeg: new Uint8Array(await p.blob.arrayBuffer()), w: p.w, h: p.h });
      files = [new File([Scanner.pdf(list)], `scan-${st}.pdf`, { type: 'application/pdf' })];
    } else files = [new File([pages[SC.cur].blob], `scan-${st}.jpg`, { type: 'image/jpeg' })];
    if (navigator.canShare && navigator.canShare({ files })) await navigator.share({ files }); else toast(t('scan.share_fail'), 4500);
  } catch (e) { if (e.name !== 'AbortError') toast(t('scan.share_fail'), 4500); }
};

/* Chỉnh góc: kéo 4 chấm vàng trên ảnh gốc, bấm Xong thì nắn phẳng lại */
function fitEdit() {
  const ed = SC.edit; if (!ed) return;
  const st = $('#svStage').getBoundingClientRect(), pad = 40, raw = ed.pg.raw;
  const s = Math.min((st.width - pad) / raw.width, (st.height - pad) / raw.height), box = $('#edBox');
  box.style.width = Math.round(raw.width * s) + 'px'; box.style.height = Math.round(raw.height * s) + 'px';
  paintEdit();
}
function paintEdit() {
  const ed = SC.edit, raw = ed.pg.raw;
  $$('#edBox .hd').forEach((el, i) => { el.style.left = ed.q[i][0] / raw.width * 100 + '%'; el.style.top = ed.q[i][1] / raw.height * 100 + '%'; });
  $$('#edBox .hm').forEach((el, i) => { const p = ed.q[i], n = ed.q[(i + 1) % 4]; el.style.left = (p[0] + n[0]) / 2 / raw.width * 100 + '%'; el.style.top = (p[1] + n[1]) / 2 / raw.height * 100 + '%'; });
  const b = $('#edBox').getBoundingClientRect();
  $('#edPoly').setAttribute('points', ed.q.map(p => `${p[0] / raw.width * b.width},${p[1] / raw.height * b.height}`).join(' '));
}
function startEdit() {
  const pg = SC.pages[SC.cur]; if (!pg) return;
  SC.edit = { pg, q: pg.quad.map(p => p.slice()) };
  const box = $('#edBox'); let cv = $('canvas:not(#edLoupe)', box); if (cv) cv.remove();
  cv = pg.raw; cv.style.cssText = ''; box.insertBefore(cv, box.firstChild);
  scanView.dataset.edit = '1'; $('#svImg').hidden = true; box.hidden = false; fitEdit();
}
async function endEdit(apply) {
  const ed = SC.edit; if (!ed) return; SC.edit = null;
  if (apply) { ed.pg.quad = ed.q; try { await renderPage(ed.pg); } catch (e) { /* giữ bản cũ */ } }
  scanView.removeAttribute('data-edit'); $('#edBox').hidden = true; $('#svImg').hidden = false; paintScan();
}
$('#svEditBtn').onclick = startEdit;
$('#svEdDone').onclick = () => endEdit(true);
$('#svEdCancel').onclick = () => endEdit(false);
$('#svEdAuto').onclick = async () => {   /* dò lại góc trên ảnh gốc */
  const ed = SC.edit; if (!ed) return; const raw = ed.pg.raw;
  let q = null; try { q = await findDoc(raw, raw.width, raw.height, 800, true); } catch (e) { /* bỏ qua */ }
  if (!SC.edit) return;
  ed.q = q ? q.map(p => [p[0] * raw.width, p[1] * raw.height]) : [[0, 0], [raw.width - 1, 0], [raw.width - 1, raw.height - 1], [0, raw.height - 1]];
  paintEdit();
};
/* Kính lúp: phóng 3× vùng quanh điểm đang kéo, đặt lệch lên trên (hoặc xuống dưới nếu sát mép) để ngón tay không che */
function loupe(rx, ry, show) {
  const L = $('#edLoupe'); if (!show || !SC.edit) { L.hidden = true; return; }
  const raw = SC.edit.pg.raw, b = $('#edBox').getBoundingClientRect(), n = L.width, z = 3, sw = n / z * (raw.width / b.width);   /* sw: cạnh vùng nguồn (px ảnh gốc) */
  const x = L.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, n, n);
  x.drawImage(raw, rx - sw / 2, ry - sw / 2, sw, sw, 0, 0, n, n);
  x.strokeStyle = 'rgba(255,193,7,.9)'; x.lineWidth = 2; x.beginPath(); x.moveTo(n / 2 - 14, n / 2); x.lineTo(n / 2 + 14, n / 2); x.moveTo(n / 2, n / 2 - 14); x.lineTo(n / 2, n / 2 + 14); x.stroke();
  const px = rx / raw.width * b.width, py = ry / raw.height * b.height, d = L.getBoundingClientRect().width || 130;
  L.style.left = Math.max(0, Math.min(b.width - d, px - d / 2)) + 'px';
  L.style.top = (py - d - 50 >= 0 ? py - d - 50 : py + 50) + 'px'; L.hidden = false;
}
const clampPt = (p, raw) => [Math.max(0, Math.min(raw.width - 1, p[0])), Math.max(0, Math.min(raw.height - 1, p[1]))];
$$('#edBox .hd, #edBox .hm').forEach(el => {
  const edge = el.classList.contains('hm');
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId); el.dataset.drag = '1'; e.preventDefault();
    if (edge && SC.edit) el._o = { q: SC.edit.q.map(p => p.slice()), x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointermove', e => {
    if (!el.dataset.drag || !SC.edit) return;
    const b = $('#edBox').getBoundingClientRect(), raw = SC.edit.pg.raw, k = +el.dataset.k, q = SC.edit.q;
    if (edge) {   /* kéo cả cạnh: dời 2 đầu cùng một lượng (giới hạn để không ra ngoài ảnh) */
      const o = el._o; let dx = (e.clientX - o.x) / b.width * raw.width, dy = (e.clientY - o.y) / b.height * raw.height, n = (k + 1) % 4;
      for (const i of [k, n]) { dx = Math.max(-o.q[i][0], Math.min(raw.width - 1 - o.q[i][0], dx)); dy = Math.max(-o.q[i][1], Math.min(raw.height - 1 - o.q[i][1], dy)); }
      q[k] = [o.q[k][0] + dx, o.q[k][1] + dy]; q[n] = [o.q[n][0] + dx, o.q[n][1] + dy];
      loupe((q[k][0] + q[n][0]) / 2, (q[k][1] + q[n][1]) / 2, true);
    } else {
      q[k] = clampPt([(e.clientX - b.left) / b.width * raw.width, (e.clientY - b.top) / b.height * raw.height], raw);
      loupe(q[k][0], q[k][1], true);
    }
    paintEdit();
  });
  const up = () => { delete el.dataset.drag; loupe(0, 0, false); };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
});
window.addEventListener('resize', () => { if (SC.edit) fitEdit(); });

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
      const m = h.kind === 'file' && /^(photo|scan|gif|video|timelapse)-(\d{8}-\d{6}).*\.(jpe?g|gif|webm|mp4)$/i.exec(h.name);
      if (m && (!best || m[2] > best.ts)) best = h, best.ts = m[2];
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

const dlgLang = $('#dlgLang'), langList = $('#langList'), langQ = $('#langQ');
/* Danh sách ngôn ngữ kiểu Google: "Theo ngôn ngữ thiết bị" ở đầu, mỗi dòng có tên bản ngữ + tên tiếng Anh, gõ để lọc (không phân biệt hoa thường / dấu) */
function renderLangs() {
  const q = langQ.value.trim(), rows = q ? [] : [['auto', t('lang.auto'), '']];
  I18N.search(q).forEach(l => rows.push([l[0], l[1], l[1] === l[2] ? '' : l[2]]));
  langList.textContent = '';
  rows.forEach(([code, name, sub]) => {
    const li = document.createElement('md-list-item'); li.type = 'button'; li.dataset.lang = code;
    li.innerHTML = '<md-radio slot="start" name="lang" touch-target="wrapper"></md-radio><div slot="headline"></div><div slot="supporting-text"></div>';
    $('[slot=headline]', li).textContent = name; const sp = $('[slot=supporting-text]', li); sp.textContent = sub || (code === 'auto' ? I18N.list.filter(l => l[0] === I18N.lang).map(l => l[1])[0] : ''); if (!sp.textContent) sp.remove();
    $('md-radio', li).checked = code === I18N.pref;
    li.onclick = async () => { await I18N.set(code); renderLangs(); };
    langList.appendChild(li);
  });
  $('#langNone').hidden = rows.length > 0;
}
$('#miLang').onclick = () => { $('.lang-q').hidden = I18N.list.length <= 6; langQ.value = ''; renderLangs(); dlgLang.show(); };
langQ.addEventListener('input', renderLangs);
langQ.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { const f = $('md-list-item', langList); if (f) { e.preventDefault(); f.focus(); } } });
$('#btnLangDone').onclick = () => dlgLang.close();
document.addEventListener('i18n', () => { if (dlgLang.open) renderLangs(); buildKeys(); paintState(); paintIcons(); paintBadge(); dlPaint(); if (SC.open) paintScan(); });
$('#btnPickOk').onclick = () => $('#dlgPick').close();

/* ---------- Phím tắt ---------- */
const dlgKeys = $('#dlgKeys');
const KEYMAP = [
  ['sc.group_cam', [[['key.space', 'key.enter'], 'sc.shutter'], [['V', 'P', 'S'], 'sc.mode_keys'], [['↑', '↓'], 'sc.modes'], [['←', '→'], 'sc.submodes'], [['T'], 'sc.timer'], [['M'], 'sc.mirror'], [['G'], 'sc.grid'], [['F'], 'sc.filters'], [['C'], 'sc.switch'], [['A'], 'sc.mic'], [['O'], 'sc.gallery'], [['key.esc'], 'sc.cancel']]],
  ['sc.group_review', [[['key.enter'], 'sc.save_photo'], [['D'], 'sc.save_pdf'], [['E'], 'sc.edit'], [['N'], 'sc.add'], [['key.del'], 'sc.delete'], [['←', '→'], 'sc.pages'], [['key.esc'], 'sc.cancel']]],
  ['sc.group_edit', [[['key.enter'], 'sc.done'], [['A'], 'sc.auto'], [['key.esc'], 'sc.cancel']]],
  ['sc.group_general', [[['?'], 'sc.help']]]
];
function buildKeys() {
  const b = $('#keysBody'); b.textContent = '';
  KEYMAP.forEach(([g, rows]) => {
    const h = document.createElement('h3'); h.textContent = t(g); b.appendChild(h);
    rows.forEach(([ks, d]) => {
      const r = document.createElement('div'); r.className = 'row'; const s = document.createElement('span'); s.textContent = t(d);
      const k = document.createElement('span'); k.className = 'keys'; ks.forEach(x => { const e = document.createElement('kbd'); e.textContent = x.startsWith('key.') ? t(x) : x; k.appendChild(e); });
      r.append(s, k); b.appendChild(r);
    });
  });
  const n = document.createElement('p'); n.className = 'note'; n.textContent = t('sc.note'); b.appendChild(n);
}
$('#miKeys').onclick = () => { buildKeys(); dlgKeys.show(); };
$('#btnKeysDone').onclick = () => dlgKeys.close();
const clickIf = id => { const el = $(id); if (el && !el.hidden && !el.disabled) el.click(); return !!el; };
/* Bắt ở pha capture trên window: chạy trước mọi nút / thành phần, nên dấu cách / Enter không còn "bấm" nhầm nút đang focus (vd nút xoá). Phím nhả (keyup) cũng bị chặn vì nút kích hoạt bằng Space khi nhả phím */
const hotkeys = new Set();
function hotkeyBlocked(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return true;
  if (document.querySelector('md-dialog[open]') || (!$('#gs').hidden) || menu.open) return true;
  const el = e.composedPath ? e.composedPath()[0] : e.target;
  return !!(el && (el.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(button|checkbox|radio|range|submit)$/.test(el.type || ''))));
}
function hotkey(e) {
  /* Chữ cái theo vị trí phím (e.code) để dùng được cả khi bàn phím đang là Nga, Nhật, Thái... */
  const k = /^Key[A-Z]$/.test(e.code) ? e.code[3].toLowerCase() : e.key.length === 1 ? e.key.toLowerCase() : e.key, ed = !!SC.edit, rv = SC.open && !ed;
  if (k === '?' || (k === '/' && e.shiftKey)) { buildKeys(); dlgKeys.show(); return true; }
  if (ed) {
    if (k === 'Enter') return clickIf('#svEdDone'); if (k === 'Escape') return clickIf('#svEdCancel'); if (k === 'a') return clickIf('#svEdAuto');
    return k === ' ';
  }
  if (rv) {
    if (k === 'Enter') return clickIf('#svPhoto'); if (k === 'd') return clickIf('#svPdf'); if (k === 'e') return clickIf('#svEditBtn'); if (k === 'n') return clickIf('#svAdd');
    if (k === 'Delete' || k === 'Backspace') return clickIf('#svDel'); if (k === 'Escape') return clickIf('#svCancel');
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && SC.pages.length > 1) { SC.cur = (SC.cur + (k === 'ArrowRight' ? 1 : -1) + SC.pages.length) % SC.pages.length; paintScan(); return true; }
    return k === ' ';
  }
  if (k === ' ' || k === 'Enter') { shutter(); return true; }
  if (k === 'Escape') { if (S.counting) { S.counting.cancel(); return true; } return false; }
  if (S.rec || S.counting) return false;   /* đang quay / đếm ngược: chỉ chụp / dừng / Esc */
  const modes = ['video', 'photo', 'scan'], mi = modes.indexOf(S.mode);
  if (k === 'v' || k === 'p' || k === 's') return clickIf(`.mode[data-mode=${{ v: 'video', p: 'photo', s: 'scan' }[k]}]`);
  if (k === 'ArrowUp' || k === 'ArrowDown') return clickIf(`.mode[data-mode=${modes[(mi + (k === 'ArrowDown' ? 1 : -1) + 3) % 3]}]`);
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    const bs = $$(`#subModes .sub[data-for=${S.mode}] button`); if (!bs.length) return false;
    const cur = bs.findIndex(b => b.dataset.sub === S.sub[S.mode]); bs[(cur + (k === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length].click(); return true;
  }
  const map = { t: '#btnTimer', m: '#btnMirror', g: '#btnGrid', f: '#btnFilter', c: '#btnSwitch', a: '#btnMic', o: '#thumb' };
  return map[k] ? clickIf(map[k]) : false;
}
window.addEventListener('keydown', e => {
  if (hotkeyBlocked(e)) return;
  if (e.repeat && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (hotkey(e)) { hotkeys.add(e.key); e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
window.addEventListener('keyup', e => {
  if (hotkeys.delete(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);

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
  const picked = e.data.dirs || [];
  for (const h of picked) { try { await addFolderHandle(h); } catch (err) { /* bỏ qua */ } }
  if (picked.length > 1) await askFolder(t('pick.multi'), activeId());   /* chọn nhiều thư mục → hỏi lưu ảnh vào cái nào */
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
  scanSync();
  await sleep(Math.max(0, 900 - (performance.now() - t0)));
  $('#splash').classList.add('out');
  const first = store.get('camera.gsPending') === '1' || (store.get('camera.gsDone') !== '1' && !FOLDERS.length);
  if (first) openGettingStarted(); else { if (FOLDERS.length) store.set('camera.gsDone', '1'); syncFolders(); }
})();
