/* ===== 背景资源管理：纯色 / 图片 / 视频 / 原视频模糊 ===== */
window.CK = window.CK || {};
(function () {
  const CK = window.CK;

  const Background = {
    image: null,        // HTMLImageElement
    imageURL: null,
    video: null,        // 背景视频元素（由 init 注入）
    videoURL: null,
    videoFileName: '',
    avg: [0.12, 0.19, 0.29], // 背景平均色（色彩匹配/光照统一用）
    _avgCanvas: null,
    _avgCtx: null,

    init(bgVideoEl) {
      this.video = bgVideoEl;
      this._avgCanvas = document.createElement('canvas');
      this._avgCanvas.width = 8; this._avgCanvas.height = 8;
      this._avgCtx = this._avgCanvas.getContext('2d', { willReadFrequently: true });
    },

    setImageFile(file, onDone) {
      if (this.imageURL) URL.revokeObjectURL(this.imageURL);
      this.imageURL = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { this.image = img; if (onDone) onDone(null, file.name); };
      img.onerror = () => { if (onDone) onDone(new Error('图片加载失败')); };
      img.src = this.imageURL;
    },

    setVideoFile(file, onDone) {
      if (this.videoURL) URL.revokeObjectURL(this.videoURL);
      this.videoURL = URL.createObjectURL(file);
      this.video.src = this.videoURL;
      this.videoFileName = file.name;
      this.video.onloadeddata = () => { if (onDone) onDone(null, file.name); };
      this.video.onerror = () => { if (onDone) onDone(new Error('视频加载失败')); };
    },

    /* 根据参数同步背景视频播放状态 */
    sync(params) {
      const bg = params.bg;
      this.video.loop = !!bg.loop;
      if (bg.type === 'video' && this.video.src) {
        const p = this.video.play();
        if (p && p.catch) p.catch(() => {});
      } else {
        this.video.pause();
      }
    },

    /* 8x8 降采样求平均色 */
    sampleAvg(src) {
      try {
        const c = this._avgCtx;
        c.drawImage(src, 0, 0, 8, 8);
        const d = c.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        return [r / 64 / 255, g / 64 / 255, b / 64 / 255];
      } catch (e) { return [0.5, 0.5, 0.5]; }
    },

    /* 周期性更新背景平均色（主循环节流调用） */
    updateAvg(params, mainVideo) {
      const type = params.bg.type;
      if (type === 'color') {
        this.avg = CK.hexToRgb01(params.bg.color);
      } else if (type === 'image' && this.image && this.image.width) {
        this.avg = this.sampleAvg(this.image);
      } else if (type === 'video' && this.video.readyState >= 2) {
        this.avg = this.sampleAvg(this.video);
      } else if (type === 'blur' && mainVideo && mainVideo.readyState >= 2) {
        this.avg = this.sampleAvg(mainVideo);
      }
    },

    fileLabel(params) {
      const type = params.bg.type;
      if (type === 'image') return this.image ? '图片: ' + (this.image.width + '×' + this.image.height) : '未加载图片素材';
      if (type === 'video') return this.videoFileName ? '视频: ' + this.videoFileName : '未加载视频素材';
      if (type === 'blur') return '使用原视频高斯模糊作为背景';
      return '纯色背景';
    },
  };

  CK.Background = Background;
})();
