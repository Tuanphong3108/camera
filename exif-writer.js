/* =========================================================
   JPEG EXIF Writer (TIFF Little-Endian — tương thích Google Photos & Photos PWA)
   - Gắn đầy đủ thẻ EXIF chuẩn vào ảnh JPEG từ canvas:
     • IFD0: Make (0x010F), Model (0x0110), Orientation (0x0112), Software (0x0131), DateTime (0x0132)
     • Exif SubIFD: ExifVersion (0232), DateTimeOriginal, DateTimeDigitized,
       OffsetTime / OffsetTimeOriginal / OffsetTimeDigitized (±HH:MM), PixelXDimension, PixelYDimension
     • GPS SubIFD (khi bật Lưu vị trí GPS): GPSVersionID, GPSLatitudeRef/GPSLatitude,
       GPSLongitudeRef/GPSLongitude, GPSAltitudeRef/GPSAltitude, GPSTimeStamp, GPSDateStamp
   ========================================================= */
(function (global) {
  'use strict';

  const enc = new TextEncoder();

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatExifDate(d) {
    return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatExifOffset(d) {
    const offMin = -d.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  }

  function formatUtcDate(d) {
    return `${d.getUTCFullYear()}:${pad2(d.getUTCMonth() + 1)}:${pad2(d.getUTCDate())}`;
  }

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

  function decToDmsRationals(degVal) {
    const abs = Math.abs(degVal);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const secScaled = Math.round((minFloat - min) * 60 * 10000);
    return [[deg, 1], [min, 1], [secScaled, 10000]];
  }

  function asciiEntry(tag, str) {
    const bytes = enc.encode(String(str) + '\0');
    return { tag, type: 2, count: bytes.length, data: bytes };
  }
  function byteEntry(tag, arr) {
    const bytes = new Uint8Array(arr);
    return { tag, type: 1, count: bytes.length, data: bytes };
  }
  function undefEntry(tag, str) {
    const bytes = enc.encode(str);
    return { tag, type: 7, count: bytes.length, data: bytes };
  }
  function shortEntry(tag, val) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, val & 0xFFFF, true);
    return { tag, type: 3, count: 1, data: b };
  }
  function longEntry(tag, val) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, val >>> 0, true);
    return { tag, type: 4, count: 1, data: b };
  }
  function rationalEntry(tag, pairs) {
    const b = new Uint8Array(pairs.length * 8);
    const dv = new DataView(b.buffer);
    pairs.forEach(([num, den], i) => {
      dv.setUint32(i * 8, num >>> 0, true);
      dv.setUint32(i * 8 + 4, den >>> 0, true);
    });
    return { tag, type: 5, count: pairs.length, data: b };
  }

  /* Dựng một bảng IFD chuẩn TIFF Little-Endian, trả về mảng byte và tổng kích thước (căn chẵn 2 byte) */
  function buildIfd(entries, startOffset) {
    const sorted = entries.slice().sort((a, b) => a.tag - b.tag);
    const tableSize = 2 + sorted.length * 12 + 4;
    let dataCursor = startOffset + tableSize;
    const extraParts = [];

    const table = new Uint8Array(tableSize);
    const dv = new DataView(table.buffer);
    dv.setUint16(0, sorted.length, true);

    sorted.forEach((e, i) => {
      const off = 2 + i * 12;
      dv.setUint16(off, e.tag, true);
      dv.setUint16(off + 2, e.type, true);
      dv.setUint32(off + 4, e.count >>> 0, true);
      if (e.data.byteLength <= 4) {
        table.set(e.data, off + 8);
      } else {
        dv.setUint32(off + 8, dataCursor >>> 0, true);
        extraParts.push(e.data);
        dataCursor += e.data.byteLength;
        if (dataCursor & 1) {
          extraParts.push(new Uint8Array([0]));
          dataCursor += 1;
        }
      }
    });
    // Next IFD offset = 0 (4 byte cuối của table đã là 0)

    const totalSize = dataCursor - startOffset;
    const out = new Uint8Array(totalSize);
    out.set(table, 0);
    let pos = tableSize;
    for (const p of extraParts) {
      out.set(p, pos);
      pos += p.byteLength;
    }
    return { bytes: out, size: totalSize };
  }

  function buildExifApp1(opts = {}) {
    const now = opts.date || new Date();
    const dev = detectDeviceInfo();
    const make = opts.make || dev.make;
    const model = opts.model || dev.model;
    const software = opts.software || 'Camera PWA (Tuanphong3108/camera)';
    const dateStr = formatExifDate(now);
    const tzStr = formatExifOffset(now);
    const gps = opts.gps && isFinite(opts.gps.lat) && isFinite(opts.gps.lon) ? opts.gps : null;

    const makeIfd0 = (exifPtr, gpsPtr) => {
      const list = [
        asciiEntry(0x010F, make),
        asciiEntry(0x0110, model),
        shortEntry(0x0112, 1),
        asciiEntry(0x0131, software),
        asciiEntry(0x0132, dateStr),
        longEntry(0x8769, exifPtr)
      ];
      if (gps) list.push(longEntry(0x8825, gpsPtr));
      return list;
    };

    const exifEntries = [
      undefEntry(0x9000, '0232'),
      asciiEntry(0x9003, dateStr),
      asciiEntry(0x9004, dateStr),
      asciiEntry(0x9010, tzStr),
      asciiEntry(0x9011, tzStr),
      asciiEntry(0x9012, tzStr)
    ];
    if (opts.width > 0) exifEntries.push(longEntry(0xA002, opts.width));
    if (opts.height > 0) exifEntries.push(longEntry(0xA003, opts.height));

    const gpsEntries = [];
    if (gps) {
      gpsEntries.push(
        byteEntry(0x0000, [2, 3, 0, 0]),
        asciiEntry(0x0001, gps.lat >= 0 ? 'N' : 'S'),
        rationalEntry(0x0002, decToDmsRationals(gps.lat)),
        asciiEntry(0x0003, gps.lon >= 0 ? 'E' : 'W'),
        rationalEntry(0x0004, decToDmsRationals(gps.lon)),
        rationalEntry(0x0007, [[now.getUTCHours(), 1], [now.getUTCMinutes(), 1], [now.getUTCSeconds(), 1]]),
        asciiEntry(0x001D, formatUtcDate(now))
      );
      if (isFinite(gps.alt)) {
        gpsEntries.push(
          byteEntry(0x0005, [gps.alt < 0 ? 1 : 0]),
          rationalEntry(0x0006, [[Math.round(Math.abs(gps.alt) * 100), 100]])
        );
      }
    }

    // Lượt 1: tính kích thước IFD0 để biết offset Exif & GPS
    const probeIfd0 = buildIfd(makeIfd0(0, 0), 8);
    const exifOffset = 8 + probeIfd0.size;
    const exifIfd = buildIfd(exifEntries, exifOffset);
    const gpsOffset = exifOffset + exifIfd.size;
    const gpsIfd = gps ? buildIfd(gpsEntries, gpsOffset) : { bytes: new Uint8Array(0), size: 0 };

    // Lượt 2: dựng IFD0 với pointer chính xác
    const ifd0 = buildIfd(makeIfd0(exifOffset, gps ? gpsOffset : 0), 8);

    // TIFF Header (8 bytes): 'II', 0x002A, offset 8
    const tiffHdr = new Uint8Array([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
    const exifHdr = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
    const payloadLen = exifHdr.byteLength + tiffHdr.byteLength + ifd0.size + exifIfd.size + gpsIfd.size;
    const segLen = payloadLen + 2;

    const seg = new Uint8Array(2 + segLen);
    seg[0] = 0xFF; seg[1] = 0xE1;
    seg[2] = (segLen >> 8) & 0xFF; seg[3] = segLen & 0xFF;
    let p = 4;
    seg.set(exifHdr, p); p += exifHdr.byteLength;
    seg.set(tiffHdr, p); p += tiffHdr.byteLength;
    seg.set(ifd0.bytes, p); p += ifd0.size;
    seg.set(exifIfd.bytes, p); p += exifIfd.size;
    if (gpsIfd.size) seg.set(gpsIfd.bytes, p);
    return seg;
  }

  /* Chèn segment APP1 EXIF vào Blob ảnh JPEG */
  async function injectJpegExif(blob, opts = {}) {
    const src = new Uint8Array(await blob.arrayBuffer());
    if (src.byteLength < 4 || src[0] !== 0xFF || src[1] !== 0xD8) return blob;
    let insertAt = 2;
    // Nếu có APP0 (JFIF) ngay sau SOI, chèn APP1 ngay sau APP0
    if (src[2] === 0xFF && src[3] === 0xE0 && src.byteLength >= 6) {
      const app0Len = (src[4] << 8) | src[5];
      if (2 + 2 + app0Len <= src.byteLength) insertAt = 2 + 2 + app0Len;
    }
    const app1 = buildExifApp1(opts);
    return new Blob([src.subarray(0, insertAt), app1, src.subarray(insertAt)], { type: 'image/jpeg' });
  }

  global.ExifWriter = { injectJpegExif };
})(window);
