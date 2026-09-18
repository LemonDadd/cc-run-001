/* ===== 共享颜色数学与工具函数（CPU 渲染器 / 取色器 / 曲线 LUT 使用） ===== */
window.CK = window.CK || {};
(function () {
  const CK = window.CK;

  CK.clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };

  CK.smoothstep = function (e0, e1, x) {
    const t = CK.clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };

  CK.hexToRgb01 = function (hex) {
    let h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };

  CK.rgbToHex = function (r, g, b) {
    const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  };

  CK.lum = function (r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; };

  /* BT.601 全幅 YUV，u/v 以 0.5 为中心 —— 与 GLSL 中的实现保持一致 */
  CK.rgbToYuv = function (r, g, b) {
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    return [y, 0.5 + (b - y) * 0.564, 0.5 + (r - y) * 0.713];
  };

  CK.rgbToHsv = function (r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 1e-6) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return [h, mx > 1e-6 ? d / mx : 0, mx];
  };

  /* 预计算键色在各空间的表示（CPU 逐像素循环外提效） */
  CK.prepKey = function (hexColor) {
    const [r, g, b] = CK.hexToRgb01(hexColor);
    const yuv = CK.rgbToYuv(r, g, b);
    const hsv = CK.rgbToHsv(r, g, b);
    return {
      rgb: [r, g, b],
      yuv,
      hsv,
      hvx: Math.cos(hsv[0] * Math.PI * 2) * hsv[1],
      hvy: Math.sin(hsv[0] * Math.PI * 2) * hsv[1],
    };
  };

  /* 键色距离 —— 必须与 shaders.js 中 keyDist() 保持同一公式 */
  CK.keyDist = function (r, g, b, key, space) {
    if (space === 'rgb') {
      const dr = r - key.rgb[0], dg = g - key.rgb[1], db = b - key.rgb[2];
      return Math.sqrt(dr * dr + dg * dg + db * db) / 1.7320508;
    }
    if (space === 'yuv') {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const u = 0.5 + (b - y) * 0.564, v = 0.5 + (r - y) * 0.713;
      const dy = (y - key.yuv[0]) * 0.5, du = u - key.yuv[1], dv = v - key.yuv[2];
      return Math.sqrt(dy * dy + du * du + dv * dv) / 1.5;
    }
    // hsv：色相-饱和度向量距离 + 明度差
    const hsv = CK.rgbToHsv(r, g, b);
    const ax = Math.cos(hsv[0] * Math.PI * 2) * hsv[1];
    const ay = Math.sin(hsv[0] * Math.PI * 2) * hsv[1];
    const d = Math.hypot(ax - key.hvx, ay - key.hvy) * 0.7 + Math.abs(hsv[2] - key.hsv[2]) * 0.3;
    return Math.min(1, d);
  };

  /* 由分段线性控制点构建 256 级曲线 LUT */
  CK.buildCurveLUT = function (points) {
    const pts = (points && points.length >= 2 ? points : [[0, 0], [1, 1]])
      .slice().sort((a, b) => a[0] - b[0]);
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let y;
      if (x <= pts[0][0]) y = pts[0][1];
      else if (x >= pts[pts.length - 1][0]) y = pts[pts.length - 1][1];
      else {
        for (let s = 0; s < pts.length - 1; s++) {
          const a = pts[s], b = pts[s + 1];
          if (x >= a[0] && x <= b[0]) {
            const t = (x - a[0]) / Math.max(1e-6, b[0] - a[0]);
            y = a[1] + (b[1] - a[1]) * t;
            break;
          }
        }
      }
      lut[i] = Math.round(CK.clamp01(y) * 255);
    }
    return lut;
  };

  /* 对象路径读写：'key.similarity' */
  CK.getPath = function (obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  };
  CK.setPath = function (obj, path, value) {
    const ks = path.split('.');
    let t = obj;
    for (let i = 0; i < ks.length - 1; i++) t = t[ks[i]];
    t[ks[ks.length - 1]] = value;
  };

  CK.deepClone = function (o) { return JSON.parse(JSON.stringify(o)); };

  /* 将 patch 深合并到 base（数组整体替换） */
  CK.deepMerge = function (base, patch) {
    for (const k of Object.keys(patch || {})) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        CK.deepMerge(base[k], v);
      } else {
        base[k] = v;
      }
    }
    return base;
  };

  CK.download = function (filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };

  CK.fmtTime = function (sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };
})();
