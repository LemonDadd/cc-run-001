// CPU 2D Canvas 回退引擎：与 GLEngine 相同的接口，纯 JS 逐像素处理
// 为保证实时性，工作分辨率限制在约 360p 以内
import { paneToUv } from '../layout.js';

export class CPUEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bgImageEl = null;
    this.bgVideoEl = null;
    this.matchExp = 1; this.matchTint = [1, 1, 1];
    this.frameNo = 0;
    this.gpuMs = null;
    this.histogram = new Array(256).fill(0);
    this.workCanvas = document.createElement('canvas');
    this.wctx = this.workCanvas.getContext('2d', { willReadFrequently: true });
    this.bgCanvas = document.createElement('canvas');
    this.bctx = this.bgCanvas.getContext('2d', { willReadFrequently: true });
  }

  setBgImage(img) { this.bgImageEl = img; }
  clearBgImage() { this.bgImageEl = null; }
  setBgVideoElement(v) { this.bgVideoEl = v; }

  render(video, params, layout) {
    const t0 = performance.now();
    this.frameNo++;
    let passes = 0;

    // 工作分辨率：取视频尺寸 × downscale，长边封顶 480
    const vw = video && video.videoWidth ? video.videoWidth : 640;
    const vh = video && video.videoHeight ? video.videoHeight : 360;
    let w = Math.round(vw * params.quality.downscale);
    let h = Math.round(vh * params.quality.downscale);
    const maxSide = 480;
    if (Math.max(w, h) > maxSide) {
      const k = maxSide / Math.max(w, h);
      w = Math.round(w * k); h = Math.round(h * k);
    }
    this.workW = w; this.workH = h;

    // 1) 采集场景
    this.workCanvas.width = w; this.workCanvas.height = h;
    const ctx = this.wctx;
    if (video && video.videoWidth) {
      ctx.drawImage(video, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#06080c'; ctx.fillRect(0, 0, w, h);
    }
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    passes++;

    // 2) 背景准备（预渲染到工作尺寸，供逐像素索引）
    let bgData = null;
    const bgPre = this._prepareBackground(params, w, h);
    if (bgPre) { bgData = bgPre; passes += 3; }

    // 3) 色度键 + 溢色 + 调色（逐像素，输出到 alpha）
    const alpha = new Uint8ClampedArray(w * h);
    const keyColor = params.key.color.map((c) => c * 255);
    const [kru, kgu] = this._toYUV(keyColor[0], keyColor[1], keyColor[2]);
    const khsv = this._rgb2hsv(keyColor[0], keyColor[1], keyColor[2]);
    for (let p = 0, i = 0; i < d.length; i += 4, p++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      let dist;
      if (params.key.mode === 'YUV') {
        const [u, v] = this._toYUV(r, g, b);
        dist = Math.hypot(u - kru, v - kgu) * 1.8;
      } else if (params.key.mode === 'HSV') {
        const hh = this._rgb2hsv(r, g, b);
        let dh = Math.abs(hh[0] - khsv[0]);
        dh = Math.min(dh, 1 - dh);
        dist = dh * 2.2 * 255 + Math.max(khsv[1] - hh[1], 0) * 0.25 * 255;
      } else {
        dist = Math.hypot((r - keyColor[0]) * 1.2,
                          (g - keyColor[1]),
                          (b - keyColor[2]) * 0.8);
      }
      const t = params.key.threshold * 255;
      const sm = params.key.smoothness * 255;
      let a = (dist - (t - sm)) / (2 * sm);
      alpha[p] = Math.max(0, Math.min(255, a * 255));
    }
    passes++;

    // 4) 形态学 / 收缩
    let a = alpha;
    const morph = (src, mode) => {
      const out = new Uint8ClampedArray(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          let val = src[idx];
          for (let dy = -1; dy <= 1; dy++) {
            const yy = Math.max(0, Math.min(h - 1, y + dy));
            for (let dx = -1; dx <= 1; dx++) {
              const xx = Math.max(0, Math.min(w - 1, x + dx));
              const v2 = src[yy * w + xx];
              val = mode === 0 ? Math.min(val, v2) : Math.max(val, v2);
            }
          }
          out[idx] = val;
        }
      }
      return out;
    };
    const totalMorph = params.mask.erode + params.key.shrink;
    for (let i = 0; i < totalMorph; i++) { a = morph(a, 0); passes++; }
    for (let i = 0; i < params.mask.dilate; i++) { a = morph(a, 1); passes++; }

    // 5) 盒式模糊（近似高斯）作用于 alpha
    for (let it = 0; it < params.mask.blur; it++) {
      a = this._boxBlurAlpha(a, w, h); passes++;
    }

    // 6) 遮罩精修：羽化 / 降噪 / 半透明保留
    const featherW = Math.max(1, params.key.feather * 11);
    const dn = params.mask.denoise;
    const refined = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        let val = a[idx];
        if (dn > 0.001) {
          let sum = 0, cnt = 0, m = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = Math.max(0, Math.min(h - 1, y + dy));
            for (let dx = -1; dx <= 1; dx++) {
              const xx = Math.max(0, Math.min(w - 1, x + dx));
              sum += a[yy * w + xx]; cnt++;
            }
          }
          m = sum / cnt;
          val = val + (m - val) * dn * 0.55;
          const snap = dn * 30;
          const semi = val > 46 && val < 209;
          if (!(params.mask.preserveSemi && semi)) {
            if (val < snap) val = 0;
            else if (val > 255 - snap) val = 255;
          }
        }
        if (featherW > 1) {
          val = Math.max(0, Math.min(255, ((val - 127.5) / featherW + 0.5) * 255));
        }
        refined[idx] = val;
      }
    }
    a = refined; passes++;

    // 7) 溢色 + 调色 + 合成（合一处理）
    const out = ctx.createImageData(w, h);
    const od = out.data;
    const s = params.spill, g = params.grade;
    const bgc = params.background.color;
    const cc = 1 + g.contrast;
    const gamma = 1 / Math.max(g.curve, 0.05);
    const link = s.linkGrade ? 0.85 : 1;
    const expMul = g.lightMatch ? (1 + (this.matchExp - 1) * link) : 1;
    const tintArr = params.background.colorMatch ? this.matchTint : [1, 1, 1];
    for (let p = 0, i = 0; i < od.length; i += 4, p++) {
      let r = d[i], gg = d[i + 1], b = d[i + 2];
      const aa = a[p] / 255;

      // 溢色
      if (s.channel === 'green') {
        const edge = 1 - Math.min(1, Math.abs(aa - 0.5) * 4);
        const wgt = Math.min(1, s.strength * (1 - aa) + edge * s.edgeColor * 0.6);
        const gx = Math.max(gg - Math.max(r, b), 0);
        gg -= gx * s.strength;
        r += gx * 0.12 * s.strength; b += gx * 0.12 * s.strength;
        const nr = d[i] + (r - d[i]) * wgt;
        const ng = d[i + 1] + (gg - d[i + 1]) * wgt;
        const nb = d[i + 2] + (b - d[i + 2]) * wgt;
        r = nr; gg = ng; b = nb;
      } else if (s.channel === 'blue') {
        const edge = 1 - Math.min(1, Math.abs(aa - 0.5) * 4);
        const wgt = Math.min(1, s.strength * (1 - aa) + edge * s.edgeColor * 0.6);
        const bx = Math.max(b - Math.max(r, gg), 0);
        b -= bx * s.strength;
        r += bx * 0.1 * s.strength; gg += bx * 0.1 * s.strength;
        const nr = d[i] + (r - d[i]) * wgt;
        const ng = d[i + 1] + (gg - d[i + 1]) * wgt;
        const nb = d[i + 2] + (b - d[i + 2]) * wgt;
        r = nr; gg = ng; b = nb;
      }

      // 调色
      r = (r + g.temperature * 20 - g.tint * 10);
      b = (b - g.temperature * 20 - g.tint * 20);
      gg = gg + g.tint * 20;
      r += g.brightness * 255; gg += g.brightness * 255; b += g.brightness * 255;
      r = (r - 127.5) * cc + 127.5;
      gg = (gg - 127.5) * cc + 127.5;
      b = (b - 127.5) * cc + 127.5;
      const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
      r = lum + (r - lum) * g.saturation;
      gg = lum + (gg - lum) * g.saturation;
      b = lum + (b - lum) * g.saturation;
      r = 255 * Math.pow(Math.max(0, Math.min(255, r)) / 255, gamma);
      gg = 255 * Math.pow(Math.max(0, Math.min(255, gg)) / 255, gamma);
      b = 255 * Math.pow(Math.max(0, Math.min(255, b)) / 255, gamma);
      r *= expMul * (1 + (tintArr[0] - 1) * link);
      gg *= expMul * (1 + (tintArr[1] - 1) * link);
      b *= expMul * (1 + (tintArr[2] - 1) * link);

      // 背景取样
      let br, bg, bb;
      if (params.key.outputAlpha) {
        od[i] = od[i + 1] = od[i + 2] = aa * 255; od[i + 3] = 255; continue;
      }
      const m = params.background.mode;
      if (m === 'solid') {
        br = bgc[0] * 255; bg = bgc[1] * 255; bb = bgc[2] * 255;
      } else if (m === 'blur' || m === 'image' || m === 'video') {
        if (bgData) { br = bgData[i]; bg = bgData[i + 1]; bb = bgData[i + 2]; }
        else { br = bgc[0] * 255; bg = bgc[1] * 255; bb = bgc[2] * 255; }
      } else {
        br = bgc[0] * 255; bg = bgc[1] * 255; bb = bgc[2] * 255;
      }
      od[i] = r * aa + br * (1 - aa);
      od[i + 1] = gg * aa + bg * (1 - aa);
      od[i + 2] = b * aa + bb * (1 - aa);
      od[i + 3] = 255;
    }
    passes++;

    // 统计
    if (this.frameNo % 30 === 0) this._updateStats(a, od, w, h);
    // 直方图
    if (this.frameNo % 12 === 0) {
      const bins = new Array(256).fill(0);
      for (let i = 0; i < a.length; i++) bins[a[i]]++;
      this.histogram = bins;
    }

    // 三路视口绘制
    const c = this.canvas, gctx = this.ctx;
    c.width = layout.W; c.height = layout.H;
    gctx.fillStyle = '#000'; gctx.fillRect(0, 0, layout.W, layout.H);
    this.maskCanvas = this.maskCanvas || document.createElement('canvas');
    this.maskCanvas.width = w; this.maskCanvas.height = h;
    const mctx = this.maskCanvas.getContext('2d');
    const mimg = mctx.createImageData(w, h);
    for (let i = 0; i < mimg.data.length; i += 4) {
      const v = a[i / 4];
      mimg.data[i] = mimg.data[i + 1] = mimg.data[i + 2] = v;
      mimg.data[i + 3] = 255;
    }
    mctx.putImageData(mimg, 0, 0);
    this.compCanvas = this.compCanvas || document.createElement('canvas');
    if (this.compCanvas.width !== w || this.compCanvas.height !== h) {
      this.compCanvas.width = w; this.compCanvas.height = h;
    }
    this.compCanvas.getContext('2d').putImageData(out, 0, 0);
    const compCanvas = this.compCanvas;
    this.origCanvas = this.workCanvas;

    const paneAspect = layout.panes[0].w / layout.panes[0].h;
    const drawCover = (src, pane) => {
      const sa = w / h;
      let dw, dh, dx, dy;
      if (sa > paneAspect) { dh = pane.h; dw = dh * sa; dx = pane.x - (dw - pane.w) / 2; dy = pane.y; }
      else { dw = pane.w; dh = dw / sa; dy = pane.y - (dh - pane.h) / 2; dx = pane.x; }
      gctx.drawImage(src, dx, dy, dw, dh);
    };
    for (let i = 0; i < 3; i++) {
      const pn = layout.panes[i];
      gctx.save();
      gctx.beginPath(); gctx.rect(pn.x, pn.y, pn.w, pn.h); gctx.clip();
      if (i === 0) drawCover(this.workCanvas, pn);
      else if (i === 1) drawCover(this.maskCanvas, pn);
      else drawCover(compCanvas, pn);
      gctx.restore();
      if (i < 2) { gctx.strokeStyle = '#222'; gctx.strokeRect(pn.x, pn.y, pn.w, pn.h); }
    }
    passes += 3;

    return {
      cpuMs: performance.now() - t0,
      gpuMs: null,
      passes,
      workW: w, workH: h,
      histogram: this.histogram,
    };
  }

  // 将背景（图片/视频/模糊场景）按 cover + scale + offset 绘制到工作尺寸
  _prepareBackground(params, w, h) {
    const mode = params.background.mode;
    let el = null;
    if (mode === 'image' && this.bgImageEl &&
        (this.bgImageEl.naturalWidth || this.bgImageEl.width)) el = this.bgImageEl;
    if (mode === 'video' && this.bgVideoEl && this.bgVideoEl.videoWidth) el = this.bgVideoEl;

    if (mode === 'blur') {
      // 多级缩小放大制造强模糊
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tc = tmp.getContext('2d');
      tc.imageSmoothingEnabled = true;
      this.bgCanvas.width = Math.max(2, Math.round(w / 10));
      this.bgCanvas.height = Math.max(2, Math.round(h / 10));
      this.bctx.drawImage(this.workCanvas, 0, 0, this.bgCanvas.width, this.bgCanvas.height);
      tc.drawImage(this.bgCanvas, 0, 0, w, h);
      this.bgCanvas.width = Math.max(2, Math.round(w / 5));
      this.bgCanvas.height = Math.max(2, Math.round(h / 5));
      this.bctx.drawImage(tmp, 0, 0, this.bgCanvas.width, this.bgCanvas.height);
      tc.drawImage(this.bgCanvas, 0, 0, w, h);
      return tc.getImageData(0, 0, w, h).data;
    }

    if (!el) return null;
    const ew = el.videoWidth || el.naturalWidth;
    const eh = el.videoHeight || el.naturalHeight;
    this.bgCanvas.width = w; this.bgCanvas.height = h;
    const c = this.bctx;
    c.fillStyle = '#111'; c.fillRect(0, 0, w, h);
    c.imageSmoothingEnabled = true;
    // cover 基准 + scale/offset
    const sa = ew / eh, ta = w / h, scale = params.background.scale;
    let dw, dh;
    if (sa > ta) { dh = h; dw = h * sa; } else { dw = w; dh = w / sa; }
    dw *= scale; dh *= scale;
    const dx = (w - dw) / 2 + params.background.offsetX * w;
    const dy = (h - dh) / 2 + params.background.offsetY * h;
    // 2D drawImage 对图片/视频均按正立绘制，无需翻转
    c.drawImage(el, dx, dy, dw, dh);
    return c.getImageData(0, 0, w, h).data;
  }

  _boxBlurAlpha(a, w, h) {
    const tmp = new Uint8ClampedArray(w * h);
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -1; k <= 1; k++) {
          const xx = Math.max(0, Math.min(w - 1, x + k));
          s += a[y * w + xx];
        }
        tmp[y * w + x] = s / 3;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -1; k <= 1; k++) {
          const yy = Math.max(0, Math.min(h - 1, y + k));
          s += tmp[yy * w + x];
        }
        out[y * w + x] = s / 3;
      }
    }
    return out;
  }

  _toYUV(r, g, b) {
    return [
      -0.168736 * r - 0.331264 * g + 0.5 * b + 127.5,
      0.5 * r - 0.418688 * g - 0.081312 * b + 127.5,
    ];
  }

  _rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6; if (h < 0) h += 1;
    }
    return [h, mx === 0 ? 0 : d / mx, mx];
  }

  _updateStats(alpha, outData, w, h) {
    let rS = 0, gS = 0, bS = 0, aS = 0;
    for (let p = 0, i = 0; i < outData.length; i += 4, p++) {
      const aw = alpha[p];
      // outData 已是合成结果，前景色无法分离，用覆盖度加权统计近似前景亮度
      rS += outData[i] * aw;
      gS += outData[i + 1] * aw;
      bS += outData[i + 2] * aw;
      aS += aw;
    }
    if (aS < 4000) return;
    const fR = (rS / aS) * 255, fG = (gS / aS) * 255, fB = (bS / aS) * 255;
    // 背景近似：合成图中低 alpha 区域
    let br = 0, bg = 0, bb = 0, bn = 0;
    for (let p = 0, i = 0; i < outData.length; i += 4, p++) {
      if (alpha[p] < 40) { br += outData[i]; bg += outData[i + 1]; bb += outData[i + 2]; bn++; }
    }
    if (!bn) return;
    br /= bn; bg /= bn; bb /= bn;
    const exp = Math.min(2, Math.max(0.5,
      (0.299 * br + 0.587 * bg + 0.114 * bb) /
      (0.299 * fR + 0.587 * fG + 0.114 * fB + 1)));
    this.matchExp += (exp - this.matchExp) * 0.5;
    const tint = [
      Math.min(1.6, Math.max(0.6, br / (fR + 1))),
      Math.min(1.6, Math.max(0.6, bg / (fG + 1))),
      Math.min(1.6, Math.max(0.6, bb / (fB + 1))),
    ];
    this.matchTint = this.matchTint.map((v, i) => v + (tint[i] - v) * 0.5);
  }

  pickOriginal(nx, ny, workAspect, paneAspect) {
    const [u, v] = paneToUv(nx, ny, workAspect, paneAspect);
    const x = Math.max(0, Math.min(this.workW - 1, Math.round(u * this.workW)));
    const y = Math.max(0, Math.min(this.workH - 1, Math.round(v * this.workH)));
    const d = this.wctx.getImageData(x, y, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255];
  }
}
