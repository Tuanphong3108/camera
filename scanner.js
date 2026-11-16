/* =========================================================
   Scanner — lõi quét tài liệu (không phụ thuộc thư viện)
   - findQuad(rgba, w, h): tìm 4 góc tờ giấy (TL, TR, BR, BL), toạ độ theo pixel ảnh; null nếu không thấy
   - warp(src, sw, sh, quad, maxSide): nắn phẳng tờ giấy bằng phép biến đổi phối cảnh → {data, w, h}
   - enhance(img): kéo giãn độ sáng cho trang tài liệu rõ nét hơn
   - pdf(pages): ghép nhiều ảnh JPEG thành 1 file PDF; pages = [{jpeg: Uint8Array, w, h}]
   ========================================================= */
(function (root) {
  'use strict';

  /* ---------- Nhận diện tờ giấy ---------- */
  function toGray(rgba, w, h, tw) {
    const k = Math.max(1, Math.round(w / tw)), gw = Math.floor(w / k), gh = Math.floor(h / k);
    const g = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0, n = 0;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
        const p = ((y * k + j) * w + (x * k + i)) * 4;
        s += rgba[p] * .299 + rgba[p + 1] * .587 + rgba[p + 2] * .114; n++;
      }
      g[y * gw + x] = s / n;
    }
    return { g, gw, gh, k };
  }
  function blur(g, w, h) {
    const o = new Float32Array(g.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const xx = x + i, yy = y + j;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += g[yy * w + xx]; n++; }
      }
      o[y * w + x] = s / n;
    }
    return o;
  }
  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++;
    const total = g.length; let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let wB = 0, sB = 0, best = 0, th = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sB += i * hist[i];
      const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; th = i; }
    }
    return th;
  }
  /* Thành phần liên thông lớn nhất của mask (4 hướng) */
  function biggest(mask, w, h) {
    const lab = new Int32Array(w * h), st = new Int32Array(w * h);
    let bestId = 0, bestN = 0, id = 0;
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || lab[s]) continue;
      id++; let sp = 0, n = 0; st[sp++] = s; lab[s] = id;
      while (sp) {
        const p = st[--sp]; n++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; st[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; st[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; st[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; st[sp++] = p + w; }
      }
      if (n > bestN) { bestN = n; bestId = id; }
    }
    return { lab, id: bestId, n: bestN };
  }
  function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
  function hull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    lo.pop(); up.pop(); return lo.concat(up);
  }
  function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a) / 2; }

  function findQuad(rgba, w, h) {
    const { g: g0, gw, gh, k } = toGray(rgba, w, h, 160);
    if (gw < 16 || gh < 16) return null;
    const g = blur(g0, gw, gh), th = otsu(g), N = gw * gh;
    let best = null;
    for (const pol of [1, -1]) {                       /* 1: giấy sáng hơn nền, -1: giấy tối hơn nền */
      const mask = new Uint8Array(N);
      for (let i = 0; i < N; i++) mask[i] = pol === 1 ? g[i] > th : g[i] <= th;
      const { lab, id, n } = biggest(mask, gw, gh);
      if (!id) continue;
      const ratio = n / N; if (ratio < .1 || ratio > .96) continue;
      /* Giấy là vùng đặc: điểm biên tách ra 4 góc theo x+y / x−y */
      const pts = [];
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (lab[y * gw + x] === id) {
        const edge = x === 0 || y === 0 || x === gw - 1 || y === gh - 1 || lab[y * gw + x - 1] !== id || lab[y * gw + x + 1] !== id || lab[(y - 1) * gw + x] !== id || lab[(y + 1) * gw + x] !== id;
        if (edge) pts.push([x, y]);
      }
      if (pts.length < 8) continue;
      const H = hull(pts);
      let tl = H[0], tr = H[0], br = H[0], bl = H[0];
      for (const p of H) {
        if (p[0] + p[1] < tl[0] + tl[1]) tl = p;
        if (p[0] + p[1] > br[0] + br[1]) br = p;
        if (p[0] - p[1] > tr[0] - tr[1]) tr = p;
        if (p[0] - p[1] < bl[0] - bl[1]) bl = p;
      }
      const quad = [tl, tr, br, bl], qa = polyArea(quad);
      if (qa < N * .1) continue;
      const fill = n / qa;                              /* vùng phải lấp gần đầy tứ giác */
      if (fill < .78 || fill > 1.15) continue;
      /* Tứ giác phải lồi và các cạnh không quá méo */
      let ok = true;
      for (let i = 0; i < 4; i++) if (cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]) <= 0) ok = false;
      if (!ok) continue;
      const score = n * fill;
      if (!best || score > best.score) best = { quad, score };
    }
    if (!best) return null;
    /* Biên vùng nhị phân nằm trong rìa giấy nửa ô: đẩy ra ngoài một chút rồi đổi sang toạ độ gốc */
    const cx = best.quad.reduce((s, p) => s + p[0], 0) / 4, cy = best.quad.reduce((s, p) => s + p[1], 0) / 4;
    return best.quad.map(p => {
      const dx = p[0] - cx, dy = p[1] - cy, d = Math.hypot(dx, dy) || 1;
      return [Math.max(0, Math.min(w - 1, (p[0] + dx / d * .5 + .5) * k)), Math.max(0, Math.min(h - 1, (p[1] + dy / d * .5 + .5) * k))];
    });
  }

  /* ---------- Nắn phẳng (homography) ---------- */
  /* Giải phép biến đổi (0,0),(1,0),(1,1),(0,1) → 4 góc (Heckbert) */
  function squareToQuad(q) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    let a, b, c, d, e, f, gg, hh;
    if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
      a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; gg = 0; hh = 0;
    } else {
      const den = dx1 * dy2 - dx2 * dy1;
      gg = (dx3 * dy2 - dx2 * dy3) / den; hh = (dx1 * dy3 - dx3 * dy1) / den;
      a = x1 - x0 + gg * x1; b = x3 - x0 + hh * x3; c = x0;
      d = y1 - y0 + gg * y1; e = y3 - y0 + hh * y3; f = y0;
    }
    return [a, b, c, d, e, f, gg, hh];
  }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  function outSize(quad, maxSide) {
    let w = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2])), h = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
    const s = Math.min(1, maxSide / Math.max(w, h));
    return { w: Math.max(2, Math.round(w * s)), h: Math.max(2, Math.round(h * s)) };
  }
  function warp(src, sw, sh, quad, maxSide) {
    const { w, h } = outSize(quad, maxSide || 2000), M = squareToQuad(quad), out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (x + .5) / w, v = (y + .5) / h, z = M[6] * u + M[7] * v + 1;
      const sx = (M[0] * u + M[1] * v + M[2]) / z - .5, sy = (M[3] * u + M[4] * v + M[5]) / z - .5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0, o = (y * w + x) * 4;
      const xa = Math.max(0, Math.min(sw - 1, x0)), xb = Math.max(0, Math.min(sw - 1, x0 + 1));
      const ya = Math.max(0, Math.min(sh - 1, y0)), yb = Math.max(0, Math.min(sh - 1, y0 + 1));
      for (let c = 0; c < 3; c++) {
        const p00 = src[(ya * sw + xa) * 4 + c], p10 = src[(ya * sw + xb) * 4 + c], p01 = src[(yb * sw + xa) * 4 + c], p11 = src[(yb * sw + xb) * 4 + c];
        out[o + c] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
      }
      out[o + 3] = 255;
    }
    return { data: out, w, h };
  }

  /* Kéo giãn độ sáng (2%–98%) cho giấy trắng, chữ đậm */
  function enhance(img) {
    const d = img.data, hist = new Uint32Array(256), n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) hist[(d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) | 0]++;
    let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * .02) { lo = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * .15) { hi = i; break; } }
    if (hi - lo < 30) return img;
    const s = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = (d[i + c] - lo) * s;
    return img;
  }

  /* ---------- Ghi PDF ---------- */
  const enc = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
  function pdf(pages) {
    const parts = [], offs = []; let len = 0;
    const push = b => { if (typeof b === 'string') b = enc(b); parts.push(b); len += b.length; };
    const obj = (n, fn) => { offs[n] = len; push(`${n} 0 obj\n`); fn(); push('\nendobj\n'); };
    const N = pages.length; push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Count ${N} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`));
    pages.forEach((p, i) => {
      const pw = 595.28, ph = +(pw * p.h / p.w).toFixed(2), base = 3 + i * 3, content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
      obj(base, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${base + 1} 0 R >> >> /Contents ${base + 2} 0 R >>`));
      obj(base + 1, () => { push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`); push(p.jpeg); push('\nendstream'); });
      obj(base + 2, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    });
    const total = 3 + N * 3, xref = len;
    push(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let i = 1; i < total; i++) push(String(offs[i]).padStart(10, '0') + ' 00000 n \n');
    push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len); let o = 0; for (const b of parts) { out.set(b, o); o += b.length; }
    return out;
  }

  const api = { findQuad, warp, enhance, pdf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Scanner = api;
})(typeof window !== 'undefined' ? window : globalThis);
