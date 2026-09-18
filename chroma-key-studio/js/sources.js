/* ===== 视频源管理：摄像头 / 视频文件 / 内置测试画面 ===== */
window.CK = window.CK || {};
(function () {
  const CK = window.CK;

  const Sources = {
    video: null,
    mode: null,          // 'camera' | 'file' | 'test'
    stream: null,
    fileURL: null,
    fpsEstimate: 0,
    _lastVFC: 0,
    _testRunning: false,

    init(videoEl) {
      this.video = videoEl;
      // requestVideoFrameCallback 估算真实帧率
      if (videoEl.requestVideoFrameCallback) {
        const cb = (now) => {
          if (this._lastVFC) {
            const dt = now - this._lastVFC;
            if (dt > 0 && dt < 1000) {
              const f = 1000 / dt;
              this.fpsEstimate = this.fpsEstimate ? this.fpsEstimate * 0.9 + f * 0.1 : f;
            }
          }
          this._lastVFC = now;
          this.video.requestVideoFrameCallback(cb);
        };
        videoEl.requestVideoFrameCallback(cb);
      }
    },

    stop() {
      this._testRunning = false;
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      if (this.fileURL) {
        URL.revokeObjectURL(this.fileURL);
        this.fileURL = null;
      }
      if (this.video) {
        this.video.pause();
        this.video.srcObject = null;
        this.video.removeAttribute('src');
        this.video.load();
      }
      this.fpsEstimate = 0;
      this._lastVFC = 0;
    },

    async useCamera() {
      this.stop();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      this.mode = 'camera';
    },

    useFile(file) {
      this.stop();
      this.fileURL = URL.createObjectURL(file);
      this.video.src = this.fileURL;
      this.video.loop = true;
      const p = this.video.play();
      if (p && p.catch) p.catch(() => {});
      this.mode = 'file';
    },

    /* 内置测试画面：canvas 动画 → captureStream，无需摄像头即可体验完整管线 */
    useTest() {
      this.stop();
      const c = document.createElement('canvas');
      c.width = 640; c.height = 360;
      const ctx = c.getContext('2d');
      this._testRunning = true;
      const self = this;
      (function draw() {
        if (!self._testRunning) return;
        Sources._drawTestScene(ctx, c.width, c.height, performance.now() / 1000);
        requestAnimationFrame(draw);
      })();
      this.stream = c.captureStream(30);
      this.video.srcObject = this.stream;
      const p = this.video.play();
      if (p && p.catch) p.catch(() => {});
      this.mode = 'test';
    },

    _drawTestScene(ctx, w, h, t) {
      // 绿幕背景（带渐变模拟真实打光不均）
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#00b140');
      grad.addColorStop(0.6, '#00a83c');
      grad.addColorStop(1, '#008f34');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      // 地面阴影
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.ellipse(w / 2, h * 0.93, w * 0.32, h * 0.05, 0, 0, Math.PI * 2);
      ctx.fill();

      const px = w / 2 + Math.sin(t * 0.7) * w * 0.16;
      // 身体
      ctx.fillStyle = '#c0392b';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(px - 46, h * 0.46, 92, h * 0.44, 22);
      else ctx.rect(px - 46, h * 0.46, 92, h * 0.44);
      ctx.fill();
      // 手臂（摆动）
      ctx.strokeStyle = '#e8b58c';
      ctx.lineWidth = 16;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px - 40, h * 0.52);
      ctx.lineTo(px - 78, h * 0.52 + Math.sin(t * 2.2) * 26 + 30);
      ctx.moveTo(px + 40, h * 0.52);
      ctx.lineTo(px + 78, h * 0.52 + Math.cos(t * 2.2) * 26 + 30);
      ctx.stroke();
      // 头 + 头发
      ctx.fillStyle = '#e8b58c';
      ctx.beginPath(); ctx.arc(px, h * 0.35, 38, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4a2f1b';
      ctx.beginPath(); ctx.arc(px, h * 0.35 - 10, 34, Math.PI, 0); ctx.fill();
      // 蓝色道具球（测试蓝物保留）
      ctx.fillStyle = '#2471ff';
      ctx.beginPath();
      ctx.arc(px + 88, h * 0.6 + Math.cos(t * 2.2) * 26 + 20, 17, 0, Math.PI * 2);
      ctx.fill();
      // 半透明玻璃板（测试半透明区域保留）
      const gx = (Math.sin(t * 0.45) * 0.5 + 0.5) * (w - 150) + 10;
      ctx.fillStyle = 'rgba(215,228,240,0.45)';
      ctx.fillRect(gx, h * 0.12, 120, h * 0.5);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2;
      ctx.strokeRect(gx, h * 0.12, 120, h * 0.5);
      // 黄色标牌（测试高饱和前景）
      ctx.fillStyle = '#f1c40f';
      ctx.fillRect(w * 0.08, h * 0.72, 110, 44);
      ctx.fillStyle = '#222';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText('TEST', w * 0.08 + 28, h * 0.72 + 30);
    },

    /* 逐帧步进（仅文件源有意义） */
    stepFrame(dir) {
      if (this.mode !== 'file' || !this.video) return false;
      this.video.pause();
      const fps = this.fpsEstimate || 30;
      this.video.currentTime = Math.max(0, this.video.currentTime + dir / fps);
      return true;
    },

    getFPS() {
      if (this.mode === 'camera' && this.stream) {
        const track = this.stream.getVideoTracks()[0];
        if (track && track.getSettings) {
          const s = track.getSettings();
          if (s.frameRate) return s.frameRate;
        }
      }
      if (this.mode === 'test') return 30;
      return this.fpsEstimate || 0;
    },

    /* 尝试读取色彩空间（VideoFrame API，Chrome 94+） */
    getColorSpace() {
      try {
        if (typeof VideoFrame === 'undefined' || !this.video || !this.video.videoWidth) return null;
        const vf = new VideoFrame(this.video);
        const cs = vf.colorSpace;
        vf.close();
        if (!cs) return null;
        const map = { bt709: 'BT.709', bt470bg: 'BT.601', smpte170m: 'BT.601', bt2020: 'BT.2020' };
        const pri = map[cs.primaries] || cs.primaries || '?';
        const trc = map[cs.transfer] || cs.transfer || '?';
        return pri + ' / ' + trc + (cs.fullRange === false ? ' 限定幅' : '');
      } catch (e) { return null; }
    },

    getInfo() {
      const v = this.video;
      const label = this.mode === 'camera' ? '摄像头' : this.mode === 'file' ? '视频文件' : this.mode === 'test' ? '测试画面' : '—';
      return {
        source: label,
        width: v && v.videoWidth ? v.videoWidth : 0,
        height: v && v.videoHeight ? v.videoHeight : 0,
        fps: this.getFPS(),
        colorSpace: this.getColorSpace(),
      };
    },
  };

  CK.Sources = Sources;
})();
