/* ===== 性能监控：FPS / 帧耗时 / CPU 耗时 / GPU 耗时 / 丢帧统计 ===== */
window.CK = window.CK || {};
(function () {
  const CK = window.CK;

  const Perf = {
    stats: { fps: 0, frameMs: 0, cpuMs: 0, gpuMs: 0, dropped: 0 },
    _last: 0,

    frame(t, cpuMs, gpuMs) {
      if (this._last) {
        const dt = t - this._last;
        if (dt > 0 && dt < 2000) {
          const fps = 1000 / dt;
          this.stats.fps = this.stats.fps ? this.stats.fps * 0.9 + fps * 0.1 : fps;
          this.stats.frameMs = this.stats.frameMs ? this.stats.frameMs * 0.9 + dt * 0.1 : dt;
          // 丢帧：相对 60fps 基准的空档
          if (dt > 34) this.stats.dropped += Math.max(1, Math.round(dt / 16.7)) - 1;
        }
      }
      this._last = t;
      this.stats.cpuMs = this.stats.cpuMs ? this.stats.cpuMs * 0.85 + cpuMs * 0.15 : cpuMs;
      if (gpuMs != null && gpuMs >= 0) {
        this.stats.gpuMs = this.stats.gpuMs ? this.stats.gpuMs * 0.85 + gpuMs * 0.15 : gpuMs;
      }
    },

    resetDropped() { this.stats.dropped = 0; },

    reset() {
      this._last = 0;
      this.stats.fps = 0; this.stats.frameMs = 0; this.stats.cpuMs = 0; this.stats.gpuMs = 0;
    },
  };

  CK.Perf = Perf;
})();
