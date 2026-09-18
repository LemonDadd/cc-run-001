/* ===== WebGL2 多 Pass 渲染管线 =====
 * 管线: 视频纹理 → [抠像+溢色+调色] → [腐蚀H/V] → [膨胀H/V] → [中值去噪]
 *       → [高斯羽化H/V] → [半透明保留] → [背景合成] → 屏幕
 * 遮罩经 blit 降采样到小 FBO 后 readPixels，供遮罩预览与直方图使用。
 */
window.CK = window.CK || {};
(function () {
  const CK = window.CK;

  class GLRenderer {
    constructor(canvas) {
      this.kind = 'webgl';
      this.canvas = canvas;
      const gl = (this.gl = canvas.getContext('webgl2', {
        preserveDrawingBuffer: true, // 放大镜需要回读画面
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
      }));
      if (!gl) throw new Error('WebGL2 不可用');

      this.pw = 2; this.ph = 2;
      this.frameCount = 0;
      this.gpuMs = 0;

      const C = CK.GLCore;
      this.vao = C.quad(gl);
      this.pKey = C.program(gl, CK.Shaders.VERT, CK.Shaders.KEY_FS);
      this.pMorph = C.program(gl, CK.Shaders.VERT, CK.Shaders.MORPH_FS);
      this.pMedian = C.program(gl, CK.Shaders.VERT, CK.Shaders.MEDIAN_FS);
      this.pBlur = C.program(gl, CK.Shaders.VERT, CK.Shaders.BLUR_FS);
      this.pKeep = C.program(gl, CK.Shaders.VERT, CK.Shaders.KEEPSEMI_FS);
      this.pComposite = C.program(gl, CK.Shaders.VERT, CK.Shaders.COMPOSITE_FS);
      this.pBlit = C.program(gl, CK.Shaders.VERT, CK.Shaders.BLIT_FS);

      this.videoTex = C.texture(gl);
      this.bgTex = C.texture(gl);

      // 曲线 LUT：256x1 R8
      this.curveTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const identity = new Uint8Array(256);
      for (let i = 0; i < 256; i++) identity[i] = i;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, identity);

      this.fboA = this.fboB = this.fboC = this.fboBgBlur = this.fboMask = null;
      this.maskW = 320; this.maskH = 180;
      this.maskPixels = null;

      // GPU 计时（EXT_disjoint_timer_query_webgl2，可选）
      this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.pendingQueries = [];
      this.currentQuery = null;

      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
    }

    setSize(vw, vh, scale) {
      const pw = Math.max(16, Math.round(vw * scale));
      const ph = Math.max(16, Math.round(vh * scale));
      if (pw === this.pw && ph === this.ph) return;
      this.pw = pw; this.ph = ph;
      this.canvas.width = pw; this.canvas.height = ph;
      const gl = this.gl, C = CK.GLCore;
      ['fboA', 'fboB', 'fboC', 'fboBgBlur', 'fboMask'].forEach((k) => { C.deleteFbo(gl, this[k]); this[k] = null; });
      this.fboA = C.fbo(gl, pw, ph);
      this.fboB = C.fbo(gl, pw, ph);
      this.fboC = C.fbo(gl, pw, ph);
      this.fboBgBlur = C.fbo(gl, pw, ph);
      this.maskW = 320;
      this.maskH = Math.max(2, Math.round((320 * ph) / pw));
      this.fboMask = C.fbo(gl, this.maskW, this.maskH);
      this.maskPixels = new Uint8Array(this.maskW * this.maskH * 4);
    }

    updateCurve(points) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, CK.buildCurveLUT(points));
    }

    /* ---- 内部工具 ---- */
    bindTex(unit, tex, loc) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    }

    draw(target) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, target ? target.w : this.pw, target ? target.h : this.ph);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    beginTimer() {
      if (!this.timerExt || this.currentQuery || this.pendingQueries.length > 3) return;
      const gl = this.gl;
      this.currentQuery = gl.createQuery();
      gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, this.currentQuery);
    }

    endTimer() {
      if (!this.currentQuery) return;
      const gl = this.gl;
      gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      this.pendingQueries.push(this.currentQuery);
      this.currentQuery = null;
    }

    pollTimer() {
      if (!this.timerExt) return;
      const gl = this.gl, ext = this.timerExt;
      while (this.pendingQueries.length) {
        const q = this.pendingQueries[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          this.gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        }
        gl.deleteQuery(q);
        this.pendingQueries.shift();
      }
    }

    morphPass(src, dst, radius, mode, horizontal) {
      const gl = this.gl, p = this.pMorph;
      gl.useProgram(p.prog);
      this.bindTex(0, src.tex, p.u.uTex);
      gl.uniform2f(p.u.uTexel, 1 / this.pw, 1 / this.ph);
      gl.uniform2f(p.u.uDir, horizontal ? 1 : 0, horizontal ? 0 : 1);
      gl.uniform1i(p.u.uRadius, Math.min(12, Math.round(radius)));
      gl.uniform1i(p.u.uMode, mode);
      this.draw(dst);
    }

    blurPass(srcTex, dst, radius, horizontal, mode) {
      const gl = this.gl, p = this.pBlur;
      gl.useProgram(p.prog);
      this.bindTex(0, srcTex, p.u.uTex);
      gl.uniform2f(p.u.uTexel, 1 / this.pw, 1 / this.ph);
      gl.uniform2f(p.u.uDir, horizontal ? 1 : 0, horizontal ? 0 : 1);
      gl.uniform1f(p.u.uRadius, radius);
      gl.uniform1i(p.u.uMode, mode);
      this.draw(dst);
    }

    blitPass(srcTex, dst, alphaGray) {
      const gl = this.gl, p = this.pBlit;
      gl.useProgram(p.prog);
      this.bindTex(0, srcTex, p.u.uTex);
      gl.uniform1i(p.u.uAlphaGray, alphaGray ? 1 : 0);
      this.draw(dst);
    }

    /* ---- 主渲染 ---- */
    render(frame) {
      const gl = this.gl, p = frame.params;
      this.frameCount++;

      // 上传视频帧
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.video);
      } catch (e) { return; }

      // 背景准备
      let bgIsColor = 1;
      let bgW = 1, bgH = 1;
      let bgTex = this.bgTex;
      if (p.bg.type === 'image' && frame.bgImage && frame.bgImage.width) {
        if (this._bgImageRef !== frame.bgImage) { // 静态图片仅上传一次
          gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.bgImage);
          this._bgImageRef = frame.bgImage;
        }
        bgIsColor = 0; bgW = frame.bgImage.width; bgH = frame.bgImage.height;
      } else if (p.bg.type === 'video' && frame.bgVideo && frame.bgVideo.readyState >= 2 && frame.bgVideo.videoWidth) {
        gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.bgVideo);
        bgIsColor = 0; bgW = frame.bgVideo.videoWidth; bgH = frame.bgVideo.videoHeight;
      } else if (p.bg.type === 'blur') {
        // 原视频模糊背景：视频纹理 → 高斯H → 高斯V → fboBgBlur
        this.blurPass(this.videoTex, this.fboB, p.bg.blurAmount, true, 1);
        this.blurPass(this.fboB.tex, this.fboBgBlur, p.bg.blurAmount, false, 1);
        bgIsColor = 0; bgW = this.pw; bgH = this.ph; bgTex = this.fboBgBlur.tex;
      }

      this.beginTimer();

      // Pass 1: 抠像 + 溢色 + 调色 → fboA
      const kp = this.pKey;
      gl.useProgram(kp.prog);
      this.bindTex(0, this.videoTex, kp.u.uVideo);
      this.bindTex(1, this.curveTex, kp.u.uCurve);
      const kc = CK.hexToRgb01(p.key.color);
      gl.uniform3f(kp.u.uKeyColor, kc[0], kc[1], kc[2]);
      gl.uniform1i(kp.u.uSpace, p.key.space === 'rgb' ? 0 : p.key.space === 'yuv' ? 1 : 2);
      gl.uniform1f(kp.u.uSimilarity, p.key.similarity);
      gl.uniform1f(kp.u.uSmoothness, p.key.smoothness);
      gl.uniform1f(kp.u.uFeather, p.key.feather);
      gl.uniform1f(kp.u.uShrink, p.key.shrink);
      gl.uniform1i(kp.u.uSpillType, frame.spillType);
      gl.uniform1f(kp.u.uSpillStrength, p.spill.strength);
      gl.uniform1f(kp.u.uEdgeCorrect, p.spill.edgeCorrect);
      gl.uniform1f(kp.u.uBrightness, p.grade.brightness);
      gl.uniform1f(kp.u.uContrast, p.grade.contrast);
      gl.uniform1f(kp.u.uSaturation, p.grade.saturation);
      gl.uniform1f(kp.u.uTemperature, p.grade.temperature);
      gl.uniform1f(kp.u.uTint, p.grade.tint);
      gl.uniform1f(kp.u.uColorMatch, p.bg.colorMatch);
      gl.uniform1f(kp.u.uLightUnify, p.grade.lightUnify);
      gl.uniform3f(kp.u.uBgAvg, frame.bgAvg[0], frame.bgAvg[1], frame.bgAvg[2]);
      gl.uniform3f(kp.u.uFgAvg, frame.fgAvg[0], frame.fgAvg[1], frame.fgAvg[2]);
      gl.uniform1f(kp.u.uBypass, frame.bypass ? 1 : 0);
      this.draw(this.fboA);

      // Pass 2..n: 遮罩后处理（fboA/fboB 乒乓）
      let cur = this.fboA, other = this.fboB;
      const swap = () => { const t = cur; cur = other; other = t; };
      const m = p.mask;
      const morphActive = m.erode > 0.05 || m.dilate > 0.05 || m.blur > 0.05 || m.noise > 0.01;
      const needOrig = m.keepSemi > 0.001 && morphActive && !frame.bypass;
      if (needOrig) this.blitPass(cur.tex, this.fboC, false);

      if (m.erode > 0.05) {
        this.morphPass(cur, other, m.erode, 0, true); swap();
        this.morphPass(cur, other, m.erode, 0, false); swap();
      }
      if (m.dilate > 0.05) {
        this.morphPass(cur, other, m.dilate, 1, true); swap();
        this.morphPass(cur, other, m.dilate, 1, false); swap();
      }
      if (m.noise > 0.01) {
        const mp = this.pMedian;
        gl.useProgram(mp.prog);
        this.bindTex(0, cur.tex, mp.u.uTex);
        gl.uniform2f(mp.u.uTexel, 1 / this.pw, 1 / this.ph);
        gl.uniform1f(mp.u.uStrength, m.noise);
        this.draw(other); swap();
      }
      if (m.blur > 0.05) {
        this.blurPass(cur.tex, other, m.blur, true, 0); swap();
        this.blurPass(cur.tex, other, m.blur, false, 0); swap();
      }
      if (needOrig) {
        const kp2 = this.pKeep;
        gl.useProgram(kp2.prog);
        this.bindTex(0, this.fboC.tex, kp2.u.uOrig);
        this.bindTex(1, cur.tex, kp2.u.uMorphed);
        gl.uniform1f(kp2.u.uKeep, m.keepSemi);
        this.draw(other); swap();
      }

      // 最终 Pass: 背景合成 → 屏幕
      const cp = this.pComposite;
      gl.useProgram(cp.prog);
      this.bindTex(0, cur.tex, cp.u.uFg);
      this.bindTex(1, bgTex, cp.u.uBg);
      gl.uniform1i(cp.u.uBgIsColor, bgIsColor);
      const bgc = CK.hexToRgb01(p.bg.color);
      gl.uniform3f(cp.u.uBgColor, bgc[0], bgc[1], bgc[2]);
      let fx = 1, fy = 1;
      if (!bgIsColor) {
        const s = Math.max(this.pw / bgW, this.ph / bgH) * p.bg.scale;
        fx = this.pw / (bgW * s);
        fy = this.ph / (bgH * s);
      }
      gl.uniform2f(cp.u.uBgScale, fx, fy);
      gl.uniform2f(cp.u.uBgOffset, p.bg.offsetX, p.bg.offsetY);
      this.draw(null);

      this.endTimer();
      this.pollTimer();

      // 遮罩预览回读（每 3 帧一次，降采样到小 FBO）
      if (this.frameCount % 3 === 0 && this.maskPixels) {
        this.blitPass(cur.tex, this.fboMask, true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboMask.fbo);
        gl.readPixels(0, 0, this.maskW, this.maskH, gl.RGBA, gl.UNSIGNED_BYTE, this.maskPixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        // readPixels 自下而上 → 翻转为自上而下
        const rowBytes = this.maskW * 4;
        const tmp = new Uint8Array(rowBytes);
        const px = this.maskPixels;
        for (let y = 0; y < this.maskH >> 1; y++) {
          const a = y * rowBytes, b = (this.maskH - 1 - y) * rowBytes;
          tmp.set(px.subarray(a, a + rowBytes));
          px.copyWithin(a, b, b + rowBytes);
          px.set(tmp, b);
        }
      }
    }

    readMask() {
      if (!this.maskPixels) return null;
      return { data: this.maskPixels, width: this.maskW, height: this.maskH };
    }

    dispose() {
      const ext = this.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
  }

  CK.GLRenderer = GLRenderer;
})();
