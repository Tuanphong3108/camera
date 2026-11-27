/* =========================================================
   MP4 Muxer + Metadata Writer (ISO BMFF, H.264 + AAC / Opus)
   - Đóng gói video WebCodecs (VideoEncoder + AudioEncoder) thành .mp4 chuẩn
     với moov ở đầu tệp (fast-start), seektable (stss), thời lượng chính xác,
     và nhúng đủ metadata: mvhd/tkhd/mdhd timestamps, ©nam, ©day, ©too, ©cmt,
     ©ART, ©mak, ©mod, ©swr, desc, XMP (dc:title, dc:creator, xmp:CreateDate,
     xmp:CreatorTool, tiff:Make, tiff:Model, exif:DateTimeOriginal...)
   - Tự phát hiện bộ mã hóa MP4 khả dụng:
       1. WebCodecs (H.264 AVC + AAC/Opus) → MP4 chuẩn + đủ metadata (ưu tiên số 1)
       2. MediaRecorder hỗ trợ video/mp4 → tiêm trực tiếp box udta/meta/XMP vào MP4
       3. Fallback cuối cùng: WebM nếu trình duyệt quá cũ không hỗ trợ H.264
   ========================================================= */
(function (global) {
  'use strict';

  const TE = new TextEncoder();
  const MAC_EPOCH_OFFSET = 2082844800; // giây từ 1904-01-01 đến 1970-01-01

  const u8 = n => new Uint8Array([n & 0xff]);
  const u16 = n => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n >>> 0); return b; };
  const u24 = n => new Uint8Array([(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
  const u64 = n => {
    const b = new Uint8Array(8), dv = new DataView(b.buffer);
    dv.setUint32(0, Math.floor(n / 4294967296) >>> 0);
    dv.setUint32(4, n >>> 0);
    return b;
  };
  const fourcc = s => new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);

  function concat(...parts) {
    const flat = [];
    for (const p of parts) {
      if (!p) continue;
      if (Array.isArray(p)) for (const x of p) { if (x && x.byteLength) flat.push(x); }
      else if (p.byteLength) flat.push(p);
    }
    let len = 0;
    for (const p of flat) len += p.byteLength;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of flat) { out.set(p, off); off += p.byteLength; }
    return out;
  }

  function box(type, ...children) {
    const body = concat(...children);
    return concat(u32(8 + body.byteLength), fourcc(type), body);
  }

  function fullBox(type, version, flags, ...children) {
    return box(type, u8(version), u24(flags), ...children);
  }

  const UNITY_MATRIX = new Uint8Array([
    0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 64, 0, 0, 0
  ]);

  /* Chuyển Annex-B (00 00 00 01 / 00 00 01) sang AVCC (4-byte length prefix) */
  function annexBToAvcc(data) {
    const src = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Kiểm tra xem đã là AVCC chưa (nếu byte đầu không phải start code 0x000001 / 0x00000001)
    let isAnnexB = false;
    if (src.length >= 4 && src[0] === 0 && src[1] === 0 && (src[2] === 1 || (src[2] === 0 && src[3] === 1))) {
      isAnnexB = true;
    }
    if (!isAnnexB) return src;

    const nalus = [];
    let i = 0, start = -1;
    while (i < src.length) {
      if (i + 3 < src.length && src[i] === 0 && src[i + 1] === 0 && src[i + 2] === 0 && src[i + 3] === 1) {
        if (start >= 0) nalus.push(src.subarray(start, i));
        i += 4; start = i;
      } else if (i + 2 < src.length && src[i] === 0 && src[i + 1] === 0 && src[i + 2] === 1) {
        if (start >= 0) nalus.push(src.subarray(start, i));
        i += 3; start = i;
      } else {
        i++;
      }
    }
    if (start >= 0 && start <= src.length) nalus.push(src.subarray(start));
    if (!nalus.length) return src;
    return concat(nalus.map(n => concat(u32(n.byteLength), n)));
  }

  /* Tách SPS & PPS từ Annex-B hoặc avcC description */
  function extractSpsPps(descOrChunk) {
    const src = new Uint8Array(descOrChunk);
    // Nếu là avcC record (byte 0 === 1)
    if (src.length > 7 && src[0] === 1) {
      return src;
    }
    const nalus = [];
    let i = 0, start = -1;
    while (i < src.length) {
      if (i + 3 < src.length && src[i] === 0 && src[i + 1] === 0 && src[i + 2] === 0 && src[i + 3] === 1) {
        if (start >= 0) nalus.push(src.subarray(start, i));
        i += 4; start = i;
      } else if (i + 2 < src.length && src[i] === 0 && src[i + 1] === 0 && src[i + 2] === 1) {
        if (start >= 0) nalus.push(src.subarray(start, i));
        i += 3; start = i;
      } else i++;
    }
    if (start >= 0) nalus.push(src.subarray(start));
    let sps = null, pps = null;
    for (const n of nalus) {
      const t = n[0] & 0x1f;
      if (t === 7 && !sps) sps = n;
      else if (t === 8 && !pps) pps = n;
    }
    if (!sps || !pps) return null;
    return concat(
      u8(1), u8(sps[1] || 0x42), u8(sps[2] || 0xc0), u8(sps[3] || 0x1e),
      u8(0xff), u8(0xe1), u16(sps.byteLength), sps,
      u8(1), u16(pps.byteLength), pps
    );
  }

  /* Tạo AudioSpecificConfig cho AAC-LC (2 bytes) */
  function makeAacAsc(sampleRate, channels) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    let idx = rates.indexOf(sampleRate);
    if (idx < 0) idx = 4; // 44100
    const objType = 2; // AAC-LC
    const b0 = (objType << 3) | (idx >> 1);
    const b1 = ((idx & 1) << 7) | ((channels & 0x0f) << 3);
    return new Uint8Array([b0, b1]);
  }

  /* Xây dựng XMP XML chuẩn chứa đầy đủ thông tin thiết bị, tác giả, thời gian, thông số quay */
  function buildXmpXml(meta) {
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const iso = meta.createDateISO || new Date().toISOString();
    return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/">
   <xmp:CreateDate>${esc(iso)}</xmp:CreateDate>
   <xmp:ModifyDate>${esc(iso)}</xmp:ModifyDate>
   <xmp:CreatorTool>${esc(meta.software)}</xmp:CreatorTool>
   <tiff:Make>${esc(meta.make)}</tiff:Make>
   <tiff:Model>${esc(meta.model)}</tiff:Model>
   <exif:DateTimeOriginal>${esc(iso)}</exif:DateTimeOriginal>
   <exif:PixelXDimension>${meta.width || 0}</exif:PixelXDimension>
   <exif:PixelYDimension>${meta.height || 0}</exif:PixelYDimension>
   <xmpDM:videoFrameRate>${meta.fps || 30}</xmpDM:videoFrameRate>
   <xmpDM:cameraModel>${esc(meta.cameraLabel || meta.model)}</xmpDM:cameraModel>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(meta.title)}</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(meta.comment)}</rdf:li></rdf:Alt></dc:description>
   <dc:creator><rdf:Seq><rdf:li>${esc(meta.artist)}</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  }

  /* Xây dựng box `udta` chứa iTunes/QuickTime `meta` (©nam, ©day, ©too, ©cmt, ©ART, ©mak, ©mod, ©swr, desc) + box `XMP_` */
  function buildMetadataBoxes(meta) {
    const items = [];
    const keys = [];
    const entries = [
      ['\xA9nam', 'com.apple.quicktime.title', meta.title],
      ['\xA9day', 'com.apple.quicktime.creationdate', meta.createDateISO],
      ['\xA9too', 'com.apple.quicktime.software', meta.software],
      ['\xA9cmt', 'com.apple.quicktime.description', meta.comment],
      ['\xA9ART', 'com.apple.quicktime.author', meta.artist],
      ['\xA9mak', 'com.apple.quicktime.make', meta.make],
      ['\xA9mod', 'com.apple.quicktime.model', meta.model],
      ['\xA9swr', null, meta.software],
      ['desc', null, meta.comment]
    ].filter(x => x[2]);

    // 1) Classic 3GPP / QuickTime udta atoms (đọc được bởi Windows Explorer, VLC, FFmpeg, Photos, Android)
    const classicAtoms = [];
    const langCode = u16(0x55c4); // 'und'
    for (const [atom, , val] of entries) {
      const txt = TE.encode(String(val));
      classicAtoms.push(box(atom, u16(txt.byteLength), langCode, txt));
    }

    // 2) Apple / ISO iTunes-style ilst inside meta (đọc được bởi macOS, iOS, QuickTime, MediaInfo)
    entries.forEach(([atom, , val], i) => {
      const txt = TE.encode(String(val));
      const dataBox = fullBox('data', 0, 1, u32(0), txt); // type 1 = UTF-8
      items.push(box(atom, dataBox));
      keys.push(i);
    });
    const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc('mdir'), fourcc('appl'), u32(0), u32(0), u8(0));
    const ilst = box('ilst', items);
    const metaBox = fullBox('meta', 0, 0, hdlr, ilst);

    // 3) Box XMP_ trong udta (chuẩn Adobe / Google Photos / ExifTool)
    const xmpBytes = TE.encode(buildXmpXml(meta));
    const xmpBox = box('XMP_', xmpBytes);

    // 4) UUID XMP top-level box (BE7ACFCB-97A9-42E8-9C71-999491E3AFAC)
    const xmpUuid = new Uint8Array([
      0xBE, 0x7A, 0xCF, 0xCB, 0x97, 0xA9, 0x42, 0xE8,
      0x9C, 0x71, 0x99, 0x94, 0x91, 0xE3, 0xAF, 0xAC
    ]);
    const uuidBox = box('uuid', xmpUuid, xmpBytes);

    const udta = box('udta', classicAtoms, metaBox, xmpBox);
    return { udta, uuidBox };
  }

  /* Tiêm metadata vào file MP4 có sẵn (từ MediaRecorder) bằng cách chèn udta + uuid XMP vào moov và cập nhật stco/co64 */
  function injectMetadataIntoMp4(mp4Buffer, meta) {
    const src = new Uint8Array(mp4Buffer);
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);

    function parseBoxes(start, end) {
      const list = [];
      let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p);
        const type = String.fromCharCode(src[p + 4], src[p + 5], src[p + 6], src[p + 7]);
        let hdr = 8;
        if (size === 1) {
          if (p + 16 > end) break;
          size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12);
          hdr = 16;
        } else if (size === 0) {
          size = end - p;
        }
        if (size < hdr || p + size > end) break;
        list.push({ type, start: p, hdr, end: p + size, size });
        p += size;
      }
      return list;
    }

    const top = parseBoxes(0, src.byteLength);
    const moov = top.find(b => b.type === 'moov');
    const mdat = top.find(b => b.type === 'mdat');
    if (!moov || !mdat) return src;

    const { udta, uuidBox } = buildMetadataBoxes(meta);
    const extra = concat(udta, uuidBox);
    const delta = extra.byteLength;
    const moovBeforeMdat = moov.start < mdat.start;

    // Bản sao moov có chèn udta + uuidBox ở cuối moov
    const moovChildren = parseBoxes(moov.start + moov.hdr, moov.end).filter(b => b.type !== 'udta');
    const keptChildrenBytes = concat(moovChildren.map(b => src.subarray(b.start, b.end)));
    const removedUdtaLen = (moov.end - (moov.start + moov.hdr)) - keptChildrenBytes.byteLength;
    const netDelta = delta - removedUdtaLen;

    const newMoovBody = concat(keptChildrenBytes, extra);
    const newMoov = box('moov', newMoovBody);

    // Nếu moov nằm trước mdat thì offset của mdat dịch chuyển đúng bằng netDelta → cập nhật stco / co64 trong newMoov
    if (moovBeforeMdat && netDelta !== 0) {
      const ndv = new DataView(newMoov.buffer, newMoov.byteOffset, newMoov.byteLength);
      (function patchOffsets(s, e) {
        let p = s;
        while (p + 8 <= e) {
          let sz = ndv.getUint32(p);
          const tp = String.fromCharCode(newMoov[p + 4], newMoov[p + 5], newMoov[p + 6], newMoov[p + 7]);
          let h = 8;
          if (sz === 1) { sz = ndv.getUint32(p + 8) * 4294967296 + ndv.getUint32(p + 12); h = 16; }
          if (sz < h || p + sz > e) break;
          if (tp === 'stco') {
            const count = ndv.getUint32(p + 12);
            for (let i = 0; i < count; i++) {
              const off = p + 16 + i * 4;
              ndv.setUint32(off, (ndv.getUint32(off) + netDelta) >>> 0);
            }
          } else if (tp === 'co64') {
            const count = ndv.getUint32(p + 12);
            for (let i = 0; i < count; i++) {
              const off = p + 16 + i * 8;
              const cur = ndv.getUint32(off) * 4294967296 + ndv.getUint32(off + 4) + netDelta;
              ndv.setUint32(off, Math.floor(cur / 4294967296) >>> 0);
              ndv.setUint32(off + 4, cur >>> 0);
            }
          } else if (['trak', 'mdia', 'minf', 'stbl', 'edts'].includes(tp)) {
            patchOffsets(p + h, p + sz);
          }
          p += sz;
        }
      })(8, newMoov.byteLength);
    }

    const before = src.subarray(0, moov.start);
    const after = src.subarray(moov.end);
    return concat(before, newMoov, after);
  }

  /* =========================================================
     Trình đóng gói MP4 hoàn chỉnh từ WebCodecs (H.264 + AAC)
     ========================================================= */
  class Mp4Muxer {
    constructor(opts) {
      this.width = opts.width;
      this.height = opts.height;
      this.fps = opts.fps || 30;
      this.hasAudio = !!opts.hasAudio;
      this.sampleRate = opts.sampleRate || 48000;
      this.channels = opts.channels || 1;
      this.meta = opts.meta || {};

      this.vSamples = []; // { data: Uint8Array, ptsUs, durUs, key }
      this.aSamples = []; // { data: Uint8Array, ptsUs, durUs }
      this.avcC = null;
      this.asc = this.hasAudio ? makeAacAsc(this.sampleRate, this.channels) : null;
    }

    setVideoDescription(desc) {
      const parsed = extractSpsPps(desc);
      if (parsed) this.avcC = parsed;
    }

    setAudioDescription(desc) {
      if (desc && desc.byteLength >= 2) this.asc = new Uint8Array(desc);
    }

    addVideo(rawBytes, timestampUs, durationUs, isKey) {
      if (!this.avcC) {
        const maybe = extractSpsPps(rawBytes);
        if (maybe) this.avcC = maybe;
      }
      const data = annexBToAvcc(rawBytes);
      this.vSamples.push({
        data,
        ptsUs: Math.max(0, Math.round(timestampUs || 0)),
        durUs: Math.max(1, Math.round(durationUs || (1e6 / this.fps))),
        key: !!isKey
      });
    }

    addAudio(rawBytes, timestampUs, durationUs) {
      const data = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
      this.aSamples.push({
        data,
        ptsUs: Math.max(0, Math.round(timestampUs || 0)),
        durUs: Math.max(1, Math.round(durationUs || Math.round(1024 * 1e6 / this.sampleRate)))
      });
    }

    finish() {
      const mvhdScale = 1000;
      const vScale = 90000;
      const aScale = this.sampleRate;
      const createTime = Math.floor((this.meta.timestampMs || Date.now()) / 1000) + MAC_EPOCH_OFFSET;

      // Chuẩn hóa thời lượng từng mẫu video
      const vSmp = this.vSamples;
      if (vSmp.length > 1) {
        const base = vSmp[0].ptsUs;
        for (let i = 0; i < vSmp.length; i++) vSmp[i].ptsUs -= base;
        for (let i = 0; i < vSmp.length - 1; i++) {
          const d = vSmp[i + 1].ptsUs - vSmp[i].ptsUs;
          if (d > 0) vSmp[i].durUs = d;
        }
        vSmp[vSmp.length - 1].durUs = vSmp.length > 1 ? vSmp[vSmp.length - 2].durUs : Math.round(1e6 / this.fps);
      }

      const vTotalTicks = vSmp.reduce((s, x) => s + Math.max(1, Math.round(x.durUs * vScale / 1e6)), 0);
      const vDurMvhd = Math.max(1, Math.round(vTotalTicks * mvhdScale / vScale));

      const aSmp = this.hasAudio && this.aSamples.length ? this.aSamples : [];
      if (aSmp.length > 1) {
        const base = aSmp[0].ptsUs;
        for (let i = 0; i < aSmp.length; i++) aSmp[i].ptsUs -= base;
        for (let i = 0; i < aSmp.length - 1; i++) {
          const d = aSmp[i + 1].ptsUs - aSmp[i].ptsUs;
          if (d > 0) aSmp[i].durUs = d;
        }
      }
      const aTotalTicks = aSmp.reduce((s, x) => s + Math.max(1, Math.round(x.durUs * aScale / 1e6)), 0);
      const aDurMvhd = aSmp.length ? Math.max(1, Math.round(aTotalTicks * mvhdScale / aScale)) : 0;
      const movieDur = Math.max(vDurMvhd, aDurMvhd, 1);

      // Build STBL helper (1 sample = 1 chunk để đơn giản & tương thích mọi player)
      function buildStbl(samples, scale, stsdBox, syncIndices) {
        // stts (run-length)
        const sttsEntries = [];
        for (const s of samples) {
          const delta = Math.max(1, Math.round(s.durUs * scale / 1e6));
          const last = sttsEntries[sttsEntries.length - 1];
          if (last && last.delta === delta) last.count++;
          else sttsEntries.push({ count: 1, delta });
        }
        const stts = fullBox('stts', 0, 0, u32(sttsEntries.length),
          sttsEntries.map(e => concat(u32(e.count), u32(e.delta))));

        // stss (keyframes)
        let stss = null;
        if (syncIndices && syncIndices.length) {
          stss = fullBox('stss', 0, 0, u32(syncIndices.length), syncIndices.map(i => u32(i)));
        }

        // stsc: 1 chunk = 1 sample
        const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));

        // stsz
        const stsz = fullBox('stsz', 0, 0, u32(0), u32(samples.length),
          samples.map(s => u32(s.data.byteLength)));

        // stco (placeholder 0, sẽ vá sau khi biết kích thước ftyp + moov)
        const stcoOffsetHolder = new Uint8Array(samples.length * 4);
        const stco = fullBox('stco', 0, 0, u32(samples.length), stcoOffsetHolder);

        return {
          box: box('stbl', stsdBox, stts, stss, stsc, stsz, stco),
          stcoPlaceholder: stcoOffsetHolder
        };
      }

      // Video stsd (avc1 + avcC)
      const avcCData = this.avcC || new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 0, 1, 0, 0]);
      const avcCBox = box('avcC', avcCData);
      const compressor = new Uint8Array(32);
      const compName = TE.encode('Camera PWA H.264');
      compressor[0] = Math.min(31, compName.byteLength);
      compressor.set(compName.subarray(0, 31), 1);

      const avc1 = box('avc1',
        new Uint8Array(6), u16(1), // reserved + data_ref_index
        u16(0), u16(0), u32(0), u32(0), u32(0), // pre_defined + reserved
        u16(this.width), u16(this.height),
        u32(0x00480000), u32(0x00480000), // 72 dpi
        u32(0), u16(1), // reserved + frame_count
        compressor,
        u16(0x0018), u16(0xffff), // depth 24, pre_defined -1
        avcCBox
      );
      const vStsd = fullBox('stsd', 0, 0, u32(1), avc1);

      const syncIdx = [];
      vSmp.forEach((s, i) => { if (s.key || i === 0) syncIdx.push(i + 1); });
      const vStbl = buildStbl(vSmp, vScale, vStsd, syncIdx);

      const vTrak = box('trak',
        fullBox('tkhd', 0, 0x000003,
          u32(createTime), u32(createTime), u32(1), u32(0), u32(vDurMvhd),
          u32(0), u32(0), u16(0), u16(0), u16(0), u16(0),
          UNITY_MATRIX,
          u32(this.width << 16), u32(this.height << 16)
        ),
        box('edts', fullBox('elst', 0, 0, u32(1), u32(vDurMvhd), u32(0), u32(0x00010000))),
        box('mdia',
          fullBox('mdhd', 0, 0, u32(createTime), u32(createTime), u32(vScale), u32(vTotalTicks), u16(0x55c4), u16(0)),
          fullBox('hdlr', 0, 0, u32(0), fourcc('vide'), u32(0), u32(0), u32(0), TE.encode('VideoHandler\0')),
          box('minf',
            fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
            box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            vStbl.box
          )
        )
      );

      // Audio track (nếu có)
      let aTrak = null, aStbl = null;
      if (aSmp.length) {
        const asc = this.asc || makeAacAsc(aScale, this.channels);
        // esds box cho mp4a
        const decSpecInfo = concat(u8(0x05), u8(asc.byteLength), asc);
        const decConfig = concat(
          u8(0x04), u8(13 + decSpecInfo.byteLength),
          u8(0x40), u8(0x15), u24(0), u32(128000), u32(128000),
          decSpecInfo
        );
        const slConfig = concat(u8(0x06), u8(1), u8(0x02));
        const esDescr = concat(u8(0x03), u8(3 + decConfig.byteLength + slConfig.byteLength), u16(2), u8(0), decConfig, slConfig);
        const esds = fullBox('esds', 0, 0, esDescr);

        const mp4a = box('mp4a',
          new Uint8Array(6), u16(1),
          u32(0), u32(0),
          u16(this.channels), u16(16), u16(0), u16(0),
          u32(aScale << 16),
          esds
        );
        const aStsd = fullBox('stsd', 0, 0, u32(1), mp4a);
        aStbl = buildStbl(aSmp, aScale, aStsd, null);

        aTrak = box('trak',
          fullBox('tkhd', 0, 0x000003,
            u32(createTime), u32(createTime), u32(2), u32(0), u32(aDurMvhd),
            u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0),
            UNITY_MATRIX,
            u32(0), u32(0)
          ),
          box('mdia',
            fullBox('mdhd', 0, 0, u32(createTime), u32(createTime), u32(aScale), u32(aTotalTicks), u16(0x55c4), u16(0)),
            fullBox('hdlr', 0, 0, u32(0), fourcc('soun'), u32(0), u32(0), u32(0), TE.encode('SoundHandler\0')),
            box('minf',
              fullBox('smhd', 0, 0, u16(0), u16(0)),
              box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
              aStbl.box
            )
          )
        );
      }

      const { udta, uuidBox } = buildMetadataBoxes(this.meta);

      const mvhd = fullBox('mvhd', 0, 0,
        u32(createTime), u32(createTime), u32(mvhdScale), u32(movieDur),
        u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
        UNITY_MATRIX,
        new Uint8Array(24),
        u32(aTrak ? 3 : 2)
      );

      const ftyp = box('ftyp', fourcc('isom'), u32(0x200), fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'));
      const moov = box('moov', mvhd, vTrak, aTrak, udta, uuidBox);

      // Tính offset thực tế của từng mẫu trong mdat (nằm ngay sau ftyp + moov + uuidBox)
      const mdatHeaderOffset = ftyp.byteLength + moov.byteLength + uuidBox.byteLength;
      let cursor = mdatHeaderOffset + 8;

      const vDv = new DataView(vStbl.stcoPlaceholder.buffer);
      vSmp.forEach((s, i) => {
        vDv.setUint32(i * 4, cursor >>> 0);
        cursor += s.data.byteLength;
      });
      if (aStbl) {
        const aDv = new DataView(aStbl.stcoPlaceholder.buffer);
        aSmp.forEach((s, i) => {
          aDv.setUint32(i * 4, cursor >>> 0);
          cursor += s.data.byteLength;
        });
      }

      // Dựng lại moov sau khi stco đã có offset chuẩn
      const finalMoov = box('moov', mvhd, vTrak, aTrak, udta, uuidBox);
      const mdatPayload = concat(vSmp.map(s => s.data), aSmp.map(s => s.data));
      const mdat = box('mdat', mdatPayload);

      return new Blob([ftyp, finalMoov, uuidBox, mdat], { type: 'video/mp4' });
    }
  }

  /* =========================================================
     API cấp cao dùng cho Camera PWA:
     - Hỗ trợ cả quay trực tiếp từ MediaStream (video thường)
       và quay từng khung hình canvas (Time Lapse)
     - Tự động thu thập metadata đầy đủ (tên file, thời gian ISO,
       độ phân giải, FPS, tên camera, thiết bị, trình duyệt, app)
     ========================================================= */
  async function findH264Config(width, height, fps, bitrate) {
    if (!('VideoEncoder' in global)) return null;
    // Đảm bảo kích thước chẵn (yêu cầu của H.264 YUV420)
    const w = width & ~1, h = height & ~1;
    const codecs = [
      'avc1.640028', // High Profile L4.0
      'avc1.4D4028', // Main Profile L4.0
      'avc1.42E01F', // Baseline Profile L3.1
      'avc1.42001E'  // Baseline Profile L3.0
    ];
    for (const codec of codecs) {
      try {
        const cfg = {
          codec,
          width: w,
          height: h,
          bitrate: bitrate || Math.min(12_000_000, Math.max(2_500_000, w * h * 4)),
          framerate: fps || 30,
          avc: { format: 'avc' }
        };
        const sup = await VideoEncoder.isConfigSupported(cfg);
        if (sup && sup.supported) return sup.config;
      } catch (e) { /* thử codec tiếp theo */ }
    }
    return null;
  }

  async function findAacConfig(sampleRate, channels) {
    if (!('AudioEncoder' in global)) return null;
    const sr = sampleRate || 48000;
    const ch = Math.min(2, Math.max(1, channels || 1));
    for (const codec of ['mp4a.40.2', 'mp4a.40.5']) {
      try {
        const cfg = { codec, sampleRate: sr, numberOfChannels: ch, bitrate: 128000 };
        const sup = await AudioEncoder.isConfigSupported(cfg);
        if (sup && sup.supported) return sup.config;
      } catch (e) { /* bỏ qua */ }
    }
    return null;
  }

  function detectDeviceInfo() {
    const ua = navigator.userAgent || '';
    let make = 'Web Browser', model = 'Camera PWA';
    if (/Android/i.test(ua)) {
      make = 'Android';
      const m = ua.match(/;\s*([^;)]+?)\s+Build\//);
      model = m ? m[1].trim() : 'Android Device';
    } else if (/CrOS/i.test(ua)) {
      make = 'Google';
      model = 'Chromebook (ChromeOS)';
    } else if (/Windows/i.test(ua)) {
      make = 'Microsoft';
      model = 'Windows PC';
    } else if (/Mac OS X/i.test(ua)) {
      make = 'Apple';
      model = 'Mac';
    } else if (/iPhone|iPad/i.test(ua)) {
      make = 'Apple';
      model = /iPad/i.test(ua) ? 'iPad' : 'iPhone';
    }
    return { make, model };
  }

  function buildRecordingMetadata(opts) {
    const now = opts.date || new Date();
    const dev = detectDeviceInfo();
    const res = `${opts.width}x${opts.height}`;
    const fps = opts.fps || 30;
    const modeLabel = opts.mode === 'timelapse' ? 'Time Lapse' : 'Video';
    return {
      timestampMs: now.getTime(),
      createDateISO: now.toISOString(),
      title: opts.title || `${modeLabel} ${now.toLocaleString('sv-SE')}`,
      software: 'Camera PWA (tuanphong3108.github.io/camera)',
      artist: 'Phong VN',
      make: dev.make,
      model: opts.cameraLabel ? `${dev.model} — ${opts.cameraLabel}` : dev.model,
      cameraLabel: opts.cameraLabel || '',
      width: opts.width,
      height: opts.height,
      fps,
      comment: [
        `Mode: ${modeLabel}`,
        `Resolution: ${res} @ ${fps}fps`,
        opts.filter && opts.filter !== 'none' ? `Filter: ${opts.filter}` : null,
        opts.mirror ? 'Mirrored: true' : null,
        opts.cameraLabel ? `Lens: ${opts.cameraLabel}` : null,
        `Recorded: ${now.toISOString()}`
      ].filter(Boolean).join(' | ')
    };
  }

  /* Tạo phiên quay MP4 thời gian thực từ <video> (có áp dụng filter + lật gương) và audioTrack (nếu có) */
  async function createRealtimeRecorder(opts) {
    const rawW = opts.width || 1280;
    const rawH = opts.height || 720;
    const width = rawW & ~1;
    const height = rawH & ~1;
    const fps = opts.fps || 30;
    const meta = buildRecordingMetadata({ ...opts, width, height, fps });

    const vCfg = await findH264Config(width, height, fps);
    if (!vCfg) return null; // Caller sẽ fallback sang MediaRecorder MP4/WebM

    const audioTrack = opts.audioTrack && opts.audioTrack.readyState === 'live' ? opts.audioTrack : null;
    const aSettings = audioTrack ? audioTrack.getSettings() : {};
    const sampleRate = aSettings.sampleRate || 48000;
    const channels = Math.min(2, aSettings.channelCount || 1);
    const aCfg = audioTrack ? await findAacConfig(sampleRate, channels) : null;

    const muxer = new Mp4Muxer({
      width, height, fps,
      hasAudio: !!aCfg,
      sampleRate: aCfg ? aCfg.sampleRate : sampleRate,
      channels: aCfg ? aCfg.numberOfChannels : channels,
      meta
    });

    let vErr = null;
    const vEnc = new VideoEncoder({
      output: (chunk, md) => {
        if (md && md.decoderConfig && md.decoderConfig.description) {
          muxer.setVideoDescription(md.decoderConfig.description);
        }
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        muxer.addVideo(buf, chunk.timestamp, chunk.duration, chunk.type === 'key');
      },
      error: e => { vErr = e; console.error('VideoEncoder:', e); }
    });
    vEnc.configure(vCfg);

    let aEnc = null, aReader = null;
    if (aCfg && audioTrack && 'MediaStreamTrackProcessor' in global) {
      try {
        aEnc = new AudioEncoder({
          output: (chunk, md) => {
            if (md && md.decoderConfig && md.decoderConfig.description) {
              muxer.setAudioDescription(md.decoderConfig.description);
            }
            const buf = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buf);
            muxer.addAudio(buf, chunk.timestamp, chunk.duration);
          },
          error: e => console.warn('AudioEncoder:', e)
        });
        aEnc.configure(aCfg);
        const proc = new MediaStreamTrackProcessor({ track: audioTrack });
        aReader = proc.readable.getReader();
      } catch (e) {
        aEnc = null; aReader = null;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });

    let running = true;
    let frameIdx = 0;
    const t0Us = performance.now() * 1000;

    // Vòng lặp đọc audio
    const audioLoop = (async () => {
      if (!aReader || !aEnc) return;
      while (running) {
        let res;
        try { res = await aReader.read(); } catch (e) { break; }
        if (res.done || !res.value) break;
        const audioData = res.value;
        if (running && aEnc.state === 'configured') {
          try { aEnc.encode(audioData); } catch (e) { /* bỏ qua */ }
        }
        audioData.close();
      }
    })();

    // Vòng lặp ghi hình video theo nhịp fps
    const intervalMs = 1000 / fps;
    let timer = null;
    const captureFrame = () => {
      if (!running || vErr || vEnc.state !== 'configured') return;
      if (vEnc.encodeQueueSize > 8) return; // chống tràn bộ nhớ khi CPU yếu
      opts.drawFrame(ctx, width, height);
      const ts = Math.round(performance.now() * 1000 - t0Us);
      const vf = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / fps) });
      try {
        vEnc.encode(vf, { keyFrame: frameIdx % (fps * 2) === 0 });
        frameIdx++;
      } finally {
        vf.close();
      }
    };
    captureFrame();
    timer = setInterval(captureFrame, intervalMs);

    return {
      async stop() {
        running = false;
        clearInterval(timer);
        if (aReader) { try { await aReader.cancel(); } catch (e) { /* bỏ qua */ } }
        await audioLoop;
        if (vEnc.state === 'configured') await vEnc.flush();
        if (vEnc.state !== 'closed') vEnc.close();
        if (aEnc) {
          if (aEnc.state === 'configured') await aEnc.flush();
          if (aEnc.state !== 'closed') aEnc.close();
        }
        return muxer.finish();
      }
    };
  }

  /* Đóng gói mảng ảnh JPEG/Canvas thành MP4 chuẩn có đủ metadata (dùng cho Time Lapse) */
  async function encodeFramesToMp4(frames, opts) {
    const width = (opts.width || 1280) & ~1;
    const height = (opts.height || 720) & ~1;
    const fps = opts.fps || 15;
    const meta = buildRecordingMetadata({ ...opts, width, height, fps, mode: 'timelapse' });

    const vCfg = await findH264Config(width, height, fps);
    if (!vCfg) return null;

    const muxer = new Mp4Muxer({ width, height, fps, hasAudio: false, meta });
    const vEnc = new VideoEncoder({
      output: (chunk, md) => {
        if (md && md.decoderConfig && md.decoderConfig.description) {
          muxer.setVideoDescription(md.decoderConfig.description);
        }
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        muxer.addVideo(buf, chunk.timestamp, chunk.duration, chunk.type === 'key');
      },
      error: e => console.error('TimeLapse VideoEncoder:', e)
    });
    vEnc.configure(vCfg);

    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    const durUs = Math.round(1e6 / fps);

    for (let i = 0; i < frames.length; i++) {
      const bm = await createImageBitmap(frames[i]);
      ctx.drawImage(bm, 0, 0, width, height);
      bm.close();
      const vf = new VideoFrame(canvas, { timestamp: i * durUs, duration: durUs });
      vEnc.encode(vf, { keyFrame: i % fps === 0 });
      vf.close();
      if (vEnc.encodeQueueSize > 6) await vEnc.flush();
    }

    await vEnc.flush();
    vEnc.close();
    return muxer.finish();
  }

  global.Mp4Recorder = {
    createRealtimeRecorder,
    encodeFramesToMp4,
    injectMetadataIntoMp4,
    buildRecordingMetadata
  };
})(window);
