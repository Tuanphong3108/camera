/* =========================================================
   Scanner — lõi quét tài liệu (không phụ thuộc thư viện)
   - findQuad(rgba, w, h): tìm 4 góc tờ giấy (TL, TR, BR, BL), toạ độ theo pixel ảnh; null nếu không thấy
   - warp(src, sw, sh, quad, maxSide): nắn phẳng tờ giấy bằng phép biến đổi phối cảnh → {data, w, h}
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

  /* ---------- Nhận diện bằng OpenCV.js ----------
     Nhiều ứng viên (cạnh Canny nhiều ngưỡng, độ dốc màu Lab, Otsu, khác màu nền) → mỗi tứ giác chấm điểm theo độ tương phản
     trong/ngoài dọc 4 cạnh → chọn cái chắc nhất → khớp lại từng cạnh bằng đường thẳng (chính xác dưới 1px). Nên chạy ở ≥ 480px chiều ngang. */
  function orderQuad(p) {
    const s = p.map(q => q[0] + q[1]), d = p.map(q => q[0] - q[1]);
    return [p[s.indexOf(Math.min(...s))], p[d.indexOf(Math.max(...d))], p[s.indexOf(Math.max(...s))], p[d.indexOf(Math.min(...d))]];
  }
  function convexQuad(q) { for (let i = 0; i < 4; i++) if (cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]) <= 0) return false; return true; }
  function percentile(arr, pc) {                           /* xấp xỉ bằng histogram 2048 ngăn */
    let mx = 0; for (let i = 0; i < arr.length; i++) if (arr[i] > mx) mx = arr[i];
    if (!mx) return 0;
    const bins = new Uint32Array(2049), sc = 2048 / mx; for (let i = 0; i < arr.length; i++) bins[(arr[i] * sc) | 0]++;
    let acc = 0, goal = arr.length * pc / 100; for (let i = 0; i <= 2048; i++) { acc += bins[i]; if (acc >= goal) return i / sc; }
    return mx;
  }
  function labSupport(q, lab, w, h) {
    const d = Math.max(3, Math.round(w * .012)), sides = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < w * .12) return { s: 0, min: 0 };
      const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L, N = Math.max(12, Math.floor(L / 4)); let ok = 0;
      for (let k = 0; k < N; k++) {
        const t = .04 + .92 * k / (N - 1), px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
        const ox = px + nx * d, oy = py + ny * d, ix = px - nx * d, iy = py - ny * d;
        if (ox < 0 || oy < 0 || ox >= w - 1 || oy >= h - 1 || ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) continue;
        const po = ((oy | 0) * w + (ox | 0)) * 3, pi = ((iy | 0) * w + (ix | 0)) * 3;
        if (Math.hypot(lab[po] - lab[pi], lab[po + 1] - lab[pi + 1], lab[po + 2] - lab[pi + 2]) > 3.5) ok++;
      }
      sides.push(ok / N);
    }
    return { s: sides.reduce((x, y) => x + y, 0) / 4, min: Math.min(...sides) };
  }
  /* Khớp đường thẳng bền vững (trọng số lại theo phần dư) */
  function fitLine(pts) {
    let mx = 0, my = 0; pts.forEach(p => { mx += p[0]; my += p[1]; }); mx /= pts.length; my /= pts.length;
    let vx = 1, vy = 0, w = pts.map(() => 1);
    for (let it = 0; it < 4; it++) {
      let sw = 0, cx = 0, cy = 0; pts.forEach((p, i) => { sw += w[i]; cx += w[i] * p[0]; cy += w[i] * p[1]; }); cx /= sw; cy /= sw; mx = cx; my = cy;
      let sxx = 0, sxy = 0, syy = 0; pts.forEach((p, i) => { const dx = p[0] - mx, dy = p[1] - my; sxx += w[i] * dx * dx; sxy += w[i] * dx * dy; syy += w[i] * dy * dy; });
      const th = .5 * Math.atan2(2 * sxy, sxx - syy); vx = Math.cos(th); vy = Math.sin(th);
      w = pts.map(p => { const r = Math.abs(-(p[0] - mx) * vy + (p[1] - my) * vx); return 1 / Math.max(1, r); });
    }
    return [vx, vy, mx, my];
  }
  function refineQuad(q, lab, w, h) {
    const rad = Math.max(8, Math.round(w * .04)), lines = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L, pts = [];
      const N = Math.max(16, Math.floor(L / 3));
      for (let k = 0; k < N; k++) {
        const t = .08 + .84 * k / (N - 1), px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t, ds = []; let mx = 0;
        for (let off = -rad; off <= rad; off++) {
          const ox = px + nx * (off + 2), oy = py + ny * (off + 2), ix = px + nx * (off - 2), iy = py + ny * (off - 2);
          let dd = 0;
          if (ox >= 0 && oy >= 0 && ox < w - 1 && oy < h - 1 && ix >= 0 && iy >= 0 && ix < w - 1 && iy < h - 1) {
            const po = ((oy | 0) * w + (ox | 0)) * 3, pi = ((iy | 0) * w + (ix | 0)) * 3;
            dd = Math.hypot(lab[po] - lab[pi], lab[po + 1] - lab[pi + 1], lab[po + 2] - lab[pi + 2]);
          }
          ds.push(dd); if (dd > mx) mx = dd;
        }
        if (mx > 4) { for (let j = 0; j < ds.length; j++) if (ds[j] >= .6 * mx) { const off = j - rad; pts.push([px + nx * off, py + ny * off]); break; } }   /* ưu tiên cạnh trong cùng: bỏ qua bóng đổ */
      }
      if (pts.length < Math.max(8, L / 12)) return q;
      lines.push(fitLine(pts));
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const l1 = lines[(i + 3) % 4], l2 = lines[i], det = -l1[0] * l2[1] + l2[0] * l1[1];
      if (Math.abs(det) < 1e-6) return q;
      const bx = l2[2] - l1[2], by = l2[3] - l1[3], t = (-bx * l2[1] + l2[0] * by) / det;
      out.push([l1[2] + l1[0] * t, l1[3] + l1[1] * t]);
    }
    return out.every((p, i) => Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) < rad * 2.2) ? out : q;
  }
  function findQuadCV(cv, rgba, w, h) {
    const mats = [], M = m => (mats.push(m), m), N = w * h;
    try {
      const src = M(cv.matFromImageData({ data: rgba, width: w, height: h })), rgb = M(new cv.Mat()), gray = M(new cv.Mat()), lab8 = M(new cv.Mat());
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY); cv.cvtColor(rgb, lab8, cv.COLOR_RGB2Lab);
      /* Xoá chữ tối trên giấy: đóng (closing) với nhân lớn rồi làm mờ */
      const kk = Math.max(5, Math.round(w * .03) | 1), gc = M(new cv.Mat());
      cv.morphologyEx(gray, gc, cv.MORPH_CLOSE, M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kk, kk))));
      cv.GaussianBlur(gc, gc, new cv.Size(5, 5), 0);
      const l8 = lab8.data, g8 = gc.data, f = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) { f[i * 3] = g8[i] * 100 / 255; f[i * 3 + 1] = l8[i * 3 + 1] - 128; f[i * 3 + 2] = l8[i * 3 + 2] - 128; }
      const labM = M(cv.matFromArray(h, w, cv.CV_32FC3, f)); cv.GaussianBlur(labM, labM, new cv.Size(5, 5), 0);
      const lab = labM.data32F, k3 = M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))), anc = new cv.Point(-1, -1);
      const bins = [], bin8 = (arr) => { const m = M(cv.matFromArray(h, w, cv.CV_8UC1, arr)); return m; };
      const dil = (m, it) => { cv.dilate(m, m, k3, anc, it); bins.push(m); };
      /* Canny nhiều ngưỡng */
      const hist = new Uint32Array(256); for (let i = 0; i < N; i++) hist[g8[i]]++;
      let acc = 0, med = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= N / 2) { med = i; break; } }
      for (const [lo, hi] of [[20, 60], [40, 110], [Math.max(0, .5 * med), Math.min(255, 1.2 * med)]]) { const e = M(new cv.Mat()); cv.Canny(gc, e, lo, hi); dil(e, 2); }
      /* Độ dốc Lab gộp 3 kênh, lấy top phần trăm → bắt cả cạnh rất nhạt */
      const gx = M(new cv.Mat()), gy = M(new cv.Mat()); cv.Sobel(labM, gx, cv.CV_32F, 1, 0, 3); cv.Sobel(labM, gy, cv.CV_32F, 0, 1, 3);
      const gxd = gx.data32F, gyd = gy.data32F, gm = new Float32Array(N);
      for (let i = 0; i < N; i++) { let s = 0; for (let c = 0; c < 3; c++) { const a = gxd[i * 3 + c], b = gyd[i * 3 + c]; s += a * a + b * b; } gm[i] = Math.sqrt(s); }
      for (const pc of [80, 88, 94]) {
        const th = Math.max(percentile(gm, pc), 1), arr = new Uint8Array(N); for (let i = 0; i < N; i++) arr[i] = gm[i] > th ? 255 : 0;
        const e = bin8(arr); cv.morphologyEx(e, e, cv.MORPH_CLOSE, k3); dil(e, 1);
      }
      /* Cạnh theo kênh màu a, b */
      for (let ch = 1; ch <= 2; ch++) {
        let lo = 1e9, hi = -1e9; for (let i = 0; i < N; i++) { const v = lab[i * 3 + ch]; if (v < lo) lo = v; if (v > hi) hi = v; }
        const arr = new Uint8Array(N), sc = hi > lo ? 255 / (hi - lo) : 0; for (let i = 0; i < N; i++) arr[i] = (lab[i * 3 + ch] - lo) * sc;
        const c8 = bin8(arr), e = M(new cv.Mat()); cv.Canny(c8, e, 30, 90); dil(e, 2);
      }
      /* Otsu (sáng / tối) */
      const o = M(new cv.Mat()), oi = M(new cv.Mat()); cv.threshold(gc, o, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU); cv.bitwise_not(o, oi); bins.push(o, oi);
      /* Khác màu nền (lấy mẫu ở viền ảnh) */
      const bd = [[], [], []], pushPx = i => { for (let c = 0; c < 3; c++) bd[c].push(lab[i * 3 + c]); };
      for (let y = 0; y < 6; y++) for (let x = 0; x < w; x++) { pushPx(y * w + x); pushPx((h - 1 - y) * w + x); }
      for (let x = 0; x < 6; x++) for (let y = 6; y < h - 6; y++) { pushPx(y * w + x); pushPx(y * w + (w - 1 - x)); }
      const bm = bd.map(a => { a.sort((x, y) => x - y); return a[a.length >> 1]; }), dist = new Uint8Array(N);
      for (let i = 0; i < N; i++) dist[i] = Math.min(255, Math.hypot(lab[i * 3] - bm[0], lab[i * 3 + 1] - bm[1], lab[i * 3 + 2] - bm[2]) * 6);
      const d8 = bin8(dist), d2 = M(new cv.Mat()); cv.threshold(d8, d2, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(d2, d2, cv.MORPH_CLOSE, M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7)))); bins.push(d2);

      let best = null; const seen = new Set();
      for (const bm0 of bins) {
        const cs = M(new cv.MatVector()), hi = M(new cv.Mat());
        cv.findContours(bm0, cs, hi, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < cs.size(); i++) {
          const c = M(cs.get(i)); if (cv.contourArea(c) < N * .08) continue;
          const hull = M(new cv.Mat()); cv.convexHull(c, hull, false, true);
          const peri = cv.arcLength(hull, true); let quad = null;
          for (const eps of [.015, .02, .03, .045, .06]) {
            const ap = M(new cv.Mat()); cv.approxPolyDP(hull, ap, peri * eps, true);
            if (ap.rows === 4) { quad = []; for (let j = 0; j < 4; j++) quad.push([ap.data32S[j * 2], ap.data32S[j * 2 + 1]]); break; }
          }
          if (!quad) {
            const bx = cv.RotatedRect.points(cv.minAreaRect(hull)).map(p => [p.x, p.y]);
            if (cv.contourArea(hull) / Math.max(1, polyArea(bx)) > .85) quad = bx;
          }
          if (!quad) continue;
          quad = orderQuad(quad); const area = polyArea(quad);
          if (area < N * .1 || area > N * .95 || !convexQuad(quad)) continue;
          const key = quad.map(p => Math.round(p[0] / 3) + ',' + Math.round(p[1] / 3)).join(';'); if (seen.has(key)) continue; seen.add(key);
          const sp = labSupport(quad, lab, w, h); if (sp.min < .45) continue;
          const score = sp.s * Math.pow(area / N, .35);
          if (!best || score > best.score) best = { quad, score };
        }
      }
      if (!best) return null;
      return refineQuad(best.quad, lab, w, h);
    } catch (e) { return null; }
    finally { mats.forEach(m => { try { m.delete(); } catch (e) { /* bỏ qua */ } }); }
  }

  const api = { findQuad, findQuadCV, warp, pdf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Scanner = api;
})(typeof window !== 'undefined' ? window : globalThis);
