/* Bộ mã hoá GIF nhỏ gọn cho chế độ Video > GIF.
   Bảng màu cố định 6×7×6 (252 màu) + dither Bayer 4×4, nén LZW chuẩn GIF89a.
   Dùng:  const g = new GifEncoder(w, h, delayMs);  g.addFrame(imageData.data);  const blob = g.finish(); */
(function () {
  var LR = 6, LG = 7, LB = 6;
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  function lzw(px, out) {
    var MIN = 8, CLEAR = 256, EOI = 257, size = MIN + 1, next = EOI + 1, table = new Map();
    var cur = 0, shift = 0, buf = [];
    function emit(code) {
      cur |= code << shift; shift += size;
      while (shift >= 8) { buf.push(cur & 255); cur >>>= 8; shift -= 8; }
    }
    emit(CLEAR);
    var prefix = px[0];
    for (var i = 1; i < px.length; i++) {
      var k = px[i], key = (prefix << 8) | k, code = table.get(key);
      if (code !== undefined) { prefix = code; continue; }
      emit(prefix);
      if (next === 4096) { emit(CLEAR); table.clear(); next = EOI + 1; size = MIN + 1; }
      else { if (next >= (1 << size)) size++; table.set(key, next++); }
      prefix = k;
    }
    emit(prefix); emit(EOI);
    if (shift > 0) buf.push(cur & 255);
    out.push(MIN);
    for (var p = 0; p < buf.length; p += 255) {
      var n = Math.min(255, buf.length - p);
      out.push(n);
      for (var j = 0; j < n; j++) out.push(buf[p + j]);
    }
    out.push(0);
  }

  function GifEncoder(w, h, delayMs) {
    this.w = w; this.h = h; this.delay = Math.max(2, Math.round(delayMs / 10));
    this.bytes = [];
    var b = this.bytes;
    function s(str) { for (var i = 0; i < str.length; i++) b.push(str.charCodeAt(i)); }
    function u16(v) { b.push(v & 255, (v >> 8) & 255); }
    s('GIF89a'); u16(w); u16(h); b.push(0xF7, 0, 0);
    for (var r = 0; r < LR; r++) for (var g = 0; g < LG; g++) for (var bl = 0; bl < LB; bl++)
      b.push(Math.round(r * 255 / (LR - 1)), Math.round(g * 255 / (LG - 1)), Math.round(bl * 255 / (LB - 1)));
    for (var pad = LR * LG * LB; pad < 256; pad++) b.push(0, 0, 0);
    b.push(0x21, 0xFF, 11); s('NETSCAPE2.0'); b.push(3, 1, 0, 0, 0);   /* lặp vô hạn */
  }

  /* rgba: Uint8ClampedArray w*h*4 */
  GifEncoder.prototype.addFrame = function (rgba) {
    var w = this.w, h = this.h, px = new Uint8Array(w * h), b = this.bytes, i = 0;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++, i++) {
      var t = (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16, o = i * 4;
      var r = Math.min(LR - 1, Math.floor(rgba[o] / 255 * (LR - 1) + t));
      var g = Math.min(LG - 1, Math.floor(rgba[o + 1] / 255 * (LG - 1) + t));
      var bl = Math.min(LB - 1, Math.floor(rgba[o + 2] / 255 * (LB - 1) + t));
      px[i] = (r * LG + g) * LB + bl;
    }
    b.push(0x21, 0xF9, 4, 0x04, this.delay & 255, (this.delay >> 8) & 255, 0, 0);
    b.push(0x2C, 0, 0, 0, 0, w & 255, (w >> 8) & 255, h & 255, (h >> 8) & 255, 0);
    lzw(px, b);
  };

  GifEncoder.prototype.finish = function () {
    this.bytes.push(0x3B);
    return new Blob([new Uint8Array(this.bytes)], { type: 'image/gif' });
  };

  if (typeof module !== 'undefined') module.exports = GifEncoder; else window.GifEncoder = GifEncoder;
})();
