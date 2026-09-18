/* ===== 参数预设：内置预设 / IndexedDB 持久化 / JSON 导入导出 ===== */
window.CK = window.CK || {};
(function () {
  const CK = window.CK;

  /* 内置示例预设（部分参数，应用时深合并到默认值上） */
  const BUILTIN = {
    '标准绿幕': {
      key: { color: '#00b140', space: 'yuv', similarity: 0.32, smoothness: 0.08, shrink: 0.06, feather: 0.06 },
      mask: { erode: 0, dilate: 0, blur: 1, noise: 0.3, keepSemi: 0.5 },
      spill: { type: 'green', strength: 0.7, edgeCorrect: 0.4 },
      bg: { type: 'color', color: '#20304a', colorMatch: 0.3 },
      grade: { brightness: 0.02, contrast: 1.02, saturation: 1.05 },
    },
    '蓝幕': {
      key: { color: '#0047bb', space: 'yuv', similarity: 0.34, smoothness: 0.09, shrink: 0.06, feather: 0.06 },
      mask: { erode: 0, dilate: 0, blur: 1, noise: 0.3, keepSemi: 0.5 },
      spill: { type: 'blue', strength: 0.7, edgeCorrect: 0.4 },
      bg: { type: 'color', color: '#2a1f3d', colorMatch: 0.3 },
      grade: { brightness: 0.02, contrast: 1.02, saturation: 1.05 },
    },
    '低光照': {
      key: { color: '#00b140', space: 'yuv', similarity: 0.42, smoothness: 0.16, shrink: 0.03, feather: 0.12 },
      mask: { erode: 0, dilate: 0, blur: 1.5, noise: 0.65, keepSemi: 0.7 },
      spill: { type: 'green', strength: 0.8, edgeCorrect: 0.55 },
      bg: { type: 'color', color: '#1a1a22', colorMatch: 0.4 },
      grade: { brightness: 0.1, contrast: 1.06, saturation: 1.08, lightUnify: 0.3 },
    },
  };

  const DB_NAME = 'chroma-key-studio';
  const STORE = 'presets';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'name' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const result = fn(store);
      t.oncomplete = () => resolve(result && result._val !== undefined ? result._val : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const Presets = {
    BUILTIN,
    db: null,

    async init() {
      try { this.db = await openDB(); }
      catch (e) { this.db = null; }
      return this.db != null;
    },

    builtinNames() { return Object.keys(BUILTIN); },

    getBuiltin(name) { return BUILTIN[name] || null; },

    async saveUser(name, params) {
      if (!this.db) throw new Error('IndexedDB 不可用');
      const record = { name, params: CK.deepClone(params), updated: Date.now() };
      await tx(this.db, 'readwrite', (s) => s.put(record));
      return record;
    },

    async loadUser(name) {
      if (!this.db) throw new Error('IndexedDB 不可用');
      return new Promise((resolve, reject) => {
        const t = this.db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).get(name);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },

    async deleteUser(name) {
      if (!this.db) throw new Error('IndexedDB 不可用');
      await tx(this.db, 'readwrite', (s) => s.delete(name));
    },

    async listUser() {
      if (!this.db) return [];
      return new Promise((resolve, reject) => {
        const t = this.db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result || []).map((r) => r.name).sort());
        req.onerror = () => reject(req.error);
      });
    },

    /* 导出为 JSON 文件 */
    exportJSON(name, params) {
      const payload = {
        app: 'chroma-key-studio',
        version: 1,
        name: name || '未命名预设',
        exportedAt: new Date().toISOString(),
        params,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      CK.download((name || 'chroma-preset') + '.json', blob);
    },

    /* 从 JSON 文件导入 → 返回 params 补丁对象 */
    async importJSON(file) {
      const text = await file.text();
      const obj = JSON.parse(text);
      const params = obj && obj.params ? obj.params : obj;
      if (!params || typeof params !== 'object' || (!params.key && !params.mask && !params.grade)) {
        throw new Error('无法识别的预设文件格式');
      }
      return params;
    },
  };

  CK.Presets = Presets;
})();
