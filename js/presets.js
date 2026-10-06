/* ============================================================================
 * GT 产线模拟器 — presets.js
 * 预设库：单独存放在 localStorage 的独立键中，并可单独导出/导入文件，
 * 所有流程文件共用同一份预设库。（按需求：不提供任何默认预设）
 * ==========================================================================*/
(function (root, factory) {
  'use strict';
  var api = factory(root.GT && root.GT.model);
  root.GT = root.GT || {};
  root.GT.presets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';
  if (!M) throw new Error('presets.js 需要先加载 model.js');

  var GLOBAL = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);
  function storeApi() { return (GLOBAL.GT && GLOBAL.GT.store) || null; }

  var KEY = 'gtline.presets.v1';
  var TYPE_LABEL = { item: '物品', machine: '机器', buffer: '缓存器', source: '输入端', sink: '输出端' };
  var TYPE_ORDER = ['item', 'machine', 'buffer', 'source', 'sink'];

  var lib = null;
  var api = { onChange: null };

  function emptyLib() {
    return { format: M.PRESET_FORMAT, version: M.PRESET_VERSION, updatedAt: new Date().toISOString(), presets: [] };
  }

  function notify() {
    if (typeof api.onChange === 'function') {
      try { api.onChange(lib); } catch (e) { console.error(e); }
    }
  }

  function snapshotItem(flow, itemId) {
    var it = M.findItem(flow, itemId);
    if (!it) return null;
    return { name: it.name, state: it.state, color: it.color };
  }

  function normalizeItemSnap(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') return { name: raw, state: M.SOLID, color: '' };
    return {
      name: M.str(raw.name, ''),
      state: raw.state === M.FLUID ? M.FLUID : M.SOLID,
      color: M.str(raw.color, '')
    };
  }

  function normalizePreset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var type = TYPE_ORDER.indexOf(raw.type) >= 0 ? raw.type : null;
    if (!type) return null;
    var p = { id: raw.id || M.uid('ps'), type: type, name: M.str(raw.name, '未命名预设'), desc: M.str(raw.desc, '') };
    if (type === 'item') {
      p.item = normalizeItemSnap(raw.item) || { name: '新物品', state: M.SOLID, color: '' };
      if (raw.item && raw.item.note) p.item.note = M.str(raw.item.note, '');
    } else if (type === 'machine') {
      var m = raw.machine || {};
      p.machine = {
        name: M.str(m.name, p.name),
        power: M.num(m.power, 0, 0, 1e9),
        ticks: M.num(m.ticks, M.TICKS_PER_SECOND, 1, 1e9),
        inputs: normalizeLines(m.inputs),
        outputs: normalizeLines(m.outputs)
      };
    } else if (type === 'buffer') {
      var bf = raw.buffer || {};
      p.buffer = {
        name: M.str(bf.name, p.name),
        inputs: normalizeLines(bf.inputs)
      };
    } else {
      var d = raw.diamond || {};
      p.diamond = {
        name: M.str(d.name, p.name),
        ticks: M.num(d.ticks, M.TICKS_PER_SECOND, 1, 1e9),
        item: normalizeItemSnap(d.item),
        count: M.num(d.count, 1, 0, 100000),
        filterItem: normalizeItemSnap(d.filterItem),
        filterCount: M.num(d.filterCount, 0, 0, 100000)
      };
    }
    return p;
  }

  function normalizeLines(raw) {
    var out = [];
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i] || {};
      out.push({ item: normalizeItemSnap(r.item), count: M.num(r.count, 1, 1, 100000) });
    }
    return out;
  }

  function normalizeLibrary(raw) {
    var def = emptyLib();
    if (!raw || typeof raw !== 'object') return def;
    var list = Array.isArray(raw.presets) ? raw.presets : (Array.isArray(raw) ? raw : []);
    var seen = {};
    list.forEach(function (r) {
      var p = normalizePreset(r);
      if (!p) return;
      if (seen[p.id]) p.id = M.uid('ps');
      seen[p.id] = true;
      def.presets.push(p);
    });
    def.updatedAt = M.str(raw.updatedAt, def.updatedAt);
    return def;
  }

  function load() {
    var raw = null;
    try { raw = window.localStorage.getItem(KEY); } catch (e) { raw = null; }
    if (!raw) { lib = emptyLib(); return lib; }
    try {
      lib = normalizeLibrary(JSON.parse(raw));
    } catch (e) {
      lib = emptyLib();
    }
    return lib;
  }

  function save() {
    if (!lib) lib = emptyLib();
    lib.format = M.PRESET_FORMAT;
    lib.version = M.PRESET_VERSION;
    lib.updatedAt = new Date().toISOString();
    try {
      window.localStorage.setItem(KEY, JSON.stringify(lib));
    } catch (e) {
      var st = storeApi();
      if (st) {
        st.emit('toast', { level: 'error', text: '预设库写入本地存储失败：' + e.message + '，可先导出预设文件。' });
      }
    }
    notify();
    return lib;
  }

  function ensure() { if (!lib) load(); return lib; }

  function list(type) {
    ensure();
    var arr = lib.presets.slice();
    if (type) arr = arr.filter(function (p) { return p.type === type; });
    return arr;
  }

  function get(id) {
    ensure();
    for (var i = 0; i < lib.presets.length; i++) if (lib.presets[i].id === id) return lib.presets[i];
    return null;
  }

  var _seq = 0;
  function uniquePresetName(name, type) {
    ensure();
    var used = lib.presets.filter(function (p) { return p.type === type; }).map(function (p) { return p.name; });
    return M.uniqueName(name, used);
  }

  function upsert(preset) {
    ensure();
    var p = normalizePreset(preset);
    if (!p) return null;
    var idx = -1;
    for (var i = 0; i < lib.presets.length; i++) if (lib.presets[i].id === p.id) { idx = i; break; }
    if (idx >= 0) lib.presets[idx] = p; else lib.presets.push(p);
    save();
    return p;
  }

  function remove(id) {
    ensure();
    var before = lib.presets.length;
    lib.presets = lib.presets.filter(function (p) { return p.id !== id; });
    if (lib.presets.length !== before) { save(); return true; }
    return false;
  }

  /** 重命名预设，并同步内嵌的节点名（实例化时会优先使用内嵌名称） */
  function rename(id, name) {
    ensure();
    var p = get(id);
    if (!p) return false;
    var newName = M.str(name, '').trim();
    if (!newName) return false;
    var old = p.name;
    p.name = newName;
    if (p.type === 'machine' && p.machine && p.machine.name === old) p.machine.name = newName;
    if (p.diamond && p.diamond.name === old) p.diamond.name = newName;
    save();
    return true;
  }

  function clearAll() {
    lib = emptyLib();
    save();
  }

  /** 从流程中的节点生成预设（物品按名称+物态内嵌快照，便于跨文件复用） */
  function fromNode(flow, node) {
    ensure();
    if (!node) return null;
    var p;
    if (node.kind === 'machine') {
      p = {
        id: M.uid('ps'), type: 'machine',
        name: uniquePresetName(node.name, 'machine'),
        desc: '',
        machine: {
          name: node.name,
          power: M.num(node.power, 0),
          ticks: M.num(node.ticks, M.TICKS_PER_SECOND, 1),
          inputs: (node.recipe.inputs || []).map(function (r) { return { item: snapshotItem(flow, r.itemId), count: r.count }; }),
          outputs: (node.recipe.outputs || []).map(function (r) { return { item: snapshotItem(flow, r.itemId), count: r.count }; })
        }
      };
    } else if (node.kind === 'buffer') {
      p = {
        id: M.uid('ps'), type: 'buffer',
        name: uniquePresetName(node.name, 'buffer'),
        desc: '',
        buffer: {
          name: node.name,
          inputs: (node.recipe.inputs || []).map(function (r) { return { item: snapshotItem(flow, r.itemId), count: r.count }; })
        }
      };
    } else if (node.kind === 'diamond') {
      var mode = node.mode === 'sink' ? 'sink' : 'source';
      p = {
        id: M.uid('ps'), type: mode,
        name: uniquePresetName(node.name, mode),
        desc: '',
        diamond: mode === 'source'
          ? { name: node.name, item: snapshotItem(flow, node.emit.itemId), count: node.emit.count, ticks: node.emit.ticks }
          : { name: node.name, filterItem: snapshotItem(flow, node.filter.itemId), filterCount: node.filter.count, count: 0, ticks: M.TICKS_PER_SECOND }
      };
    } else return null;
    return p;
  }

  function fromItem(flow, item) {
    ensure();
    if (!item) return null;
    return {
      id: M.uid('ps'), type: 'item',
      name: uniquePresetName(item.name, 'item'),
      desc: '',
      item: { name: item.name, state: item.state, color: item.color, note: item.note || '' }
    };
  }

  /** 用预设创建节点（会按需在当前流程中创建物品） */
  function instantiate(flow, preset, x, y) {
    var p = normalizePreset(preset);
    if (!p) return null;
    if (p.type === 'machine') {
      var m = M.makeMachine({
        name: p.machine.name || p.name,
        x: x, y: y, power: p.machine.power, ticks: p.machine.ticks,
        inputs: p.machine.inputs.map(function (l) { return M.makeRecipeLine(M.ensureItem(flow, l.item), l.count); }),
        outputs: p.machine.outputs.map(function (l) { return M.makeRecipeLine(M.ensureItem(flow, l.item), l.count); })
      });
      return m;
    }
    if (p.type === 'source') {
      return M.makeDiamond('source', {
        name: p.diamond.name || p.name, x: x, y: y,
        itemId: M.ensureItem(flow, p.diamond.item),
        count: p.diamond.count, ticks: p.diamond.ticks
      });
    }
    if (p.type === 'buffer') {
      return M.makeBuffer({
        name: p.buffer.name || p.name, x: x, y: y,
        inputs: p.buffer.inputs.map(function (l) { return M.makeRecipeLine(M.ensureItem(flow, l.item), l.count); })
      });
    }
    if (p.type === 'sink') {
      return M.makeDiamond('sink', {
        name: p.diamond.name || p.name, x: x, y: y,
        filterItemId: p.diamond.filterItem ? M.ensureItem(flow, p.diamond.filterItem) : '',
        filterCount: p.diamond.filterCount
      });
    }
    if (p.type === 'item') {
      // 物品预设：确保物品存在，返回 null（不是节点）
      M.ensureItem(flow, p.item);
      return null;
    }
    return null;
  }

  /** 把预设套用到已有节点上（保留位置与 id） */
  function applyToNode(flow, preset, node) {
    var p = normalizePreset(preset);
    if (!p || !node) return false;
    if (p.type === 'machine' && node.kind === 'machine') {
      node.name = p.machine.name || p.name;
      node.power = p.machine.power;
      node.ticks = p.machine.ticks;
      node.recipe.inputs = p.machine.inputs.map(function (l) { return M.makeRecipeLine(M.ensureItem(flow, l.item), l.count); });
      node.recipe.outputs = p.machine.outputs.map(function (l) { return M.makeRecipeLine(M.ensureItem(flow, l.item), l.count); });
      return true;
    }
    if (p.type === 'buffer' && node.kind === 'buffer') {
      node.name = p.buffer.name || p.name;
      node.recipe.inputs = p.buffer.inputs.map(function (l) { return M.makeRecipeLine(M.ensureItem(flow, l.item), l.count); });
      return true;
    }
    if ((p.type === 'source' || p.type === 'sink') && node.kind === 'diamond' && node.mode === p.type) {
      node.name = p.diamond.name || p.name;
      if (p.type === 'source') {
        node.emit.itemId = M.ensureItem(flow, p.diamond.item);
        node.emit.count = p.diamond.count;
        node.emit.ticks = p.diamond.ticks;
      } else {
        node.filter.itemId = p.diamond.filterItem ? M.ensureItem(flow, p.diamond.filterItem) : '';
        node.filter.count = p.diamond.filterCount;
      }
      return true;
    }
    if (p.type === 'item') {
      M.ensureItem(flow, p.item);
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ 文件读写 */

  function exportObject() {
    ensure();
    return { format: M.PRESET_FORMAT, version: M.PRESET_VERSION, updatedAt: new Date().toISOString(), presets: M.deepClone(lib.presets) };
  }

  function importObject(obj, opts) {
    opts = opts || {};
    var incoming = normalizeLibrary(obj);
    if (!opts.merge) {
      lib = incoming;
      save();
      return { added: incoming.presets.length, total: lib.presets.length };
    }
    ensure();
    var added = 0;
    incoming.presets.forEach(function (p) {
      var dup = lib.presets.filter(function (q) { return q.type === p.type && q.name === p.name; })[0];
      if (dup) {
        var i = lib.presets.indexOf(dup);
        p.id = dup.id;
        lib.presets[i] = p;
      } else {
        p.id = M.uid('ps');
        lib.presets.push(p);
      }
      added++;
    });
    save();
    return { added: added, total: lib.presets.length };
  }

  function exportFile() {
    ensure();
    var text = JSON.stringify(exportObject(), null, 2);
    var name = 'GT预设库-' + new Date().toISOString().slice(0, 10) + '.gtpresets.json';
    if (storeApi()) storeApi().download(name, text);
    return text;
  }

  function importText(text, opts) {
    var raw;
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: '预设文件不是合法 JSON：' + e.message }; }
    if (raw.format && raw.format !== M.PRESET_FORMAT) {
      // 允许直接导入纯数组或 {presets:[...]}
    }
    var res = importObject(raw, opts || { merge: true });
    return { ok: true, added: res.added, total: res.total };
  }

  api.TYPE_LABEL = TYPE_LABEL;
  api.TYPE_ORDER = TYPE_ORDER;
  api.load = load;
  api.save = save;
  api.ensure = ensure;
  api.list = list;
  api.get = get;
  api.upsert = upsert;
  api.remove = remove;
  api.rename = rename;
  api.clearAll = clearAll;
  api.uniquePresetName = uniquePresetName;
  api.fromNode = fromNode;
  api.fromItem = fromItem;
  api.instantiate = instantiate;
  api.applyToNode = applyToNode;
  api.normalizePreset = normalizePreset;
  api.normalizeLibrary = normalizeLibrary;
  api.exportObject = exportObject;
  api.importObject = importObject;
  api.exportFile = exportFile;
  api.importText = importText;
  return api;
});
