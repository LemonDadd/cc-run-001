/* ===== 主控编排：渲染循环 / 三路预览 / 对比 / 放大镜 / 性能面板 / 预设与导出 ===== */
window.CK = window.CK || {};
(function () {
  const CK = window.CK;

  /* ---- 默认参数 ---- */
  function defaultParams() {
    return {
      key: { color: '#00b140', space: 'yuv', similarity: 0.32, smoothness: 0.08, shrink: 0.05, feather: 0.06 },
      mask: { erode: 0, dilate: 0, blur: 1, noise: 0.3, keepSemi: 0.5 },
      spill: { type: 'auto', strength: 0.65, edgeCorrect: 0.4 },
      bg: { type: 'color', color: '#20304a', scale: 1, offsetX: 0, offsetY: 0, loop: true, colorMatch: 0.3, blurAmount: 12 },
      grade: {
        brightness: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, lightUnify: 0,
        curve: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]],
      },
      render: { scale: 1, dynamicQuality: true },
    };
  }

  const S = (CK.state = {
    params: defaultParams(),
    mode: 'webgl',
    renderer: null,
    renderScale: 1,        // 动态质量调节后的实际值
    bypass: false,
    compareMode: 'off',    // off | wipe | split
    comparePos: 0.5,
    magnifier: false,
    eyedropper: false,
    vw: 0, vh: 0, appliedScale: 0,
    frameCount: 0,
    fgAvg: [0.5, 0.5, 0.5],
    lastAvg: 0, lastPerfUI: 0, lastInfo: 0, lastDQ: 0,
  });

  const els = {};
  const $ = (id) => document.getElementById(id);

  /* ================= 状态提示 ================= */
  function setStatus(msg, type) {
    const bar = els.statusBar;
    bar.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    bar.className = type || '';
  }

  /* ================= 渲染器管理 ================= */
  function setRenderer(mode) {
    try {
      if (S.renderer) S.renderer.dispose();
      const old = $('canvas-out');
      const canvas = document.createElement('canvas');
      canvas.id = 'canvas-out';
      old.replaceWith(canvas);
      S.renderer = mode === 'webgl' ? new CK.GLRenderer(canvas) : new CK.CPURenderer(canvas);
      S.mode = mode;
      S.renderer.updateCurve(S.params.grade.curve);
      S.appliedScale = 0; // 强制重建尺寸
      els.rendererLabel.textContent = mode === 'webgl' ? 'WebGL2' : 'CPU';
      els.rendererLabel.className = 'badge ' + (mode === 'webgl' ? 'badge-gl' : 'badge-cpu');
      els.btnToggleRenderer.textContent = mode === 'webgl' ? '切换到 CPU' : '切换到 WebGL';
      setStatus('渲染器：' + (mode === 'webgl' ? 'WebGL2 实时渲染' : 'CPU Canvas 回退'), 'ok');
    } catch (err) {
      console.error(err);
      if (mode === 'webgl') {
        setStatus('WebGL2 初始化失败，已回退到 CPU 渲染', 'warn');
        setRenderer('cpu');
      } else {
        setStatus('渲染器初始化失败: ' + err.message, 'err');
      }
    }
  }

  function effectiveScale() {
    const want = S.params.render.scale;
    return Math.min(want, S.renderScale);
  }

  function ensureSize(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = effectiveScale();
    if (vw === S.vw && vh === S.vh && scale === S.appliedScale) return;
    S.vw = vw; S.vh = vh; S.appliedScale = scale;
    S.renderer.setSize(vw, vh, scale);
    // 原始预览（限宽 640 省性能）
    const sw = Math.min(640, vw);
    const sh = Math.round((sw * vh) / vw);
    setCanvas(els.canvasSrc, sw, sh);
    // 遮罩预览
    setCanvas(els.canvasMask, S.renderer.maskW, S.renderer.maskH);
    // 对比层与合成画布同尺寸
    setCanvas(els.canvasCompare, S.renderer.canvas.width, S.renderer.canvas.height);
  }

  function setCanvas(c, w, h) {
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  }

  /* ================= 主循环 ================= */
  function tick(t) {
    requestAnimationFrame(tick);
    const video = els.video;
    if (!video || video.readyState < 2 || !video.videoWidth || !S.renderer) return;
    ensureSize(video);
    const p = S.params;

    // 前景/背景平均色（节流 500ms）
    if (t - S.lastAvg > 500) {
      S.fgAvg = CK.Background.sampleAvg(video);
      CK.Background.updateAvg(p, video);
      S.lastAvg = t;
    }

    const frame = {
      video,
      params: p,
      bypass: S.bypass,
      spillType: resolveSpillType(p),
      bgImage: CK.Background.image,
      bgVideo: p.bg.type === 'video' ? els.bgVideo : null,
      bgAvg: CK.Background.avg,
      fgAvg: S.fgAvg,
    };

    const cpu0 = performance.now();
    S.renderer.render(frame);
    const cpuMs = performance.now() - cpu0;
    CK.Perf.frame(t, cpuMs, S.renderer.gpuMs);

    // 原始画面预览
    const sctx = els.canvasSrc.getContext('2d');
    sctx.drawImage(video, 0, 0, els.canvasSrc.width, els.canvasSrc.height);

    // 遮罩预览 + 直方图（隔帧）
    if (S.frameCount % 2 === 0) updateMaskPreview();
    S.frameCount++;

    // 对比层
    if (S.compareMode !== 'off') drawCompare(video);

    // 面板刷新（节流）
    if (t - S.lastPerfUI > 250) { updatePerfUI(); S.lastPerfUI = t; }
    if (t - S.lastInfo > 1000) { updateInfoUI(); S.lastInfo = t; }
    if (p.render.dynamicQuality && t - S.lastDQ > 600) { dynamicQuality(); S.lastDQ = t; }
  }

  function resolveSpillType(p) {
    if (p.spill.type === 'green') return 1;
    if (p.spill.type === 'blue') return 2;
    const [r, g, b] = CK.hexToRgb01(p.key.color);
    return g >= b ? 1 : 2;
  }

  /* ================= 遮罩预览与直方图 ================= */
  function updateMaskPreview() {
    const m = S.renderer.readMask();
    if (!m || !m.data) return;
    const c = els.canvasMask;
    if (c.width !== m.width || c.height !== m.height) setCanvas(c, m.width, m.height);
    const data = m.data instanceof Uint8ClampedArray ? m.data : new Uint8ClampedArray(m.data);
    c.getContext('2d').putImageData(new ImageData(data, m.width, m.height), 0, 0);
    drawHistogram(data);
  }

  function drawHistogram(data) {
    const bins = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) bins[data[i]]++;
    let max = 1;
    for (let i = 0; i < 256; i++) if (bins[i] > max) max = bins[i];
    const c = els.histogram, ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#2f81f7';
    const bw = w / 256;
    for (let i = 0; i < 256; i++) {
      const bh = Math.sqrt(bins[i] / max) * (h - 2);
      if (bh > 0.5) ctx.fillRect(i * bw, h - bh, Math.max(1, bw), bh);
    }
  }

  /* ================= 对比 / 放大镜 ================= */
  function drawCompare(video) {
    const c = els.canvasCompare;
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    const pos = S.compareMode === 'split' ? 0.5 : S.comparePos;
    c.style.clipPath = 'inset(0 ' + ((1 - pos) * 100).toFixed(2) + '% 0 0)';
    els.compareHandle.style.left = (pos * 100).toFixed(2) + '%';
  }

  function setCompareMode(mode) {
    S.compareMode = mode;
    ['cmpOff', 'cmpWipe', 'cmpSplit'].forEach((k) => els[k].classList.remove('active'));
    els[mode === 'off' ? 'cmpOff' : mode === 'wipe' ? 'cmpWipe' : 'cmpSplit'].classList.add('active');
    const on = mode !== 'off';
    els.canvasCompare.style.display = on ? 'block' : 'none';
    els.compareHandle.style.display = mode === 'wipe' ? 'block' : 'none';
    if (mode === 'split') els.compareHandle.style.display = 'block';
  }

  function setupCompareDrag() {
    const handle = els.compareHandle;
    const wrap = els.compositeWrap;
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = wrap.getBoundingClientRect();
      S.comparePos = CK.clamp01((e.clientX - r.left) / r.width);
      if (S.compareMode === 'split') setCompareMode('wipe'); // 拖动即转为滑动对比
    });
    handle.addEventListener('pointerup', () => { dragging = false; });
  }

  function setupMagnifier() {
    const wrap = els.compositeWrap;
    const mag = els.magnifier;
    const mctx = mag.getContext('2d');
    const ZOOM = 4, SIZE = 150;
    wrap.addEventListener('pointermove', (e) => {
      if (!S.magnifier) { mag.style.display = 'none'; return; }
      const out = $('canvas-out');
      const r = out.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        mag.style.display = 'none';
        return;
      }
      const cx = ((e.clientX - r.left) / r.width) * out.width;
      const cy = ((e.clientY - r.top) / r.height) * out.height;
      const sw = SIZE / ZOOM;
      mctx.imageSmoothingEnabled = false;
      mctx.clearRect(0, 0, SIZE, SIZE);
      mctx.drawImage(out, cx - sw / 2, cy - sw / 2, sw, sw, 0, 0, SIZE, SIZE);
      // 十字线
      mctx.strokeStyle = 'rgba(47,129,247,0.8)';
      mctx.lineWidth = 1;
      mctx.beginPath();
      mctx.moveTo(SIZE / 2, 0); mctx.lineTo(SIZE / 2, SIZE);
      mctx.moveTo(0, SIZE / 2); mctx.lineTo(SIZE, SIZE / 2);
      mctx.stroke();
      // 跟随光标（避免越界）
      const wr = wrap.getBoundingClientRect();
      let lx = e.clientX - wr.left + 18, ly = e.clientY - wr.top + 18;
      if (lx + SIZE > wr.width) lx = e.clientX - wr.left - SIZE - 18;
      if (ly + SIZE > wr.height) ly = e.clientY - wr.top - SIZE - 18;
      mag.style.left = lx + 'px';
      mag.style.top = ly + 'px';
      mag.style.display = 'block';
    });
    wrap.addEventListener('pointerleave', () => { mag.style.display = 'none'; });
  }

  /* ================= 性能面板 / 信息面板 ================= */
  function updatePerfUI() {
    const st = CK.Perf.stats;
    els.perfFps.textContent = st.fps ? st.fps.toFixed(1) + ' fps' : '—';
    els.perfFrame.textContent = st.frameMs ? st.frameMs.toFixed(1) + ' ms' : '—';
    els.perfCpu.textContent = st.cpuMs ? st.cpuMs.toFixed(1) + ' ms' : '—';
    els.perfGpu.textContent = S.mode === 'webgl' && S.renderer.timerExt
      ? st.gpuMs.toFixed(2) + ' ms' : 'N/A';
    els.perfDropped.textContent = String(st.dropped);
    els.perfRes.textContent = S.renderer
      ? S.renderer.pw + '×' + S.renderer.ph + ' (' + Math.round(effectiveScale() * 100) + '%)'
      : '—';
  }

  function updateInfoUI() {
    const info = CK.Sources.getInfo();
    els.infoSource.textContent = info.source;
    els.infoRes.textContent = info.width ? info.width + '×' + info.height : '—';
    els.infoFps.textContent = info.fps ? info.fps.toFixed(1) + ' fps' : '—';
    els.infoColorspace.textContent = info.colorSpace || (info.width ? 'BT.709 (推测)' : '—');
  }

  /* 动态质量：帧耗时超预算则降采样，富余则回升（不超过用户设定） */
  function dynamicQuality() {
    const budget = 1000 / 30;
    const ft = CK.Perf.stats.frameMs;
    if (!ft) return;
    if (ft > budget * 1.25 && S.renderScale > 0.25) {
      S.renderScale = Math.max(0.25, S.renderScale - 0.15);
    } else if (ft < budget * 0.6 && S.renderScale < S.params.render.scale) {
      S.renderScale = Math.min(S.params.render.scale, S.renderScale + 0.1);
    } else {
      return;
    }
  }

  /* ================= 参数变更回调 ================= */
  const Main = {
    onParamsChanged(path) {
      if (path === 'render.scale') {
        S.renderScale = S.params.render.scale;
      }
      if (path.startsWith('bg.')) {
        CK.Background.sync(S.params);
        els.bgFileLabel.textContent = CK.Background.fileLabel(S.params);
      }
    },
    onCurveChanged() {
      if (S.renderer) S.renderer.updateCurve(S.params.grade.curve);
    },
    setStatus,
  };
  CK.Main = Main;

  /* ================= 预设 ================= */
  async function refreshPresetSelect() {
    const sel = els.presetSelect;
    sel.innerHTML = '';
    const g1 = document.createElement('optgroup');
    g1.label = '内置预设';
    CK.Presets.builtinNames().forEach((n) => {
      const o = document.createElement('option');
      o.value = 'builtin:' + n; o.textContent = n;
      g1.appendChild(o);
    });
    sel.appendChild(g1);
    const userNames = await CK.Presets.listUser();
    if (userNames.length) {
      const g2 = document.createElement('optgroup');
      g2.label = '我的预设';
      userNames.forEach((n) => {
        const o = document.createElement('option');
        o.value = 'user:' + n; o.textContent = n;
        g2.appendChild(o);
      });
      sel.appendChild(g2);
    }
  }

  async function applyPresetValue(value) {
    try {
      let patch = null, name = '';
      if (value.startsWith('builtin:')) {
        name = value.slice(8);
        patch = CK.Presets.getBuiltin(name);
      } else {
        name = value.slice(5);
        const rec = await CK.Presets.loadUser(name);
        patch = rec && rec.params;
      }
      if (!patch) throw new Error('预设不存在');
      S.params = CK.state.params = CK.deepMerge(defaultParams(), CK.deepClone(patch));
      CK.UI.refresh();
      Main.onCurveChanged();
      CK.Background.sync(S.params);
      S.renderScale = S.params.render.scale;
      els.bgFileLabel.textContent = CK.Background.fileLabel(S.params);
      setStatus('已应用预设「' + name + '」', 'ok');
    } catch (e) {
      setStatus('预设应用失败: ' + e.message, 'err');
    }
  }

  /* ================= 导出 ================= */
  function exportReport() {
    const st = CK.Perf.stats;
    const info = CK.Sources.getInfo();
    const report = {
      app: 'chroma-key-studio',
      exportedAt: new Date().toISOString(),
      renderer: S.mode === 'webgl' ? 'WebGL2' : 'CPU Canvas',
      video: {
        source: info.source,
        resolution: info.width + '×' + info.height,
        fps: +info.fps.toFixed(2),
        colorSpace: info.colorSpace || 'BT.709 (推测)',
      },
      render: {
        resolution: S.renderer.pw + '×' + S.renderer.ph,
        scale: +effectiveScale().toFixed(2),
        dynamicQuality: S.params.render.dynamicQuality,
      },
      performance: {
        fps: +st.fps.toFixed(1),
        frameMs: +st.frameMs.toFixed(2),
        cpuMs: +st.cpuMs.toFixed(2),
        gpuMs: S.mode === 'webgl' ? +st.gpuMs.toFixed(2) : null,
        droppedFrames: st.dropped,
      },
      params: S.params,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    CK.download('chroma-report.json', blob);
    setStatus('已导出对比报告 chroma-report.json', 'ok');
  }

  /* ================= 事件绑定 ================= */
  function bindEvents() {
    // ---- 视频源 ----
    els.btnCamera.addEventListener('click', async () => {
      try {
        setStatus('正在请求摄像头权限…');
        await CK.Sources.useCamera();
        setStatus('摄像头已开启', 'ok');
      } catch (e) {
        setStatus('摄像头开启失败: ' + e.message, 'err');
      }
    });
    els.btnFile.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => {
      const f = els.fileInput.files[0];
      if (!f) return;
      CK.Sources.useFile(f);
      els.chkLoop.checked = true;
      setStatus('已加载视频: ' + f.name, 'ok');
      els.fileInput.value = '';
    });
    els.btnTest.addEventListener('click', () => {
      CK.Sources.useTest();
      setStatus('已切换到内置测试画面', 'ok');
    });

    // ---- 传输控制 ----
    els.btnPlay.addEventListener('click', () => {
      const v = els.video;
      if (v.paused) v.play(); else v.pause();
    });
    els.video.addEventListener('play', () => { els.btnPlay.textContent = '⏸ 暂停'; });
    els.video.addEventListener('pause', () => { els.btnPlay.textContent = '▶ 播放'; });
    els.btnPrev.addEventListener('click', () => {
      if (!CK.Sources.stepFrame(-1)) setStatus('逐帧步进仅对视频文件源有效', 'warn');
    });
    els.btnNext.addEventListener('click', () => {
      if (!CK.Sources.stepFrame(1)) setStatus('逐帧步进仅对视频文件源有效', 'warn');
    });
    els.chkLoop.addEventListener('change', () => { els.video.loop = els.chkLoop.checked; });
    els.chkMute.addEventListener('change', () => { els.video.muted = els.chkMute.checked; });
    els.seekRange.addEventListener('input', () => {
      const v = els.video;
      if (isFinite(v.duration) && v.duration > 0) {
        v.currentTime = (els.seekRange.value / 1000) * v.duration;
      }
    });
    els.video.addEventListener('timeupdate', () => {
      const v = els.video;
      if (isFinite(v.duration) && v.duration > 0) {
        els.seekRange.value = Math.round((v.currentTime / v.duration) * 1000);
        els.timeLabel.textContent = CK.fmtTime(v.currentTime) + ' / ' + CK.fmtTime(v.duration);
      } else {
        els.timeLabel.textContent = '直播流';
      }
    });

    // ---- 抠像 ----
    els.btnEyedropper.addEventListener('click', () => {
      S.eyedropper = !S.eyedropper;
      els.btnEyedropper.classList.toggle('active', S.eyedropper);
      setStatus(S.eyedropper ? '吸管已激活：点击「原始画面」选取背景色' : '已取消吸管');
    });
    els.canvasSrc.addEventListener('pointerdown', (e) => {
      if (!S.eyedropper) return;
      const c = els.canvasSrc;
      const r = c.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * c.width);
      const y = Math.floor(((e.clientY - r.top) / r.height) * c.height);
      const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
      const hex = CK.rgbToHex(d[0], d[1], d[2]);
      S.params.key.color = hex;
      CK.UI.refresh();
      S.eyedropper = false;
      els.btnEyedropper.classList.remove('active');
      setStatus('已取色 ' + hex + ' 作为键色', 'ok');
    });
    els.btnKeyGreen.addEventListener('click', () => {
      S.params.key.color = '#00b140'; CK.UI.refresh(); setStatus('键色已设为标准绿幕 #00b140');
    });
    els.btnKeyBlue.addEventListener('click', () => {
      S.params.key.color = '#0047bb'; CK.UI.refresh(); setStatus('键色已设为标准蓝幕 #0047bb');
    });

    // ---- 背景素材 ----
    els.btnBgImage.addEventListener('click', () => els.bgImageInput.click());
    els.bgImageInput.addEventListener('change', () => {
      const f = els.bgImageInput.files[0];
      if (!f) return;
      CK.Background.setImageFile(f, (err, name) => {
        if (err) { setStatus(err.message, 'err'); return; }
        S.params.bg.type = 'image';
        CK.UI.refresh();
        els.bgFileLabel.textContent = CK.Background.fileLabel(S.params);
        setStatus('背景图片已加载: ' + name, 'ok');
      });
      els.bgImageInput.value = '';
    });
    els.btnBgVideo.addEventListener('click', () => els.bgVideoInput.click());
    els.bgVideoInput.addEventListener('change', () => {
      const f = els.bgVideoInput.files[0];
      if (!f) return;
      CK.Background.setVideoFile(f, (err, name) => {
        if (err) { setStatus(err.message, 'err'); return; }
        S.params.bg.type = 'video';
        CK.UI.refresh();
        CK.Background.sync(S.params);
        els.bgFileLabel.textContent = CK.Background.fileLabel(S.params);
        setStatus('背景视频已加载: ' + name, 'ok');
      });
      els.bgVideoInput.value = '';
    });

    // ---- 预览工具 ----
    els.cmpOff.addEventListener('click', () => setCompareMode('off'));
    els.cmpWipe.addEventListener('click', () => setCompareMode('wipe'));
    els.cmpSplit.addEventListener('click', () => setCompareMode('split'));
    els.btnBypass.addEventListener('click', () => {
      S.bypass = !S.bypass;
      els.btnBypass.classList.toggle('active', S.bypass);
      setStatus(S.bypass ? '已切换为原始画面（效果前）' : '已恢复合成画面（效果后）');
    });
    els.btnMagnifier.addEventListener('click', () => {
      S.magnifier = !S.magnifier;
      els.btnMagnifier.classList.toggle('active', S.magnifier);
      if (!S.magnifier) els.magnifier.style.display = 'none';
    });

    // ---- 渲染器 / 性能 ----
    els.btnToggleRenderer.addEventListener('click', () => {
      setRenderer(S.mode === 'webgl' ? 'cpu' : 'webgl');
    });
    els.btnResetDropped.addEventListener('click', () => {
      CK.Perf.resetDropped();
      setStatus('丢帧统计已重置');
    });

    // ---- 调色 ----
    els.btnCurveReset.addEventListener('click', () => {
      S.params.grade.curve = [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]];
      CK.UI.refresh();
      Main.onCurveChanged();
      setStatus('曲线已重置');
    });

    // ---- 预设与导出 ----
    els.presetSelect.addEventListener('change', () => applyPresetValue(els.presetSelect.value));
    els.btnPresetSave.addEventListener('click', async () => {
      const name = els.presetName.value.trim() || '我的预设-' + new Date().toLocaleTimeString();
      try {
        await CK.Presets.saveUser(name, S.params);
        await refreshPresetSelect();
        els.presetSelect.value = 'user:' + name;
        setStatus('预设「' + name + '」已保存到 IndexedDB', 'ok');
      } catch (e) {
        setStatus('预设保存失败: ' + e.message, 'err');
      }
    });
    els.btnPresetDelete.addEventListener('click', async () => {
      const v = els.presetSelect.value;
      if (!v || !v.startsWith('user:')) { setStatus('请选择「我的预设」中的条目再删除', 'warn'); return; }
      try {
        await CK.Presets.deleteUser(v.slice(5));
        await refreshPresetSelect();
        setStatus('预设已删除', 'ok');
      } catch (e) {
        setStatus('删除失败: ' + e.message, 'err');
      }
    });
    els.btnImport.addEventListener('click', () => els.importInput.click());
    els.importInput.addEventListener('change', async () => {
      const f = els.importInput.files[0];
      if (!f) return;
      try {
        const patch = await CK.Presets.importJSON(f);
        S.params = CK.state.params = CK.deepMerge(defaultParams(), patch);
        CK.UI.refresh();
        Main.onCurveChanged();
        CK.Background.sync(S.params);
        S.renderScale = S.params.render.scale;
        setStatus('预设导入成功: ' + f.name, 'ok');
      } catch (e) {
        setStatus('导入失败: ' + e.message, 'err');
      }
      els.importInput.value = '';
    });
    els.btnExportParams.addEventListener('click', () => {
      CK.Presets.exportJSON(els.presetName.value.trim() || 'chroma-preset', S.params);
      setStatus('已导出当前参数 JSON', 'ok');
    });
    els.btnExportMask.addEventListener('click', () => {
      els.canvasMask.toBlob((blob) => {
        if (blob) { CK.download('mask-preview.png', blob); setStatus('已导出遮罩预览图', 'ok'); }
      }, 'image/png');
    });
    els.btnExportReport.addEventListener('click', exportReport);

    // 空格键播放/暂停
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
        e.preventDefault();
        const v = els.video;
        if (v.paused) v.play(); else v.pause();
      }
    });
  }

  /* ================= 元素缓存 ================= */
  function cacheEls() {
    Object.assign(els, {
      statusBar: $('status-bar'),
      video: $('video-main'),
      bgVideo: $('bg-video'),
      rendererLabel: $('renderer-label'),
      btnToggleRenderer: $('btn-toggle-renderer'),
      btnCamera: $('btn-camera'), btnFile: $('btn-file'), btnTest: $('btn-test'),
      fileInput: $('file-input'),
      infoSource: $('info-source'), infoRes: $('info-res'),
      infoFps: $('info-fps'), infoColorspace: $('info-colorspace'),
      btnPlay: $('btn-play'), btnPrev: $('btn-prev'), btnNext: $('btn-next'),
      chkLoop: $('chk-loop'), chkMute: $('chk-mute'),
      seekRange: $('seek-range'), timeLabel: $('time-label'),
      btnEyedropper: $('btn-eyedropper'),
      btnKeyGreen: $('btn-key-green'), btnKeyBlue: $('btn-key-blue'),
      btnBgImage: $('btn-bg-image'), bgImageInput: $('bg-image-input'),
      btnBgVideo: $('btn-bg-video'), bgVideoInput: $('bg-video-input'),
      bgFileLabel: $('bg-file-label'),
      canvasSrc: $('canvas-src'), canvasMask: $('canvas-mask'), histogram: $('histogram'),
      compositeWrap: $('composite-wrap'), canvasCompare: $('canvas-compare'),
      compareHandle: $('compare-handle'), magnifier: $('magnifier'),
      cmpOff: $('cmp-off'), cmpWipe: $('cmp-wipe'), cmpSplit: $('cmp-split'),
      btnBypass: $('btn-bypass'), btnMagnifier: $('btn-magnifier'),
      perfFps: $('perf-fps'), perfFrame: $('perf-frame'), perfCpu: $('perf-cpu'),
      perfGpu: $('perf-gpu'), perfDropped: $('perf-dropped'), perfRes: $('perf-res'),
      btnResetDropped: $('btn-reset-dropped'),
      btnCurveReset: $('btn-curve-reset'),
      presetSelect: $('preset-select'), presetName: $('preset-name'),
      btnPresetSave: $('btn-preset-save'), btnPresetDelete: $('btn-preset-delete'),
      btnImport: $('btn-import'), importInput: $('import-input'),
      btnExportParams: $('btn-export-params'),
      btnExportMask: $('btn-export-mask'), btnExportReport: $('btn-export-report'),
    });
  }

  /* ================= 初始化 ================= */
  async function init() {
    cacheEls();
    CK.Sources.init(els.video);
    CK.Background.init(els.bgVideo);
    CK.UI.init();
    bindEvents();
    setupCompareDrag();
    setupMagnifier();
    setRenderer('webgl');

    const idbOk = await CK.Presets.init();
    await refreshPresetSelect();
    if (!idbOk) setStatus('IndexedDB 不可用，预设将无法持久化（导入/导出 JSON 仍可用）', 'warn');

    els.bgFileLabel.textContent = CK.Background.fileLabel(S.params);

    // 默认进入内置测试画面，立即可见三路效果
    CK.Sources.useTest();
    setStatus('已加载内置测试画面（可切换摄像头/视频文件），管线运行中', 'ok');

    requestAnimationFrame(tick);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
