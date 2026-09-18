/* ===== CPU Canvas 回退渲染器 =====
 * 与 WebGL 管线相同的处理阶段，全部在 JS + TypedArray 上实现。
 * 为保证实时性：形态学半径限制 ≤4px，高斯以盒式模糊近似。
 */
window.CK = window.CK || {};
(function () {
  const CK = window.CK;

  class CPURenderer {
    constructor(canvas) {
      this.kind = 'cpu';
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.work = document.createElement('canvas');       // 视频帧抓取
      this.wctx = this.work.getContext('2d', { willReadFrequently: true });
      this.bgCanvas = document.createElement('canvas');   // 背景绘制
      this.bctx = this.bgCanvas.getContext('2d', { willReadFrequently: true });
      this.pw = 2; this.ph = 2;
      this.maskW = 320; this.maskH = 180;
      this.alpha = null;   // 当前 alpha 平面
      this.tmpA = null;    // 形态学临时
      this.origA = null;   // 半透明保留用的原始 alpha
      this.lut = null;
      this.bgCache = null; // {key, data}
      this.gpuMs = 0;
    }

    setSize(vw, vh, scale) {
      const pw = Math.max(16, Math.round(vw * scale));
      const ph = Math.max(16, Math.round(vh * scale));
      if (pw === this.pw && ph === this.ph) return;
      this.pw = pw; this.ph = ph;
      this.canvas.width = pw; this.canvas.height = ph;
      this.work.width = pw; this.work.height = ph;
      this.bgCanvas.width = pw; this.bgCanvas.height = ph;
      const n = pw * ph;
      this.alpha = new Uint8ClampedArray(n);
      this.tmpA = new Uint8ClampedArray(n);
      this.origA = new Uint8ClampedArray(n);
      this.maskW = 320;
      this.maskH = Math.max(2, Math.round((320 * ph) / pw));
      this.bgCache = null;
    }

    updateCurve(points) { this.lut = CK.buildCurveLUT(points); }

    /* 可分离形态学：mode 0=腐蚀(min) 1=膨胀(max)，半径≤4 */
    morph(radius, mode) {
      const w = this.pw, h = this.ph, src = this.alpha, tmp = this.tmpA;
      const r = Math.min(4, Math.max(1, Math.round(radius)));
      const pick = mode === 0 ? Math.min : Math.max;
      // 水平
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          let v = src[row + x];
          for (let k = 1; k <= r; k++) {
            v = pick(v, pick(src[row + Math.max(0, x - k)], src[row + Math.min(w - 1, x + k)]));
          }
          tmp[row + x] = v;
        }
      }
      // 垂直
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          let v = tmp[row + x];
          for (let k = 1; k <= r; k++) {
            v = pick(v, pick(tmp[Math.max(0, y - k) * w + x], tmp[Math.min(h - 1, y + k) * w + x]));
          }
          src[row + x] = v;
        }
      }
    }

    /* 3x3 中值滤波（噪点抑制） */
    median(strength) {
      const w = this.pw, h = this.ph, src = this.alpha, tmp = this.tmpA;
      const win = new Array(9);
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - 1) * w, y1 = y * w, y2 = Math.min(h - 1, y + 1) * w;
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - 1), x2 = Math.min(w - 1, x + 1);
          win[0] = src[y0 + x0]; win[1] = src[y0 + x]; win[2] = src[y0 + x2];
          win[3] = src[y1 + x0]; win[4] = src[y1 + x]; win[5] = src[y1 + x2];
          win[6] = src[y2 + x0]; win[7] = src[y2 + x]; win[8] = src[y2 + x2];
          win.sort((a, b) => a - b);
          tmp[y1 + x] = src[y1 + x] + (win[4] - src[y1 + x]) * strength;
        }
      }
      src.set(tmp);
    }

    /* 盒式模糊（高斯近似），半径≤4 */
    boxBlur(radius) {
      const w = this.pw, h = this.ph, src = this.alpha, tmp = this.tmpA;
      const r = Math.min(4, Math.max(1, Math.round(radius)));
      const norm = 1 / (2 * r + 1);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let k = -r; k <= r; k++) s += src[row + Math.min(w - 1, Math.max(0, x + k))];
          tmp[row + x] = s * norm;
        }
      }
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
          src[row + x] = s * norm;
        }
      }
    }

    /* 背景像素准备（带缓存） */
    prepareBG(frame) {
      const p = frame.params, pw = this.pw, ph = this.ph;
      const bg = p.bg;
      const animated = bg.type === 'video' || bg.type === 'blur';
      const cacheKey = [bg.type, bg.color, bg.scale, bg.offsetX, bg.offsetY, bg.blurAmount, pw, ph,
        bg.type === 'image' && frame.bgImage ? frame.bgImage.src : ''].join('|');
      if (!animated && this.bgCache && this.bgCache.key === cacheKey) return this.bgCache.data;

      const ctx = this.bctx;
      ctx.filter = 'none';
      ctx.fillStyle = bg.color;
      ctx.fillRect(0, 0, pw, ph);

      let src = null, bw = 0, bh = 0;
      if (bg.type === 'image' && frame.bgImage && frame.bgImage.width) {
        src = frame.bgImage; bw = src.width; bh = src.height;
      } else if (bg.type === 'video' && frame.bgVideo && frame.bgVideo.readyState >= 2 && frame.bgVideo.videoWidth) {
        src = frame.bgVideo; bw = src.videoWidth; bh = src.videoHeight;
      } else if (bg.type === 'blur') {
        src = frame.video; bw = src.videoWidth; bh = src.videoHeight;
      }
      if (src) {
        const s = Math.max(pw / bw, ph / bh) * bg.scale;
        const dw = bw * s, dh = bh * s;
        const dx = (pw - dw) / 2 + bg.offsetX * pw;
        const dy = (ph - dh) / 2 - bg.offsetY * ph;
        if (bg.type === 'blur' && bg.blurAmount > 0) {
          try { ctx.filter = 'blur(' + bg.blurAmount + 'px)'; } catch (e) { /* 老内核不支持则保持清晰 */ }
          const pad = bg.blurAmount * 2;
          ctx.drawImage(src, dx - pad, dy - pad, dw + pad * 2, dh + pad * 2);
          ctx.filter = 'none';
        } else {
          ctx.drawImage(src, dx, dy, dw, dh);
        }
      }
      const data = ctx.getImageData(0, 0, pw, ph).data;
      if (!animated) this.bgCache = { key: cacheKey, data };
      return data;
    }

    render(frame) {
      const p = frame.params, pw = this.pw, ph = this.ph;
      // 抓取视频帧
      this.wctx.drawImage(frame.video, 0, 0, pw, ph);
      const img = this.wctx.getImageData(0, 0, pw, ph);
      const d = img.data;
      const n = pw * ph;
      const alpha = this.alpha;

      const key = CK.prepKey(p.key.color);
      const space = p.key.space;
      const e0 = p.key.similarity - p.key.smoothness - p.key.feather * 0.5;
      const e1 = p.key.similarity + p.key.smoothness + p.key.feather * 0.5;
      const shrinkK = p.key.shrink * 0.5;
      const spillType = frame.spillType, ss = p.spill.strength, edgeC = p.spill.edgeCorrect;
      const g = p.grade;
      const lut = this.lut;
      // 色彩匹配 / 光照统一系数（循环外预计算，与 GLSL 中 clamp(ratio,0.5,2) 一致）
      const clampRatio = (v) => Math.min(2, Math.max(0.5, v));
      const cm = p.bg.colorMatch * 0.6;
      const cmR = 1 + (clampRatio(frame.bgAvg[0] / Math.max(0.03, frame.fgAvg[0])) - 1) * cm;
      const cmG = 1 + (clampRatio(frame.bgAvg[1] / Math.max(0.03, frame.fgAvg[1])) - 1) * cm;
      const cmB = 1 + (clampRatio(frame.bgAvg[2] / Math.max(0.03, frame.fgAvg[2])) - 1) * cm;
      const lf = CK.lum(frame.fgAvg[0], frame.fgAvg[1], frame.fgAvg[2]);
      const lb = CK.lum(frame.bgAvg[0], frame.bgAvg[1], frame.bgAvg[2]);
      const lu = 1 + (clampRatio(lb / Math.max(0.03, lf)) - 1) * p.grade.lightUnify * 0.7;
      const bypass = frame.bypass;

      for (let i = 0; i < n; i++) {
        const j = i * 4;
        let r = d[j] / 255, gg = d[j + 1] / 255, b = d[j + 2] / 255;
        let a = 1;
        if (!bypass) {
          const dist = CK.keyDist(r, gg, b, key, space);
          a = CK.smoothstep(e0, e1, dist);
          a = CK.clamp01((a - shrinkK) / Math.max(1e-3, 1 - shrinkK));
          // 溢色抑制
          let excess = 0;
          if (spillType === 1) { excess = Math.max(0, gg - Math.max(r, b)); gg -= excess * ss; }
          else if (spillType === 2) { excess = Math.max(0, b - Math.max(r, gg)); b -= excess * ss; }
          let lum = 0.299 * r + 0.587 * gg + 0.114 * b;
          const ds = Math.min(1, excess * 2) * ss * 0.5;
          r += (lum - r) * ds; gg += (lum - gg) * ds; b += (lum - b) * ds;
          // 边缘颜色校正
          const edge = CK.smoothstep(0.02, 0.4, a) * (1 - CK.smoothstep(0.6, 0.98, a));
          const ec = edge * edgeC * 0.6;
          lum = 0.299 * r + 0.587 * gg + 0.114 * b;
          r += (lum - r) * ec; gg += (lum - gg) * ec; b += (lum - b) * ec;
          // 调色
          r += g.brightness; gg += g.brightness; b += g.brightness;
          r = (r - 0.5) * g.contrast + 0.5;
          gg = (gg - 0.5) * g.contrast + 0.5;
          b = (b - 0.5) * g.contrast + 0.5;
          const l2 = 0.299 * r + 0.587 * gg + 0.114 * b;
          r = l2 + (r - l2) * g.saturation;
          gg = l2 + (gg - l2) * g.saturation;
          b = l2 + (b - l2) * g.saturation;
          r += g.temperature * 0.08; b -= g.temperature * 0.08; gg += g.tint * 0.06;
          r = lut[Math.round(CK.clamp01(r) * 255)] / 255;
          gg = lut[Math.round(CK.clamp01(gg) * 255)] / 255;
          b = lut[Math.round(CK.clamp01(b) * 255)] / 255;
          r *= cmR; gg *= cmG; b *= cmB;
          r *= lu; gg *= lu; b *= lu;
        }
        d[j] = CK.clamp01(r) * 255;
        d[j + 1] = CK.clamp01(gg) * 255;
        d[j + 2] = CK.clamp01(b) * 255;
        alpha[i] = a * 255;
      }

      // 遮罩后处理
      const m = p.mask;
      if (!bypass) {
        const morphActive = m.erode > 0.05 || m.dilate > 0.05 || m.blur > 0.05 || m.noise > 0.01;
        const needOrig = m.keepSemi > 0.001 && morphActive;
        if (needOrig) this.origA.set(alpha);
        if (m.erode > 0.05) this.morph(m.erode, 0);
        if (m.dilate > 0.05) this.morph(m.dilate, 1);
        if (m.noise > 0.01) this.median(m.noise);
        if (m.blur > 0.05) this.boxBlur(m.blur);
        if (needOrig) {
          const keep = m.keepSemi;
          for (let i = 0; i < n; i++) {
            const oa = this.origA[i] / 255;
            const band = CK.smoothstep(0.02, 0.4, oa) * (1 - CK.smoothstep(0.6, 0.98, oa));
            alpha[i] = alpha[i] + (this.origA[i] - alpha[i]) * keep * band;
          }
        }
      } else {
        alpha.fill(255);
      }

      // 背景合成
      const bg = this.prepareBG(frame);
      for (let i = 0; i < n; i++) {
        const j = i * 4;
        const a = alpha[i] / 255, ia = 1 - a;
        d[j] = d[j] * a + bg[j] * ia;
        d[j + 1] = d[j + 1] * a + bg[j + 1] * ia;
        d[j + 2] = d[j + 2] * a + bg[j + 2] * ia;
        d[j + 3] = 255;
      }
      this.ctx.putImageData(img, 0, 0);
    }

    readMask() {
      if (!this.alpha) return null;
      const w = this.maskW, h = this.maskH;
      const out = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const sy = Math.min(this.ph - 1, Math.floor((y / h) * this.ph));
        for (let x = 0; x < w; x++) {
          const sx = Math.min(this.pw - 1, Math.floor((x / w) * this.pw));
          const v = this.alpha[sy * this.pw + sx];
          const o = (y * w + x) * 4;
          out[o] = out[o + 1] = out[o + 2] = v;
          out[o + 3] = 255;
        }
      }
      return { data: out, width: w, height: h };
    }

    dispose() {}
  }

  CK.CPURenderer = CPURenderer;
})();
