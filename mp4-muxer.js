/* =========================================================
   MP4 Muxer & Metadata Injector (ISO BMFF / QTFF)
   - Đóng gói stream từ MediaRecorder (MP4 / WebM) sang chuẩn MP4 (ftyp + moov + mdat)
   - Gắn đầy đủ metadata chuẩn QuickTime / iTunes / ISO BMFF:
     • mvhd / tkhd / mdhd: creation_time, modification_time (kỷ nguyên Mac 1904)
     • udta -> meta (ilst): ©nam (Tiêu đề), ©day (Ngày quay ISO-8601), ©too (Camera PWA / Encoder),
       ©cmt (Ghi chú chế độ, bộ lọc, độ phân giải, FPS), ©mak (Hãng thiết bị), ©mod (Tên thiết bị/trình duyệt)
     • udta -> ©xyz (Tọa độ GPS chuẩn ISO 6709 nếu có)
   ========================================================= */
(function (global) {
  'use strict';

  const enc = new TextEncoder();
  const MAC_EPOCH_OFFSET = 2082844800; // giây từ 1904-01-01 đến 1970-01-01

  function u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, false);
    return b;
  }
  function u64(v) {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, Math.floor(v / 0x100000000) >>> 0, false);
    dv.setUint32(4, v >>> 0, false);
    return b;
  }
  function str4(s) {
    return new Uint8Array([s.charCodeAt(0) & 255, s.charCodeAt(1) & 255, s.charCodeAt(2) & 255, s.charCodeAt(3) & 255]);
  }
  function concat(...parts) {
    let len = 0;
    for (const p of parts) len += p.byteLength;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
      out.set(p instanceof Uint8Array ? p : new Uint8Array(p), off);
      off += p.byteLength;
    }
    return out;
  }
  function box(type, ...payloads) {
    const body = concat(...payloads);
    return concat(u32(8 + body.byteLength), str4(type), body);
  }
  function fullBox(type, version, flags, ...payloads) {
    const vf = new Uint8Array([version & 255, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255]);
    return box(type, vf, ...payloads);
  }

  /* Duyệt các box cấp 1 hoặc con trong buffer ISO BMFF */
  function parseBoxes(buf, start = 0, end = buf.byteLength) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const list = [];
    let off = start;
    while (off + 8 <= end) {
      let size = dv.getUint32(off, false);
      const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
      let hdr = 8;
      if (size === 1) {
        if (off + 16 > end) break;
        const hi = dv.getUint32(off + 8, false), lo = dv.getUint32(off + 12, false);
        size = hi * 0x100000000 + lo;
        hdr = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < hdr || off + size > end) break;
      list.push({ type, start: off, hdr, size, end: off + size });
      off += size;
    }
    return list;
  }

  /* Cập nhật creation_time & modification_time trong mvhd, tkhd, mdhd */
  function patchHeaderTimes(moovBuf, macSec) {
    const out = new Uint8Array(moovBuf);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    function walk(s, e) {
      for (const b of parseBoxes(out, s, e)) {
        if (b.type === 'mvhd' || b.type === 'tkhd' || b.type === 'mdhd') {
          const ver = out[b.start + b.hdr];
          const tOff = b.start + b.hdr + 4;
          if (ver === 0 && tOff + 8 <= b.end) {
            dv.setUint32(tOff, macSec >>> 0, false);
            dv.setUint32(tOff + 4, macSec >>> 0, false);
          } else if (ver === 1 && tOff + 16 <= b.end) {
            const hi = Math.floor(macSec / 0x100000000) >>> 0, lo = macSec >>> 0;
            dv.setUint32(tOff, hi, false); dv.setUint32(tOff + 4, lo, false);
            dv.setUint32(tOff + 8, hi, false); dv.setUint32(tOff + 12, lo, false);
          }
        } else if (b.type === 'trak' || b.type === 'mdia') {
          walk(b.start + b.hdr, b.end);
        }
      }
    }
    walk(8, out.byteLength);
    return out;
  }

  /* Dịch offset trong stco / co64 khi kích thước phần đầu (trước mdat) thay đổi */
  function shiftChunkOffsets(moovBuf, delta) {
    if (!delta) return moovBuf;
    const out = new Uint8Array(moovBuf);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    function walk(s, e) {
      for (const b of parseBoxes(out, s, e)) {
        if (b.type === 'stco') {
          const count = dv.getUint32(b.start + b.hdr + 4, false);
          let p = b.start + b.hdr + 8;
          for (let i = 0; i < count && p + 4 <= b.end; i++, p += 4) {
            dv.setUint32(p, (dv.getUint32(p, false) + delta) >>> 0, false);
          }
        } else if (b.type === 'co64') {
          const count = dv.getUint32(b.start + b.hdr + 4, false);
          let p = b.start + b.hdr + 8;
          for (let i = 0; i < count && p + 8 <= b.end; i++, p += 8) {
            const val = dv.getUint32(p, false) * 0x100000000 + dv.getUint32(p + 4, false) + delta;
            dv.setUint32(p, Math.floor(val / 0x100000000) >>> 0, false);
            dv.setUint32(p + 4, val >>> 0, false);
          }
        } else if (['trak', 'mdia', 'minf', 'stbl'].includes(b.type)) {
          walk(b.start + b.hdr, b.end);
        }
      }
    }
    walk(8, out.byteLength);
    return out;
  }

  /* Tạo atom ilst item kiểu Apple/QuickTime UTF-8: [4-byte tag] -> data(type=1, locale=0, utf8) */
  function ilstTextItem(fourcc, text) {
    if (!text) return new Uint8Array(0);
    const dataBox = fullBox('data', 0, 1, u32(0), enc.encode(String(text)));
    const raw = new Uint8Array(4 + dataBox.byteLength);
    raw[0] = fourcc.charCodeAt(0) & 255;
    raw[1] = fourcc.charCodeAt(1) & 255;
    raw[2] = fourcc.charCodeAt(2) & 255;
    raw[3] = fourcc.charCodeAt(3) & 255;
    raw.set(dataBox, 4);
    return concat(u32(8 + raw.byteLength), raw);
  }

  /* Tạo box udta chứa meta (hdlr 'mdir'/'appl' + ilst) và ©xyz (nếu có GPS) */
  function buildUdta(meta) {
    const hdlr = fullBox('hdlr', 0, 0,
      u32(0),
      str4('mdir'),
      str4('appl'),
      u32(0), u32(0),
      new Uint8Array([0])
    );
    const items = [
      ilstTextItem('\u00A9nam', meta.title),
      ilstTextItem('\u00A9day', meta.creationDate),
      ilstTextItem('\u00A9too', meta.software),
      ilstTextItem('\u00A9cmt', meta.comment),
      ilstTextItem('\u00A9mak', meta.make),
      ilstTextItem('\u00A9mod', meta.model),
      ilstTextItem('\u00A9alb', meta.album),
      ilstTextItem('desc', meta.description)
    ];
    const ilst = box('ilst', ...items);
    const metaBox = fullBox('meta', 0, 0, hdlr, ilst);

    const udtaChildren = [metaBox];
    if (meta.location) {
      // QuickTime ©xyz box: 2-byte string length + 2-byte language (0x15C7 = 'und') + ISO 6709 string
      const locBytes = enc.encode(meta.location);
      const xyzPayload = new Uint8Array(4 + locBytes.byteLength);
      const dv = new DataView(xyzPayload.buffer);
      dv.setUint16(0, locBytes.byteLength, false);
      dv.setUint16(2, 0x15C7, false);
      xyzPayload.set(locBytes, 4);
      udtaChildren.push(concat(u32(8 + xyzPayload.byteLength), new Uint8Array([0xA9, 0x78, 0x79, 0x7A]), xyzPayload));
    }
    return box('udta', ...udtaChildren);
  }

  /* Phân tích thông tin thiết bị & trình duyệt */
  function detectDeviceInfo() {
    const ua = navigator.userAgent || '';
    let make = 'Web Browser', model = 'Camera PWA';
    if (/CrOS/.test(ua)) { make = 'Google'; model = 'ChromeOS Camera PWA'; }
    else if (/Android/.test(ua)) {
      const m = ua.match(/;\s*([^;)]+)\s+Build\//);
      model = m ? m[1].trim() : 'Android Device';
      make = /^OPPO|CPH/i.test(model) ? 'OPPO' : (/^SM-|Samsung/i.test(model) ? 'Samsung' : (/Pixel/i.test(model) ? 'Google' : 'Android'));
    } else if (/iPhone|iPad/.test(ua)) { make = 'Apple'; model = /iPad/.test(ua) ? 'iPad' : 'iPhone'; }
    else if (/Windows/.test(ua)) { make = 'Microsoft'; model = 'Windows PC'; }
    else if (/Mac OS X/.test(ua)) { make = 'Apple'; model = 'Mac'; }
    return { make, model };
  }

  /* Đóng gói lại MP4 (hoặc WebM fallback sang MP4 container) với đầy đủ metadata */
  async function finalizeMp4(blob, opts = {}) {
    const now = opts.date || new Date();
    const macSec = Math.floor(now.getTime() / 1000) + MAC_EPOCH_OFFSET;
    const dev = detectDeviceInfo();
    const meta = {
      title: opts.title || `Video ${now.toISOString().slice(0, 19).replace('T', ' ')}`,
      creationDate: now.toISOString(),
      software: opts.software || 'Camera PWA (Tuanphong3108/camera)',
      album: 'Camera',
      make: opts.make || dev.make,
      model: opts.model || dev.model,
      comment: opts.comment || '',
      description: opts.description || opts.comment || '',
      location: opts.location || ''
    };

    const ab = await blob.arrayBuffer();
    const src = new Uint8Array(ab);
    const top = parseBoxes(src);

    // Trường hợp MediaRecorder đã xuất MP4 (ISO BMFF có ftyp + moov + mdat)
    const ftypBox = top.find(b => b.type === 'ftyp');
    const moovBox = top.find(b => b.type === 'moov');
    const mdatBoxes = top.filter(b => b.type === 'mdat');

    if (moovBox && mdatBoxes.length) {
      // Chuẩn hóa ftyp thành mp42 / isom tương thích mọi trình phát & Photos
      const cleanFtyp = box('ftyp',
        str4('mp42'), u32(0),
        str4('mp42'), str4('isom'), str4('avc1'), str4('mp41')
      );

      // Lọc bỏ udta cũ bên trong moov nếu có, gắn udta mới với đầy đủ metadata
      const moovInner = parseBoxes(src, moovBox.start + moovBox.hdr, moovBox.end)
        .filter(b => b.type !== 'udta')
        .map(b => src.slice(b.start, b.end));
      const udta = buildUdta(meta);
      let newMoov = box('moov', ...moovInner, udta);
      newMoov = patchHeaderTimes(newMoov, macSec);

      // Gom tất cả mdat (nếu MediaRecorder ghi fragmented MP4 có nhiều moof+mdat)
      const hasMoof = top.some(b => b.type === 'moof');
      if (!hasMoof) {
        const mdatSlice = src.slice(mdatBoxes[0].start, mdatBoxes[0].end);
        const oldDataOffset = mdatBoxes[0].start + mdatBoxes[0].hdr;
        const newDataOffset = cleanFtyp.byteLength + newMoov.byteLength + mdatBoxes[0].hdr;
        newMoov = shiftChunkOffsets(newMoov, newDataOffset - oldDataOffset);
        return new Blob([cleanFtyp, newMoov, mdatSlice], { type: 'video/mp4' });
      } else {
        // Fragmented MP4 (moof + mdat): giữ nguyên chuỗi fragment sau ftyp + moov (trf dùng base-data-offset-present=0 hoặc relative)
        const rest = [];
        for (const b of top) {
          if (b.type === 'ftyp' || b.type === 'moov' || b.type === 'free' || b.type === 'skip') continue;
          rest.push(src.slice(b.start, b.end));
        }
        return new Blob([cleanFtyp, newMoov, ...rest], { type: 'video/mp4' });
      }
    }

    // Fallback: nếu trình duyệt cũ không hỗ trợ ghi MP4 trực tiếp mà trả WebM,
    // đóng gói lại bằng Canvas + WebCodecs (VideoEncoder H.264 + AAC/raw) thành MP4 chuẩn
    return await transcodeWebmToMp4(blob, meta, macSec);
  }

  /* Chuyển đổi WebM sang MP4 chuẩn bằng WebCodecs VideoEncoder (AVC/H.264) + MP4 Muxer tự viết */
  async function transcodeWebmToMp4(webmBlob, meta, macSec) {
    if (!('VideoEncoder' in window)) {
      // Trình duyệt quá cũ không có cả MediaRecorder MP4 lẫn WebCodecs: trả về nguyên bản với mime mp4
      return new Blob([webmBlob], { type: 'video/mp4' });
    }
    const url = URL.createObjectURL(webmBlob);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.src = url;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej; });
    const w = (v.videoWidth || 1280) & ~1;
    const h = (v.videoHeight || 720) & ~1;
    const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
    const fps = 30;
    const totalFrames = Math.max(1, Math.round(dur * fps));

    const encodedChunks = [];
    let avcC = null;
    const encoder = new VideoEncoder({
      output: (chunk, metaOut) => {
        if (metaOut && metaOut.decoderConfig && metaOut.decoderConfig.description && !avcC) {
          avcC = new Uint8Array(metaOut.decoderConfig.description);
        }
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        encodedChunks.push({ data: buf, key: chunk.type === 'key', ts: chunk.timestamp, dur: chunk.duration || Math.round(1e6 / fps) });
      },
      error: e => console.error('VideoEncoder:', e)
    });

    const codecs = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f'];
    let chosenCodec = codecs[2];
    for (const c of codecs) {
      const sup = await VideoEncoder.isConfigSupported({ codec: c, width: w, height: h, bitrate: 4_000_000, framerate: fps });
      if (sup.supported) { chosenCodec = c; break; }
    }
    encoder.configure({ codec: chosenCodec, width: w, height: h, bitrate: 4_000_000, framerate: fps });

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < totalFrames; i++) {
      v.currentTime = Math.min(dur, i / fps);
      await new Promise(r => { v.onseeked = r; setTimeout(r, 80); });
      ctx.drawImage(v, 0, 0, w, h);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % fps === 0 });
      frame.close();
    }
    await encoder.flush();
    encoder.close();
    URL.revokeObjectURL(url);

    if (!encodedChunks.length) return new Blob([webmBlob], { type: 'video/mp4' });
    return buildSimpleAvcMp4(encodedChunks, avcC, w, h, fps, meta, macSec);
  }

  /* Dựng file MP4 hoàn chỉnh từ các NAL chunk H.264 + avcC + metadata */
  function buildSimpleAvcMp4(chunks, avcC, w, h, fps, meta, macSec) {
    const timescale = 90000;
    const sampleDur = Math.round(timescale / fps);
    const totalDur = chunks.length * sampleDur;

    const mdatBody = concat(...chunks.map(c => c.data));
    const ftyp = box('ftyp', str4('mp42'), u32(0), str4('mp42'), str4('isom'), str4('avc1'));

    const mvhd = fullBox('mvhd', 0, 0,
      u32(macSec), u32(macSec), u32(timescale), u32(totalDur),
      u32(0x00010000), new Uint8Array([0x01, 0x00]), new Uint8Array(10),
      u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
      new Uint8Array(24), u32(2)
    );

    const tkhd = fullBox('tkhd', 0, 3,
      u32(macSec), u32(macSec), u32(1), u32(0), u32(totalDur),
      new Uint8Array(8), new Uint8Array(4), new Uint8Array([0x01, 0x00, 0, 0]),
      u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
      u32(w << 16), u32(h << 16)
    );

    const mdhd = fullBox('mdhd', 0, 0, u32(macSec), u32(macSec), u32(timescale), u32(totalDur), new Uint8Array([0x55, 0xC4, 0, 0]));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), str4('vide'), u32(0), u32(0), u32(0), enc.encode('VideoHandler\0'));
    const vmhd = fullBox('vmhd', 0, 1, new Uint8Array(8));
    const urlBox = fullBox('url ', 0, 1);
    const dref = fullBox('dref', 0, 0, u32(1), urlBox);
    const dinf = box('dinf', dref);

    const avcCBox = avcC ? box('avcC', avcC) : box('avcC', new Uint8Array([1, 0x42, 0, 0x1f, 0xff, 0xe1, 0, 0, 0]));
    const compressor = new Uint8Array(32);
    const cname = enc.encode('Camera PWA AVC');
    compressor[0] = cname.length;
    compressor.set(cname, 1);

    const avc1 = box('avc1',
      new Uint8Array(6), new Uint8Array([0, 1]),
      new Uint8Array(16),
      new Uint8Array([(w >> 8) & 255, w & 255, (h >> 8) & 255, h & 255]),
      u32(0x00480000), u32(0x00480000), u32(0), new Uint8Array([0, 1]),
      compressor,
      new Uint8Array([0, 0x18, 0xff, 0xff]),
      avcCBox
    );
    const stsd = fullBox('stsd', 0, 0, u32(1), avc1);
    const stts = fullBox('stts', 0, 0, u32(1), u32(chunks.length), u32(sampleDur));
    const syncIdx = [];
    chunks.forEach((c, i) => { if (c.key) syncIdx.push(u32(i + 1)); });
    const stss = fullBox('stss', 0, 0, u32(syncIdx.length), ...syncIdx);
    const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(chunks.length), u32(1));
    const stsz = fullBox('stsz', 0, 0, u32(0), u32(chunks.length), ...chunks.map(c => u32(c.data.byteLength)));
    const stco = fullBox('stco', 0, 0, u32(1), u32(0)); // placeholder offset

    const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const minf = box('minf', vmhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', tkhd, mdia);
    const udta = buildUdta(meta);
    let moov = box('moov', mvhd, trak, udta);

    const mdatOffset = ftyp.byteLength + moov.byteLength + 8;
    moov = shiftChunkOffsets(moov, mdatOffset);
    const mdat = box('mdat', mdatBody);
    return new Blob([ftyp, moov, mdat], { type: 'video/mp4' });
  }

  global.Mp4Muxer = { finalizeMp4 };
})(window);
