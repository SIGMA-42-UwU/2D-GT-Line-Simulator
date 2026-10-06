/* ============================================================================
 * GT 产线模拟器 — store.js
 * 应用状态 / 撤销重做 / 本地存储（localStorage）/ 流程文件导入导出
 * ==========================================================================*/
(function (root, factory) {
  'use strict';
  var api = factory(root.GT && root.GT.model, root.GT && root.GT.graph);
  root.GT = root.GT || {};
  root.GT.store = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M, G) {
  'use strict';
  if (!M) throw new Error('store.js 需要先加载 model.js');
  if (!G) throw new Error('store.js 需要先加载 graph.js');

  var GLOBAL = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);
  function presetsApi() { return (GLOBAL.GT && GLOBAL.GT.presets) || null; }

  var K_WORKING = 'gtline.working.v1';
  var K_INDEX = 'gtline.flows.index.v1';
  var K_PREFIX = 'gtline.flow.v1.';
  var K_PREFS = 'gtline.prefs.v1';
  var K_CURRENT = 'gtline.current.v1';
  var HISTORY_CAP = 80;

  /* ------------------------------------------------------------ 事件总线 */

  var listeners = {};
  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
    return function () { off(evt, fn); };
  }
  function off(evt, fn) {
    var a = listeners[evt] || [];
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  function emit(evt, payload) {
    var a = (listeners[evt] || []).slice();
    for (var i = 0; i < a.length; i++) {
      try { a[i](payload); } catch (e) { console.error('[store] 监听器错误 ' + evt, e); }
    }
  }

  /* --------------------------------------------------------- 存储可用性 */

  var storageOk = true;
  function safeSet(key, value) {
    if (!storageOk) return false;
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      storageOk = false;
      emit('storage:failed', e);
      emit('toast', { level: 'error', text: '本地存储不可用（可能是浏览器隐私模式或空间已满）：' + e.message + '，请使用“导出流程”保存你的工作。' });
      return false;
    }
  }
  function safeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }
  function probeStorage() {
    try {
      var t = '__gtline_probe__';
      window.localStorage.setItem(t, '1');
      window.localStorage.removeItem(t);
      storageOk = true;
    } catch (e) {
      storageOk = false;
    }
    return storageOk;
  }

  /* -------------------------------------------------------------- 状态 */

  var state = {
    flow: M.createFlow('未命名产线'),
    view: { x: 0, y: 0, zoom: 1 },
    selection: { nodes: [], links: [] },
    hover: { nodeId: null, linkId: null, port: null },
    run: { playing: false, speed: 1, phase: 0 },
    prefs: { grid: true, snap: false, showLabels: true, showRates: true, autoFit: true },
    analysis: G.emptyAnalysis(),
    sim: null,
    presets: { format: M.PRESET_FORMAT, version: M.PRESET_VERSION, presets: [] },
    currentFlowId: '',
    dirty: false,
    storageOk: true
  };

  var history = { past: [], future: [] };

  function snapshot() {
    return JSON.stringify({ flow: state.flow, view: state.view });
  }
  function pushHistory() {
    history.past.push(snapshot());
    if (history.past.length > HISTORY_CAP) history.past.shift();
    history.future.length = 0;
  }
  function restore(snap) {
    var o = JSON.parse(snap);
    var keepNodes = state.selection.nodes.slice();
    var keepLinks = state.selection.links.slice();
    state.flow = M.normalizeFlow(o.flow).flow;
    if (o.view) state.view = { x: M.num(o.view.x, 0), y: M.num(o.view.y, 0), zoom: M.num(o.view.zoom, 1, 0.15, 4) };
    state.flow.view = { x: state.view.x, y: state.view.y, zoom: state.view.zoom };
    // 尽量保留选择集（id 仍存在则继续选中，撤销后属性面板不会突然消失）
    state.selection = {
      nodes: keepNodes.filter(function (id) { return !!M.findNode(state.flow, id); }),
      links: keepLinks.filter(function (id) {
        return state.flow.links.some(function (l) { return l.id === id; });
      })
    };
    refresh();
    emit('flow:replaced', { reason: 'history' });
    emit('selection', state.selection);
    emit('change');
  }

  /* ---------------------------------------------------------- 计算刷新 */

  function refresh() {
    state.analysis = G.analyze(state.flow);
    state.sim = G.simulate(state.flow, state.analysis);
    emit('analysis', state.analysis);
  }

  /** 把视图（平移/缩放）写回流程对象，随存档一起保存 */
  function syncView() {
    if (state.flow) state.flow.view = { x: state.view.x, y: state.view.y, zoom: state.view.zoom };
  }
  function adoptView() {
    var v = (state.flow && state.flow.view) || { x: 0, y: 0, zoom: 1 };
    state.view = { x: M.num(v.x, 0), y: M.num(v.y, 0), zoom: M.num(v.zoom, 1, 0.15, 4) };
  }

  /** 一次可撤销的修改：fn 内部直接改 state.flow */
  function mutate(label, fn) {
    var before = snapshot();
    var r;
    try {
      r = fn();
    } catch (e) {
      console.error('[store] 修改失败：' + label, e);
      emit('toast', { level: 'error', text: '操作失败：' + e.message });
      return undefined;
    }
    var after = snapshot();
    if (after !== before) {
      history.past.push(before);
      if (history.past.length > HISTORY_CAP) history.past.shift();
      history.future.length = 0;
      state.dirty = true;
      state.flow.meta.updatedAt = new Date().toISOString();
      refresh();
      emit('change', { label: label });
      scheduleAutosave();
    }
    return r;
  }

  function canUndo() { return history.past.length > 0; }  function canRedo() { return history.future.length > 0; }
  function undo() {
    if (!canUndo()) return false;
    var cur = snapshot();
    history.future.push(cur);
    var prev = history.past.pop();
    restore(prev);
    state.dirty = true;
    scheduleAutosave();
    emit('toast', { level: 'info', text: '已撤销' });
    return true;
  }
  function redo() {
    if (!canRedo()) return false;
    var next = history.future.pop();
    history.past.push(snapshot());
    restore(next);
    state.dirty = true;
    scheduleAutosave();
    emit('toast', { level: 'info', text: '已重做' });
    return true;
  }
  function resetHistory() { history.past.length = 0; history.future.length = 0; }

  /** 供拖拽等“直接改 flow”的交互使用：先取快照，结束时提交 */
  function beginDrag() { return snapshot(); }
  function commitDrag(before, label) {
    if (!before) return false;
    var after = snapshot();
    if (after === before) return false;
    history.past.push(before);
    if (history.past.length > HISTORY_CAP) history.past.shift();
    history.future.length = 0;
    state.dirty = true;
    state.flow.meta.updatedAt = new Date().toISOString();
    refresh();
    emit('change', { label: label || '拖拽' });
    scheduleAutosave();
    return true;
  }

  /* -------------------------------------------------------- 选择集操作 */

  function selectNodes(ids, additive) {
    if (!additive) state.selection = { nodes: [], links: [] };
    (ids || []).forEach(function (id) {
      if (state.selection.nodes.indexOf(id) < 0) state.selection.nodes.push(id);
    });
    emit('selection', state.selection);
    emit('change', { label: 'select' });
  }
  function selectLinks(ids, additive) {
    if (!additive) state.selection = { nodes: [], links: [] };
    (ids || []).forEach(function (id) {
      if (state.selection.links.indexOf(id) < 0) state.selection.links.push(id);
    });
    emit('selection', state.selection);
    emit('change', { label: 'select' });
  }
  function toggleNode(id, on) {
    var i = state.selection.nodes.indexOf(id);
    if (on === false || (on === undefined && i >= 0)) {
      if (i >= 0) state.selection.nodes.splice(i, 1);
    } else if (i < 0) {
      state.selection.nodes.push(id);
    }
    emit('selection', state.selection);
    emit('change', { label: 'select' });
  }
  function clearSelection() {
    state.selection = { nodes: [], links: [] };
    emit('selection', state.selection);
    emit('change', { label: 'select' });
  }
  function selectedNodes() {
    var res = [];
    state.selection.nodes.forEach(function (id) {
      var n = M.findNode(state.flow, id);
      if (n) res.push(n);
    });
    return res;
  }
  function selectedLinks() {
    var res = [];
    state.selection.links.forEach(function (id) {
      for (var i = 0; i < state.flow.links.length; i++) if (state.flow.links[i].id === id) { res.push(state.flow.links[i]); break; }
    });
    return res;
  }

  /* --------------------------------------------------------- 流程 CRUD */

  function addNode(node, opts) {
    return mutate((opts && opts.label) || '添加节点', function () {
      state.flow.nodes.push(node);
      return node;
    });
  }
  function removeNodes(ids) {
    mutate('删除节点', function () {
      state.flow.nodes = state.flow.nodes.filter(function (n) { return ids.indexOf(n.id) < 0; });
      state.flow.links = state.flow.links.filter(function (l) {
        return ids.indexOf(l.from.nodeId) < 0 && ids.indexOf(l.to.nodeId) < 0;
      });
      state.selection.nodes = state.selection.nodes.filter(function (id) { return ids.indexOf(id) < 0; });
    });
    emit('selection', state.selection);
  }
  function removeLinks(ids) {
    mutate('删除连线', function () {
      state.flow.links = state.flow.links.filter(function (l) { return ids.indexOf(l.id) < 0; });
      state.selection.links = state.selection.links.filter(function (id) { return ids.indexOf(id) < 0; });
    });
    emit('selection', state.selection);
  }
  function deleteSelection() {
    var n = state.selection.nodes.slice();
    var l = state.selection.links.slice();
    if (!n.length && !l.length) return false;
    mutate('删除所选', function () {
      state.flow.nodes = state.flow.nodes.filter(function (x) { return n.indexOf(x.id) < 0; });
      state.flow.links = state.flow.links.filter(function (x) {
        return l.indexOf(x.id) < 0 && n.indexOf(x.from.nodeId) < 0 && n.indexOf(x.to.nodeId) < 0;
      });
      state.selection = { nodes: [], links: [] };
    });
    emit('selection', state.selection);
    return true;
  }

  function addLink(fromNodeId, fromIndex, toNodeId, toIndex) {
    var flow = state.flow;
    if (fromNodeId === toNodeId) {
      emit('toast', { level: 'warn', text: '不能把节点连接到它自己。' });
      return null;
    }
    for (var i = 0; i < flow.links.length; i++) {
      var l = flow.links[i];
      if (l.from.nodeId === fromNodeId && (l.from.index | 0) === (fromIndex | 0) &&
        l.to.nodeId === toNodeId && (l.to.index | 0) === (toIndex | 0)) {
        emit('toast', { level: 'warn', text: '这两个端口之间已经有连线了。' });
        return null;
      }
    }
    var link = { id: M.uid('lnk'), from: { nodeId: fromNodeId, side: 'out', index: fromIndex | 0 }, to: { nodeId: toNodeId, side: 'in', index: toIndex | 0 }, note: '' };
    mutate('连线', function () { flow.links.push(link); });
    return link;
  }

  function addItem(item) {
    return mutate('添加物品', function () { state.flow.items.push(item); return item; });
  }
  function removeItem(itemId) {
    var used = 0;
    var flow = state.flow;
    flow.nodes.forEach(function (n) {
      if (n.kind === 'diamond') {
        if ((n.emit && n.emit.itemId) === itemId) used++;
        if ((n.filter && n.filter.itemId) === itemId) used++;
      } else if (n.kind === 'machine' && n.recipe) {
        (n.recipe.inputs || []).forEach(function (r) { if (r.itemId === itemId) used++; });
        (n.recipe.outputs || []).forEach(function (r) { if (r.itemId === itemId) used++; });
      } else if (n.kind === 'buffer' && n.recipe) {
        (n.recipe.inputs || []).forEach(function (r) { if (r.itemId === itemId) used++; });
      }
    });
    mutate('删除物品', function () {
      state.flow.items = flow.items.filter(function (it) { return it.id !== itemId; });
    });
    return used;
  }
  function updateItem(itemId, patch) {
    mutate('修改物品', function () {
      var it = M.findItem(state.flow, itemId);
      if (it) Object.keys(patch).forEach(function (k) { it[k] = patch[k]; });
    });
  }

  /* ------------------------------------------------------ 本地存储读写 */

  function prefsLoad() {
    var raw = safeGet(K_PREFS);
    if (raw) {
      try {
        var p = JSON.parse(raw);
        Object.keys(state.prefs).forEach(function (k) { if (p[k] !== undefined) state.prefs[k] = p[k]; });
      } catch (e) { /* ignore */ }
    }
  }
  function prefsSave() { safeSet(K_PREFS, JSON.stringify(state.prefs)); }

  function listFlows() {
    var raw = safeGet(K_INDEX);
    if (!raw) return [];
    try {
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    } catch (e) { return []; }
  }
  function writeIndex(arr) { safeSet(K_INDEX, JSON.stringify(arr)); }

  function saveFlowAs(name, opts) {
    opts = opts || {};
    var flow = state.flow;
    syncView();
    var text = M.flowToText(flow);
    var id = opts.newId ? M.uid('flow') : (flow.meta.id || M.uid('flow'));
    flow.meta.id = id;
    if (name) flow.meta.name = name;
    text = M.flowToText(flow);
    var okWrite = safeSet(K_PREFIX + id, text);
    var idx = listFlows().filter(function (e) { return e.id !== id; });
    idx.push({
      id: id, name: flow.meta.name, updatedAt: new Date().toISOString(),
      createdAt: flow.meta.createdAt || new Date().toISOString(),
      nodes: flow.nodes.length, links: flow.links.length, items: flow.items.length,
      bytes: text.length
    });
    writeIndex(idx);
    state.currentFlowId = id;
    safeSet(K_CURRENT, id);
    state.dirty = false;
    emit('flows:changed');
    emit('change', { label: 'save' });
    return { ok: okWrite, id: id };
  }

  function openFlow(id) {
    var text = safeGet(K_PREFIX + id);
    if (!text) {
      emit('toast', { level: 'error', text: '找不到该流程存档。' });
      return false;
    }
    var parsed = M.parseFlowText(text);
    if (!parsed.ok) {
      emit('toast', { level: 'error', text: '存档损坏：' + parsed.error });
      return false;
    }
    if (parsed.flow.meta.id !== id) parsed.flow.meta.id = id;
    state.flow = parsed.flow;
    state.selection = { nodes: [], links: [] };
    adoptView();
    state.currentFlowId = id;
    safeSet(K_CURRENT, id);
    state.dirty = false;
    resetHistory();
    refresh();
    prefsSave();
    emit('flow:replaced', { reason: 'open', warnings: parsed.warnings });
    emit('change', { label: 'open' });
    return true;
  }

  function deleteFlow(id) {
    safeRemove(K_PREFIX + id);
    writeIndex(listFlows().filter(function (e) { return e.id !== id; }));
    if (state.currentFlowId === id) { state.currentFlowId = ''; safeRemove(K_CURRENT); }
    emit('flows:changed');
  }

  function renameFlow(id, name) {
    var text = safeGet(K_PREFIX + id);
    var idx = listFlows();
    idx.forEach(function (e) { if (e.id === id) { e.name = name; e.updatedAt = new Date().toISOString(); } });
    writeIndex(idx);
    if (text) {
      var parsed = M.parseFlowText(text);
      if (parsed.ok) {
        parsed.flow.meta.name = name;
        safeSet(K_PREFIX + id, M.flowToText(parsed.flow));
      }
    }
    if (state.currentFlowId === id) state.flow.meta.name = name;
    emit('flows:changed');
    emit('change', { label: 'rename' });
  }

  function duplicateFlow(id, newName) {
    var text = safeGet(K_PREFIX + id);
    if (!text) return false;
    var parsed = M.parseFlowText(text);
    if (!parsed.ok) return false;
    var flow = parsed.flow;
    flow.meta.id = M.uid('flow');
    flow.meta.name = newName || (flow.meta.name + ' 副本');
    flow.meta.createdAt = new Date().toISOString();
    var nid = flow.meta.id;
    safeSet(K_PREFIX + nid, M.flowToText(flow));
    var idx = listFlows();
    idx.push({
      id: nid, name: flow.meta.name, updatedAt: new Date().toISOString(), createdAt: flow.meta.createdAt,
      nodes: flow.nodes.length, links: flow.links.length, items: flow.items.length, bytes: 0
    });
    writeIndex(idx);
    emit('flows:changed');
    return true;
  }

  /* ------------------------------------------------------------ 自动保存 */

  var autosaveTimer = null;
  function scheduleAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      autosaveTimer = null;
      writeWorking();
    }, 700);
  }
  function writeWorking() {
    syncView();
    safeSet(K_WORKING, M.flowToText(state.flow));
    emit('persist', { ok: true });
  }

  function loadWorking() {
    var raw = safeGet(K_WORKING);
    if (!raw) return false;
    var parsed = M.parseFlowText(raw);
    if (!parsed.ok) return false;
    state.flow = parsed.flow;
    adoptView();
    var cur = safeGet(K_CURRENT);
    state.currentFlowId = cur || '';
    return true;
  }

  /* ------------------------------------------------------------ 文件导入导出 */

  function sanitizeFilename(name) {
    return String(name || 'flow').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'flow';
  }

  function download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1500);
      return true;
    } catch (e) {
      emit('toast', { level: 'error', text: '导出失败：' + e.message });
      return false;
    }
  }

  function exportFlow() {
    syncView();
    var text = M.flowToText(state.flow);
    download(sanitizeFilename(state.flow.meta.name) + '.gtline.json', text);
    emit('toast', { level: 'info', text: '已导出流程文件（.gtline.json）' });
  }

  function exportBackup() {
    syncView();
    var flows = [];
    listFlows().forEach(function (e) {
      var t = safeGet(K_PREFIX + e.id);
      if (!t) return;
      var p = M.parseFlowText(t);
      if (p.ok) flows.push(p.flow);
    });
    var bundle = {
      format: 'gtline.backup', version: 1, exportedAt: new Date().toISOString(),
      working: state.flow, presets: presetsApi() ? presetsApi().exportObject() : null, flows: flows
    };
    download('GT产线备份-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(bundle, null, 2));
  }

  function importBackup(text) {
    var raw;
    try { raw = JSON.parse(text); } catch (e) { emit('toast', { level: 'error', text: '备份文件不是合法 JSON。' }); return false; }
    if (raw.format !== 'gtline.backup') { emit('toast', { level: 'error', text: '不是本站点导出的备份文件。' }); return false; }
    var idx = listFlows();
    var count = 0;
    (raw.flows || []).forEach(function (f) {
      var p = M.normalizeFlow(f);
      p.flow.meta.id = p.flow.meta.id || M.uid('flow');
      safeSet(K_PREFIX + p.flow.meta.id, M.flowToText(p.flow));
      idx.push({
        id: p.flow.meta.id, name: p.flow.meta.name, updatedAt: p.flow.meta.updatedAt,
        createdAt: p.flow.meta.createdAt, nodes: p.flow.nodes.length, links: p.flow.links.length, items: p.flow.items.length
      });
      count++;
    });
    writeIndex(idx);
    if (raw.presets && presetsApi()) presetsApi().importObject(raw.presets, { merge: true });
    if (raw.working) {
      var wp = M.normalizeFlow(raw.working);
      state.flow = wp.flow;
      resetHistory(); refresh();
      emit('flow:replaced', { reason: 'import-backup' });
    }
    emit('flows:changed');
    emit('toast', { level: 'info', text: '已导入备份：' + count + ' 个流程存档。' });
    return true;
  }

  function importFlowText(text) {
    var parsed = M.parseFlowText(text);
    if (!parsed.ok) {
      emit('toast', { level: 'error', text: '导入失败：' + parsed.error });
      return false;
    }
    state.flow = parsed.flow;
    state.selection = { nodes: [], links: [] };
    adoptView();
    state.currentFlowId = '';
    safeRemove(K_CURRENT);
    state.dirty = true;
    resetHistory();
    refresh();
    scheduleAutosave();
    emit('flow:replaced', { reason: 'import', warnings: parsed.warnings });
    emit('change', { label: 'import' });
    if (parsed.warnings && parsed.warnings.length) {
      emit('toast', { level: 'warn', text: '导入完成，但有 ' + parsed.warnings.length + ' 条修正：' + parsed.warnings.slice(0, 3).join(' ') });
    } else {
      emit('toast', { level: 'info', text: '已导入流程“' + parsed.flow.meta.name + '”' });
    }
    return true;
  }

  function readFile(file, cb) {
    var fr = new FileReader();
    fr.onload = function () { cb(String(fr.result || ''), file); };
    fr.onerror = function () { emit('toast', { level: 'error', text: '读取文件失败。' }); };
    fr.readAsText(file, 'utf-8');
  }

  function newFlow(name) {
    state.flow = M.createFlow(name || '未命名产线');
    state.selection = { nodes: [], links: [] };
    adoptView();
    state.currentFlowId = '';
    safeRemove(K_CURRENT);
    state.dirty = false;
    resetHistory();
    refresh();
    scheduleAutosave();
    emit('flow:replaced', { reason: 'new' });
    emit('change', { label: 'new' });
  }

  function init() {
    probeStorage();
    state.storageOk = storageOk;
    prefsLoad();
    var PS = presetsApi();
    if (PS) {
      state.presets = PS.load();
      PS.onChange = function (lib) {
        state.presets = lib;
        emit('presets:changed', lib);
      };
    }
    loadWorking();
    if (state.flow.nodes.length) {
      var cur = safeGet(K_CURRENT);
      state.currentFlowId = cur || '';
    }
    refresh();
  }

  return {
    state: state,
    on: on, off: off, emit: emit,
    init: init,
    refresh: refresh, mutate: mutate, syncView: syncView, adoptView: adoptView,
    pushHistory: pushHistory, resetHistory: resetHistory,
    beginDrag: beginDrag, commitDrag: commitDrag,
    canUndo: canUndo, canRedo: canRedo, undo: undo, redo: redo,
    selectNodes: selectNodes, selectLinks: selectLinks, toggleNode: toggleNode,
    clearSelection: clearSelection, selectedNodes: selectedNodes, selectedLinks: selectedLinks,
    addNode: addNode, removeNodes: removeNodes, removeLinks: removeLinks,
    deleteSelection: deleteSelection, addLink: addLink,
    addItem: addItem, removeItem: removeItem, updateItem: updateItem,
    listFlows: listFlows, saveFlowAs: saveFlowAs, openFlow: openFlow, deleteFlow: deleteFlow,
    renameFlow: renameFlow, duplicateFlow: duplicateFlow,
    newFlow: newFlow, exportFlow: exportFlow, importFlowText: importFlowText,
    exportBackup: exportBackup, importBackup: importBackup, readFile: readFile,
    writeWorking: writeWorking, scheduleAutosave: scheduleAutosave,
    prefsSave: prefsSave, download: download, sanitizeFilename: sanitizeFilename,
    isStorageOk: function () { return storageOk; }
  };
});
