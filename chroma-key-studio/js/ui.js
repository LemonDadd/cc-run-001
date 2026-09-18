/* ===== UI 控件绑定（data-bind 声明式） + 曲线编辑器 ===== */
window.CK = window.CK || {};
(function () {
  const CK = window.CK;

  const UI = {
    controls: [],
    refreshCurve: null,

    init() {
      this.controls = Array.from(document.querySelectorAll('[data-bind]'));
      this.controls.forEach((el) => {
        const path = el.dataset.bind;
        this._setElValue(el, CK.getPath(CK.state.params, path));
        el.addEventListener('input', () => {
          const v = this._getElValue(el);
          CK.setPath(CK.state.params, path, v);
          this._updateOut(el);
          CK.Main.onParamsChanged(path);
        });
        this._updateOut(el);
      });
      this._initCurveEditor();
    },

    /* 预设加载后刷新所有控件显示 */
    refresh() {
      this.controls.forEach((el) => {
        this._setElValue(el, CK.getPath(CK.state.params, el.dataset.bind));
        this._updateOut(el);
      });
      if (this.refreshCurve) this.refreshCurve();
    },

    _getElValue(el) {
      if (el.type === 'checkbox') return el.checked;
      if (el.type === 'range' || el.type === 'number') return parseFloat(el.value);
      return el.value;
    },

    _setElValue(el, v) {
      if (v === undefined || v === null) return;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    },

    _updateOut(el) {
      const ctl = el.closest('.ctl');
      const out = ctl ? ctl.querySelector('output') : null;
      if (!out) return;
      const v = this._getElValue(el);
      if (typeof v === 'number') {
        const digits = el.dataset.fmt !== undefined ? parseInt(el.dataset.fmt, 10) : 2;
        out.textContent = v.toFixed(digits);
      } else if (el.type === 'color') {
        out.textContent = String(v);
      } else {
        out.textContent = '';
      }
    },

    /* 基础曲线编辑器：5 个固定横坐标控制点，纵坐标可拖动 */
    _initCurveEditor() {
      const canvas = document.getElementById('curve-editor');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const XS = [0, 0.25, 0.5, 0.75, 1];
      let dragIdx = -1;

      const pts = () => CK.state.params.grade.curve;

      const toXY = (px, py) => {
        const pad = 8;
        return [pad + px * (canvas.width - pad * 2), canvas.height - pad - py * (canvas.height - pad * 2)];
      };

      const draw = () => {
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        // 网格
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          ctx.beginPath(); ctx.moveTo((w / 4) * i, 0); ctx.lineTo((w / 4) * i, h); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, (h / 4) * i); ctx.lineTo(w, (h / 4) * i); ctx.stroke();
        }
        // 对角参考线
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(...toXY(0, 0)); ctx.lineTo(...toXY(1, 1));
        ctx.stroke();
        ctx.setLineDash([]);
        // 曲线（按 LUT 采样绘制，所见即所得）
        const lut = CK.buildCurveLUT(pts());
        ctx.strokeStyle = '#2f81f7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) {
          const [x, y] = toXY(i / 255, lut[i] / 255);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        // 控制点
        pts().forEach((p, i) => {
          const [x, y] = toXY(p[0], p[1]);
          ctx.fillStyle = i === dragIdx ? '#f1c40f' : '#3fb950';
          ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 2; ctx.stroke();
        });
      };

      const posOf = (e) => {
        const r = canvas.getBoundingClientRect();
        return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
      };

      canvas.addEventListener('pointerdown', (e) => {
        const [nx] = posOf(e);
        let best = 0, bd = Infinity;
        XS.forEach((x, i) => { const d = Math.abs(x - nx); if (d < bd) { bd = d; best = i; } });
        dragIdx = best;
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', (e) => {
        if (dragIdx < 0) return;
        const [, ny] = posOf(e);
        pts()[dragIdx][1] = CK.clamp01(1 - ny);
        draw();
        CK.Main.onCurveChanged();
      });
      const end = () => { dragIdx = -1; };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);

      this.refreshCurve = draw;
      draw();
    },
  };

  CK.UI = UI;
})();
