/* ============================================================================
 * GT 产线模拟器 — model.js
 * 数据模型 / 端口几何 / 序列化 / 归一化
 *
 * 本文件不依赖 DOM，可在 Node 中直接 require 用于自动化测试。
 * 浏览器中通过全局 window.GT.model 访问。
 * ==========================================================================*/
(function (root, factory) {
  'use strict';
  var api = factory();
  root.GT = root.GT || {};
  root.GT.model = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 常量 */

  var FLOW_FORMAT = 'gtline.flow';
  var FLOW_VERSION = 1;
  var PRESET_FORMAT = 'gtline.presets';
  var PRESET_VERSION = 1;

  var SOLID = 'solid';
  var FLUID = 'fluid';
  var STATE_LABEL = { solid: '固体', fluid: '流体' };

  /** 空白物品的默认配色循环 */
  var ITEM_COLORS = [
    '#e0a13a', '#4aa3d8', '#6fbf5f', '#d4604a', '#a86ad6', '#d9c94a',
    '#3fc9b8', '#d1508f', '#8fa6bf', '#c98a4a', '#7f8fd8', '#5fb0a0'
  ];

  /** 画布网格尺寸（世界坐标） */
  var GRID = 24;
  /** 菱形端口方块半对角线 */
  var DIAMOND_HALF = 48;
  /** 机器矩形基准宽 / 最小高 / 标题栏高度 */
  var MACHINE_W = 200;
  var MACHINE_MIN_H = 132;
  var MACHINE_HEADER_H = 54;
  /** 缓存器：正方形，最小边长 / 标题栏高度 / 底部信息条留白 */
  var BUFFER_MIN_SIDE = 150;
  var BUFFER_HEADER_H = 44;
  var BUFFER_FOOTER_H = 26;
  /** 端口沿机器边缘的间距与上下留白 */
  var PORT_SPACING = 28;
  var PORT_MARGIN = 18;
  /** 1 秒 = 20 tick */
  var TICKS_PER_SECOND = 20;

  /* ------------------------------------------------------------ 基础工具 */

  var _seq = 0;
  function uid(prefix) {
    _seq = (_seq + 1) % 0xffff;
    var t = Date.now().toString(36).slice(-5);
    var r = Math.floor(Math.random() * 46656).toString(36);
    return String(prefix || 'n') + '-' + t + _seq.toString(36) + r;
  }

  function num(v, def, min, max) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) n = def;
    if (typeof min === 'number' && n < min) n = min;
    if (typeof max === 'number' && n > max) n = max;
    return n;
  }

  function str(v, def) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) return def === undefined ? '' : def;
    return String(v);
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function isDiamond(node) { return !!node && node.kind === 'diamond'; }
  function isMachine(node) { return !!node && node.kind === 'machine'; }
  function isBuffer(node) { return !!node && node.kind === 'buffer'; }

  /* -------------------------------------------------------------- 物品库 */

  function pickItemColor(seed) {
    var s = typeof seed === 'number' ? seed : String(seed || '').length;
    return ITEM_COLORS[Math.abs(Math.round(s)) % ITEM_COLORS.length];
  }

  function makeItem(partial) {
    partial = partial || {};
    return {
      id: partial.id || uid('item'),
      name: str(partial.name, '新物品'),
      state: partial.state === FLUID ? FLUID : SOLID,
      color: str(partial.color) || pickItemColor(partial.name || ''),
      note: str(partial.note, '')
    };
  }

  function findItem(flow, itemId) {
    if (!flow || !itemId) return null;
    for (var i = 0; i < flow.items.length; i++) {
      if (flow.items[i].id === itemId) return flow.items[i];
    }
    return null;
  }

  function findItemByName(flow, name, state) {
    if (!flow || !name) return null;
    for (var i = 0; i < flow.items.length; i++) {
      var it = flow.items[i];
      if (it.name === name && (!state || it.state === state)) return it;
    }
    return null;
  }

  function itemLabel(flow, itemId) {
    var it = findItem(flow, itemId);
    if (!it) return itemId ? '(已删除物品)' : '(未设置)';
    return it.name;
  }

  function itemFullLabel(flow, itemId) {
    var it = findItem(flow, itemId);
    if (!it) return '未设置物品';
    return it.name + ' · ' + (STATE_LABEL[it.state] || it.state);
  }

  /** 按 名称+状态 复用或新建物品，返回 itemId */
  function ensureItem(flow, snap) {
    if (!flow) return '';
    var name = '', state = SOLID, color = '';
    if (typeof snap === 'string') { name = snap; }
    else if (snap) {
      name = str(snap.name, '');
      state = snap.state === FLUID ? FLUID : SOLID;
      color = str(snap.color, '');
    }
    if (!name) return '';
    var found = findItemByName(flow, name, state) || findItemByName(flow, name, null);
    if (found) {
      if (color && !found.color) found.color = color;
      return found.id;
    }
    var item = makeItem({ name: name, state: state, color: color || pickItemColor(flow.items.length) });
    flow.items.push(item);
    return item.id;
  }

  /** 保证名称在给定集合中唯一 */
  function uniqueName(base, used) {
    base = str(base, '未命名') || '未命名';
    var set = {};
    (used || []).forEach(function (n) { set[n] = true; });
    if (!set[base]) return base;
    var i = 2;
    while (set[base + ' ' + i]) i++;
    return base + ' ' + i;
  }

  /* ---------------------------------------------------------------- 节点 */

  function makeRecipeLine(itemId, count) {
    return { id: uid('rl'), itemId: str(itemId, ''), count: num(count, 1, 1, 100000) };
  }

  /**
   * 菱形接口块：mode = 'source'（外部输入，1 个输出口）
   *                    'sink'  （外部输出，1 个输入口）
   */
  function makeDiamond(mode, opts) {
    opts = opts || {};
    var m = mode === 'sink' ? 'sink' : 'source';
    return {
      id: opts.id || uid('dia'),
      kind: 'diamond',
      mode: m,
      name: str(opts.name, m === 'source' ? '输入端' : '输出端'),
      x: num(opts.x, 0), y: num(opts.y, 0),
      emit: {                 // source 用：每 ticks tick 产出 count 个 itemId
        itemId: str(opts.itemId, ''),
        count: num(opts.count, 1, 1, 100000),
        ticks: num(opts.ticks, TICKS_PER_SECOND, 1, 100000)
      },
      filter: {               // sink 用：可选过滤（itemId 为空 = 接受任意）
        itemId: str(opts.filterItemId, ''),
        count: num(opts.filterCount, 0, 0, 100000)
      },
      note: str(opts.note, '')
    };
  }

  /** 机器：白板矩形，仅有名称 / 耗电 / 耗时 / 配方 */
  function makeMachine(opts) {
    opts = opts || {};
    return {
      id: opts.id || uid('mch'),
      kind: 'machine',
      name: str(opts.name, '机器'),
      x: num(opts.x, 0), y: num(opts.y, 0),
      power: num(opts.power, 0, 0, 1e9),       // EU/t
      ticks: num(opts.ticks, TICKS_PER_SECOND, 1, 1e9), // 单次配方耗时（tick）
      recipe: {
        inputs: Array.isArray(opts.inputs) ? opts.inputs : [],
        outputs: Array.isArray(opts.outputs) ? opts.outputs : []
      },
      note: str(opts.note, '')
    };
  }

  function machinePortCounts(node) {
    var n = 0, m = 0;
    if (isMachine(node) && node.recipe) {
      n = (node.recipe.inputs || []).length;
      m = (node.recipe.outputs || []).length;
    }
    return { inputs: n, outputs: m };
  }

  /**
   * 缓存器：白板正方形。只能配置「输入」，输出强制与输入一一对应
   * （第 i 个输出口的内容 = 第 i 个输入口的内容），因此端口数两侧相等。
   */
  function makeBuffer(opts) {
    opts = opts || {};
    return {
      id: opts.id || uid('buf'),
      kind: 'buffer',
      name: str(opts.name, '缓存器'),
      x: num(opts.x, 0), y: num(opts.y, 0),
      recipe: { inputs: Array.isArray(opts.inputs) ? opts.inputs : [] },
      note: str(opts.note, '')
    };
  }

  function bufferPortCount(node) {
    return ((node && node.recipe && node.recipe.inputs) || []).length;
  }

  function bufferSize(node) {
    var n = Math.max(1, bufferPortCount(node));
    // 底部额外留出 BUFFER_FOOTER_H，避免最后一行端口与底部“进/出”信息条重叠
    var side = Math.max(BUFFER_MIN_SIDE,
      BUFFER_HEADER_H + PORT_MARGIN * 2 + BUFFER_FOOTER_H + PORT_SPACING * (n - 1) + 8);
    return { w: side, h: side };
  }

  function machineSize(node) {
    var c = machinePortCounts(node);
    var maxPorts = Math.max(c.inputs, c.outputs, 1);
    var bodyH = Math.max(MACHINE_MIN_H - MACHINE_HEADER_H, PORT_MARGIN * 2 + PORT_SPACING * (maxPorts - 1));
    return { w: MACHINE_W, h: MACHINE_HEADER_H + bodyH };
  }

  /** 任意节点的外接尺寸（菱形 / 机器矩形 / 缓存器正方形） */
  function nodeSize(node) {
    if (isDiamond(node)) return { w: DIAMOND_HALF * 2, h: DIAMOND_HALF * 2 };
    if (isBuffer(node)) return bufferSize(node);
    return machineSize(node);
  }

  /** 机器主体（端口）区域的垂直范围，供渲染对齐使用 */
  function machineBody(node) {
    var s = machineSize(node);
    return { top: -s.h / 2 + MACHINE_HEADER_H, height: s.h - MACHINE_HEADER_H };
  }

  function diamondHalf() { return DIAMOND_HALF; }

  /** 节点的端口表（含配方/发射内容），index 与配方顺序一致 */
  function nodePorts(node) {
    var out = { inputs: [], outputs: [] };
    if (!node) return out;
    if (node.kind === 'diamond') {
      if (node.mode === 'source') {
        out.outputs.push({
          index: 0,
          itemId: str(node.emit && node.emit.itemId, ''),
          count: num(node.emit && node.emit.count, 1, 1, 100000),
          ticks: num(node.emit && node.emit.ticks, TICKS_PER_SECOND, 1, 100000)
        });
      } else {
        out.inputs.push({
          index: 0,
          itemId: str(node.filter && node.filter.itemId, ''),
          count: num(node.filter && node.filter.count, 0, 0, 100000),
          ticks: 0
        });
      }
    } else if (node.kind === 'machine') {
      var ins = (node.recipe && node.recipe.inputs) || [];
      var outs = (node.recipe && node.recipe.outputs) || [];
      for (var i = 0; i < ins.length; i++) {
        out.inputs.push({ index: i, lineId: ins[i].id, itemId: str(ins[i].itemId, ''), count: num(ins[i].count, 1, 1, 100000), ticks: 0 });
      }
      for (var j = 0; j < outs.length; j++) {
        out.outputs.push({ index: j, lineId: outs[j].id, itemId: str(outs[j].itemId, ''), count: num(outs[j].count, 1, 1, 100000), ticks: num(node.ticks, TICKS_PER_SECOND, 1, 1e9) });
      }
    } else if (node.kind === 'buffer') {
      // 输出强制镜像输入：第 i 个输出口 = 第 i 个输入口
      var bins = (node.recipe && node.recipe.inputs) || [];
      for (var b = 0; b < bins.length; b++) {
        var bitem = str(bins[b].itemId, '');
        var bcount = num(bins[b].count, 1, 1, 100000);
        out.inputs.push({ index: b, lineId: bins[b].id, itemId: bitem, count: bcount, ticks: 0 });
        out.outputs.push({ index: b, lineId: bins[b].id, mirrored: true, itemId: bitem, count: bcount, ticks: 0 });
      }
    }
    return out;
  }

  function portList(node, side) {
    var p = nodePorts(node);
    return side === 'in' ? p.inputs : p.outputs;
  }

  /** 端口相对节点中心的坐标 */
  function portLocal(node, side, index) {
    if (isDiamond(node)) {
      return { x: (side === 'in' ? -DIAMOND_HALF : DIAMOND_HALF), y: 0 };
    }
    var isBuf = isBuffer(node);
    var size = isBuf ? bufferSize(node) : machineSize(node);
    var headerH = isBuf ? BUFFER_HEADER_H : MACHINE_HEADER_H;
    var bodyTop = -size.h / 2 + headerH;
    var bodyH = size.h - headerH;
    var list = portList(node, side);
    var n = list.length;
    var usable = bodyH - PORT_MARGIN * 2 - (isBuf ? BUFFER_FOOTER_H : 0);
    if (usable < 0) usable = 0;
    var y;
    if (n <= 1) y = bodyTop + bodyH / 2 - (isBuf ? BUFFER_FOOTER_H / 2 : 0);
    else {
      index = clamp(index, 0, n - 1);
      y = bodyTop + PORT_MARGIN + usable * (index / (n - 1));
    }
    return { x: (side === 'in' ? -size.w / 2 : size.w / 2), y: y };
  }

  function portWorld(node, side, index) {
    var l = portLocal(node, side, index);
    return { x: node.x + l.x, y: node.y + l.y };
  }

  function nodeBounds(node) {
    if (isDiamond(node)) {
      return { x: node.x - DIAMOND_HALF, y: node.y - DIAMOND_HALF, w: DIAMOND_HALF * 2, h: DIAMOND_HALF * 2 };
    }
    var s = nodeSize(node);
    return { x: node.x - s.w / 2, y: node.y - s.h / 2, w: s.w, h: s.h };
  }

  function inPortKey(nodeId, index) { return nodeId + '|in|' + index; }
  function outPortKey(nodeId, index) { return nodeId + '|out|' + index; }
  function parsePortKey(key) {
    var p = String(key).split('|');
    return { nodeId: p[0], side: p[1], index: parseInt(p[2], 10) || 0 };
  }

  function recipeListOf(node, side) {
    if (!node || !node.recipe) return [];
    return side === 'inputs' ? node.recipe.inputs : node.recipe.outputs;
  }
  /**
   * 属于该机器/缓存器某一侧端口的连线。
   * 缓存器的第 i 个输入口与第 i 个输出口是同一条通道，因此统计输入行时
   * 也会把它镜像输出口上的连线一起算进来。
   */
  function recipeRowLinks(flow, node, side, index) {
    var res = [];
    if (!flow || !node) return res;
    var isIn = side === 'inputs';
    var isBuf = node.kind === 'buffer';
    for (var i = 0; i < flow.links.length; i++) {
      var l = flow.links[i];
      var owner = isIn ? l.to : l.from;
      if (owner && owner.nodeId === node.id && (owner.index | 0) === (index | 0)) { res.push(l); continue; }
      if (isBuf && isIn && l.from && l.from.nodeId === node.id && (l.from.index | 0) === (index | 0)) res.push(l);
    }
    return res;
  }

  /**
   * 交换配方中的两行，并让连线索引跟随配方行移动。
   * 语义：连线连接的是「需要某个物品的那个端口」，重排配方时端口与它的连线一起移动，
   * 不会让既有连线突然接到别的物品上而报错。
   * 缓存器：输入口 i 与输出口 i 是同一条通道，两侧连线要一起搬。
   */
  function moveRecipeRow(flow, node, side, index, delta) {
    var list = recipeListOf(node, side);
    var to = index + delta;
    if (to < 0 || to >= list.length || index < 0) return false;
    var t = list[index];
    list[index] = list[to];
    list[to] = t;
    var isIn = side === 'inputs';
    var isBuf = node.kind === 'buffer';
    function swap(owner) {
      if (!owner || owner.nodeId !== node.id) return;
      var cur = owner.index | 0;
      if (cur === index) owner.index = to;
      else if (cur === to) owner.index = index;
    }
    (flow.links || []).forEach(function (l) {
      swap(isIn ? l.to : l.from);
      if (isBuf && isIn) swap(l.from);   // 镜像输出口跟随同一条通道
    });
    return true;
  }

  /**
   * 删除配方中的一行：该行端口上的连线一并删除，其后端口的连线索引前移。
   * 缓存器：输入行 ↔ 镜像输出行是同一条通道，两侧连线一起删除/前移。
   * 返回 { removed:boolean, dropped:[] }
   */
  function removeRecipeRow(flow, node, side, index) {
    var list = recipeListOf(node, side);
    if (index < 0 || index >= list.length) return { removed: false, dropped: [] };
    var isIn = side === 'inputs';
    var isBuf = node.kind === 'buffer';
    var dropped = [];
    var kept = [];
    (flow.links || []).forEach(function (l) {
      var hit = false, shifted = false;
      var owner = isIn ? l.to : l.from;
      if (owner && owner.nodeId === node.id) {
        var cur = owner.index | 0;
        if (cur === index) hit = true;
        else if (cur > index) { owner.index = cur - 1; shifted = true; }
      }
      if (isBuf && isIn && l.from && l.from.nodeId === node.id) {
        var cur2 = l.from.index | 0;
        if (cur2 === index) hit = true;
        else if (cur2 > index) { l.from.index = cur2 - 1; shifted = true; }
      }
      if (hit) { dropped.push(l); return; }
      kept.push(l);
    });
    flow.links = kept;
    list.splice(index, 1);
    return { removed: true, dropped: dropped };
  }

  /** 清空一整侧配方：返回被删除的连线数（缓存器两侧同时清空） */
  function clearRecipeSide(flow, node, side) {
    var list = recipeListOf(node, side);
    var isIn = side === 'inputs';
    var isBuf = node.kind === 'buffer';
    var removed = 0;
    flow.links = (flow.links || []).filter(function (l) {
      var owner = isIn ? l.to : l.from;
      if (owner && owner.nodeId === node.id) { removed++; return false; }
      if (isBuf && isIn && l.from && l.from.nodeId === node.id) { removed++; return false; }
      return true;
    });
    list.length = 0;
    return removed;
  }

  /* -------------------------------------------------------------- 流程文件 */

  function createFlow(name) {
    return {
      format: FLOW_FORMAT,
      version: FLOW_VERSION,
      meta: {
        id: uid('flow'),
        name: str(name, '未命名产线'),
        note: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      view: { x: 0, y: 0, zoom: 1 },
      items: [],
      nodes: [],
      links: []
    };
  }

  function normalizeRecipeList(raw) {
    var list = [];
    if (!Array.isArray(raw)) return list;
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i] || {};
      list.push({
        id: r.id || uid('rl'),
        itemId: str(r.itemId, ''),
        count: num(r.count, 1, 1, 100000)
      });
    }
    return list;
  }

  /**
   * 归一化任意来源的流程数据；返回 { flow, warnings }
   * 尽力修复而不是直接失败，保证导入旧版本/手改文件也能打开。
   */
  function normalizeFlow(raw) {
    var warnings = [];
    if (!raw || typeof raw !== 'object') {
      var f0 = createFlow('未命名产线');
      warnings.push('文件内容为空，已创建空白产线。');
      return { flow: f0, warnings: warnings };
    }
    if (raw.format && raw.format !== FLOW_FORMAT) {
      warnings.push('文件格式标记为 “' + raw.format + '”，仍按流程文件尝试读取。');
    }
    var flow = createFlow(raw.meta && raw.meta.name);
    flow.meta.id = (raw.meta && raw.meta.id) || flow.meta.id;
    flow.meta.note = str(raw.meta && raw.meta.note, '');
    flow.meta.createdAt = str(raw.meta && raw.meta.createdAt, flow.meta.createdAt);
    flow.meta.updatedAt = str(raw.meta && raw.meta.updatedAt, flow.meta.updatedAt);

    var v = raw.view || {};
    flow.view = {
      x: num(v.x, 0, -1e7, 1e7),
      y: num(v.y, 0, -1e7, 1e7),
      zoom: num(v.zoom, 1, 0.15, 4)
    };

    // 物品
    var seenItem = {};
    var rawItems = Array.isArray(raw.items) ? raw.items : [];
    for (var i = 0; i < rawItems.length; i++) {
      var it = makeItem(rawItems[i]);
      if (seenItem[it.id]) { it.id = uid('item'); warnings.push('物品 id 重复，已重新分配：' + it.name); }
      seenItem[it.id] = true;
      flow.items.push(it);
    }

    // 节点
    var nodeIds = {};
    var rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    for (var n = 0; n < rawNodes.length; n++) {
      var rn = rawNodes[n] || {};
      var node = null;
      if (rn.kind === 'DiamondBlock') rn.kind = 'diamond'; // 兼容别名
      if (rn.kind === 'diamond' || rn.type === 'diamond') {
        node = makeDiamond(rn.mode === 'sink' ? 'sink' : 'source', {
          id: rn.id,
          name: rn.name,
          x: rn.x, y: rn.y,
          itemId: rn.emit && rn.emit.itemId,
          count: rn.emit && rn.emit.count,
          ticks: rn.emit && rn.emit.ticks,
          filterItemId: rn.filter && rn.filter.itemId,
          filterCount: rn.filter && rn.filter.count,
          note: rn.note
        });
      } else if (rn.kind === 'machine' || rn.type === 'machine') {
        node = makeMachine({
          id: rn.id, name: rn.name, x: rn.x, y: rn.y,
          power: rn.power, ticks: rn.ticks,
          inputs: normalizeRecipeList(rn.recipe && rn.recipe.inputs),
          outputs: normalizeRecipeList(rn.recipe && rn.recipe.outputs),
          note: rn.note
        });
      } else if (rn.kind === 'buffer' || rn.kind === 'cache' || rn.type === 'buffer' || rn.type === 'cache') {
        node = makeBuffer({
          id: rn.id, name: rn.name, x: rn.x, y: rn.y,
          inputs: normalizeRecipeList(rn.recipe && rn.recipe.inputs),
          note: rn.note
        });
      } else {
        warnings.push('忽略了无法识别的节点类型：' + str(rn.kind || rn.type, '?'));
        continue;
      }
      if (nodeIds[node.id]) {
        node.id = uid(node.kind === 'machine' ? 'mch' : (node.kind === 'buffer' ? 'buf' : 'dia'));
        warnings.push('节点 id 重复，已重新分配：' + node.name);
      }
      nodeIds[node.id] = node;
      flow.nodes.push(node);
    }

    // 连线
    var seenLink = {};
    var rawLinks = Array.isArray(raw.links) ? raw.links : [];
    for (var L = 0; L < rawLinks.length; L++) {
      var rl = rawLinks[L] || {};
      var from = rl.from || {};
      var to = rl.to || {};
      var fn = nodeIds[from.nodeId], tn = nodeIds[to.nodeId];
      if (!fn || !tn) { warnings.push('忽略了一条指向不存在节点的连线。'); continue; }
      if (fn.kind === 'diamond' && fn.mode !== 'source') { warnings.push('忽略了一条从输出端（汇）出发的连线。'); continue; }
      if (tn.kind === 'diamond' && tn.mode !== 'sink') { warnings.push('忽略了一条连到输入端（源）的连线。'); continue; }
      var fo = nodePorts(fn).outputs.length;
      var ti = nodePorts(tn).inputs.length;
      if (fo === 0 || ti === 0) { warnings.push('忽略了一条端口不存在的连线。'); continue; }
      var fi = parseInt(from.index, 10);
      var tix = parseInt(to.index, 10);
      if (!isFinite(fi)) fi = 0;
      if (!isFinite(tix)) tix = 0;
      if (fi < 0 || fi >= fo) {
        warnings.push('忽略了一条指向不存在输出口的连线（“' + fn.name + '”输出口 ' + (fi + 1) + '）。');
        continue;
      }
      if (tix < 0 || tix >= ti) {
        warnings.push('忽略了一条指向不存在输入口的连线（“' + tn.name + '”输入口 ' + (tix + 1) + '）。');
        continue;
      }
      var key = fn.id + ':' + fi + '>' + tn.id + ':' + tix;
      if (seenLink[key]) { warnings.push('忽略了一条重复连线。'); continue; }
      seenLink[key] = true;
      flow.links.push({
        id: rl.id || uid('lnk'),
        from: { nodeId: fn.id, side: 'out', index: fi },
        to: { nodeId: tn.id, side: 'in', index: tix },
        note: str(rl.note, '')
      });
    }

    return { flow: flow, warnings: warnings };
  }

  function parseFlowText(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: '文件内容为空。' };
    }
    var raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '不是合法的 JSON 文件：' + e.message };
    }
    var res = normalizeFlow(raw);
    return { ok: true, flow: res.flow, warnings: res.warnings };
  }

  function flowToText(flow) {
    var f = deepClone(flow);
    f.format = FLOW_FORMAT;
    f.version = FLOW_VERSION;
    if (f.meta) f.meta.updatedAt = new Date().toISOString();
    // 去掉运行时临时字段（__valid 等）
    return JSON.stringify(f, function (k, v) {
      if (k.indexOf('__') === 0) return undefined;
      return v;
    }, 2);
  }

  /* ------------------------------------------------------------ 格式化 */

  function fmtTicks(t) {
    var sec = (num(t, 0) / TICKS_PER_SECOND);
    return fmtNum(num(t, 0)) + ' t / ' + (Math.round(sec * 100) / 100) + ' s';
  }

  function fmtNum(n) {
    if (!isFinite(n)) return '0';
    var r = Math.round(n * 100) / 100;
    if (Math.abs(r - Math.round(r)) < 1e-9) return String(Math.round(r));
    return r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function ratePerSecond(count, ticks) {
    ticks = num(ticks, TICKS_PER_SECOND, 1);
    return num(count, 0) * TICKS_PER_SECOND / ticks;
  }

  function fmtRate(count, ticks) {
    return fmtNum(ratePerSecond(count, ticks)) + ' /s';
  }

  /* ----------------------------------------------------- 端口内容解析 */

  /**
   * 解析某个输出口“输出什么”。
   * 返回 { itemId, count, ticks, source:'emit'|'recipe' } 或 null（端口不存在）
   */
  function resolveOutPort(flow, nodeId, index) {
    var node = null;
    for (var i = 0; i < flow.nodes.length; i++) if (flow.nodes[i].id === nodeId) { node = flow.nodes[i]; break; }
    if (!node) return null;
    var list = nodePorts(node).outputs;
    if (!list.length) return null;
    var p = list[clamp(index | 0, 0, list.length - 1)];
    if (!p) return null;
    var ticks = 0, source = 'emit';
    if (node.kind === 'machine') { ticks = num(node.ticks, TICKS_PER_SECOND, 1); source = 'recipe'; }
    else if (node.kind === 'buffer') { ticks = 0; source = 'buffer'; }
    else { ticks = p.ticks; source = 'emit'; }
    return { itemId: p.itemId, count: p.count, ticks: ticks, source: source };
  }

  function resolveInPort(flow, nodeId, index) {
    var node = null;
    for (var i = 0; i < flow.nodes.length; i++) if (flow.nodes[i].id === nodeId) { node = flow.nodes[i]; break; }
    if (!node) return null;
    var list = nodePorts(node).inputs;
    if (!list.length) return null;
    var p = list[clamp(index | 0, 0, list.length - 1)];
    if (!p) return null;
    return { itemId: p.itemId, count: p.count, ticks: 0, source: node.kind === 'machine' ? 'recipe' : 'filter' };
  }

  function findNode(flow, nodeId) {
    if (!flow) return null;
    for (var i = 0; i < flow.nodes.length; i++) if (flow.nodes[i].id === nodeId) return flow.nodes[i];
    return null;
  }

  function isLinkedPort(flow, nodeId, side, index) {
    for (var i = 0; i < flow.links.length; i++) {
      var l = flow.links[i];
      if (side === 'in' && l.to.nodeId === nodeId && (l.to.index | 0) === (index | 0)) return true;
      if (side === 'out' && l.from.nodeId === nodeId && (l.from.index | 0) === (index | 0)) return true;
    }
    return false;
  }

  function linksOfPort(flow, nodeId, side, index) {
    var res = [];
    for (var i = 0; i < flow.links.length; i++) {
      var l = flow.links[i];
      if (side === 'in' && l.to.nodeId === nodeId && (l.to.index | 0) === (index | 0)) res.push(l);
      if (side === 'out' && l.from.nodeId === nodeId && (l.from.index | 0) === (index | 0)) res.push(l);
    }
    return res;
  }

  return {
    // 常量
    FLOW_FORMAT: FLOW_FORMAT, FLOW_VERSION: FLOW_VERSION,
    PRESET_FORMAT: PRESET_FORMAT, PRESET_VERSION: PRESET_VERSION,
    SOLID: SOLID, FLUID: FLUID, STATE_LABEL: STATE_LABEL,
    ITEM_COLORS: ITEM_COLORS, GRID: GRID, TICKS_PER_SECOND: TICKS_PER_SECOND,
    DIAMOND_HALF: DIAMOND_HALF, MACHINE_W: MACHINE_W, MACHINE_MIN_H: MACHINE_MIN_H,
    MACHINE_HEADER_H: MACHINE_HEADER_H, BUFFER_MIN_SIDE: BUFFER_MIN_SIDE,
    BUFFER_HEADER_H: BUFFER_HEADER_H, BUFFER_FOOTER_H: BUFFER_FOOTER_H,
    PORT_SPACING: PORT_SPACING, PORT_MARGIN: PORT_MARGIN,
    // 工具
    uid: uid, num: num, str: str, clamp: clamp, deepClone: deepClone,
    isDiamond: isDiamond, isMachine: isMachine, isBuffer: isBuffer,
    uniqueName: uniqueName,
    // 物品
    makeItem: makeItem, findItem: findItem, findItemByName: findItemByName,
    itemLabel: itemLabel, itemFullLabel: itemFullLabel, ensureItem: ensureItem,
    pickItemColor: pickItemColor,
    // 节点
    makeDiamond: makeDiamond, makeMachine: makeMachine, makeBuffer: makeBuffer,
    makeRecipeLine: makeRecipeLine,
    machineSize: machineSize, nodeSize: nodeSize, bufferSize: bufferSize, bufferPortCount: bufferPortCount,
    machineBody: machineBody, diamondHalf: diamondHalf, nodePorts: nodePorts,
    portList: portList, portLocal: portLocal, portWorld: portWorld, nodeBounds: nodeBounds,
    inPortKey: inPortKey, outPortKey: outPortKey, parsePortKey: parsePortKey,
    recipeListOf: recipeListOf, recipeRowLinks: recipeRowLinks,
    moveRecipeRow: moveRecipeRow, removeRecipeRow: removeRecipeRow, clearRecipeSide: clearRecipeSide,
    // 流程
    createFlow: createFlow, normalizeFlow: normalizeFlow,
    parseFlowText: parseFlowText, flowToText: flowToText,
    findNode: findNode,
    resolveOutPort: resolveOutPort, resolveInPort: resolveInPort,
    isLinkedPort: isLinkedPort, linksOfPort: linksOfPort,
    // 格式化
    fmtTicks: fmtTicks, fmtNum: fmtNum, fmtRate: fmtRate, ratePerSecond: ratePerSecond
  };
});
