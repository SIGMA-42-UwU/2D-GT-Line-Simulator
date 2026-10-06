/* ============================================================================
 * GT 产线模拟器 — 集成冒烟测试（无浏览器：自带迷你 DOM + 2D Context 桩）
 *   node tests/dom-smoke.test.js
 * 目的：真正执行 store/canvas/ui 的初始化与主要交互路径，捕获运行期错误。
 * ==========================================================================*/
'use strict';

var fs = require('fs');
var path = require('path');

/* --------------------------------------------------------------- 迷你 DOM */

function TextNode(text) {
  this.nodeType = 3;
  this.parentNode = null;
  this._text = String(text);
}
Object.defineProperty(TextNode.prototype, 'textContent', {
  get: function () { return this._text; },
  set: function (v) { this._text = String(v); }
});

function Elem(tag) {
  this.nodeType = 1;
  this.tagName = String(tag).toUpperCase();
  this.children = [];
  this.parentNode = null;
  this.attrs = {};
  this.dataset = {};
  this.style = {};
  this._classes = new Set();
  this._listeners = {};
  this._text = '';
  this.value = '';
  this.disabled = false;
  this.files = null;
  this.isContentEditable = false;
  this.type = '';
}
Object.defineProperty(Elem.prototype, 'className', {
  get: function () { return Array.from(this._classes).join(' '); },
  set: function (v) { this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
});
Object.defineProperty(Elem.prototype, 'classList', {
  get: function () {
    var s = this._classes;
    return {
      add: function () { for (var i = 0; i < arguments.length; i++) s.add(arguments[i]); },
      remove: function () { for (var i = 0; i < arguments.length; i++) s.delete(arguments[i]); },
      contains: function (c) { return s.has(c); },
      toggle: function (c, force) {
        var on = force === undefined ? !s.has(c) : !!force;
        if (on) s.add(c); else s.delete(c);
        return on;
      }
    };
  }
});
Object.defineProperty(Elem.prototype, 'firstChild', {
  get: function () { return this.children.length ? this.children[0] : null; }
});
Object.defineProperty(Elem.prototype, 'childNodes', {
  get: function () { return this.children; }
});
Object.defineProperty(Elem.prototype, 'lastChild', {
  get: function () { return this.children.length ? this.children[this.children.length - 1] : null; }
});
Object.defineProperty(Elem.prototype, 'textContent', {
  get: function () {
    if (this.children.length) return this.children.map(function (c) { return c.textContent || ''; }).join('');
    return this._text;
  },
  set: function (v) {
    this.children.forEach(function (c) { c.parentNode = null; });
    this.children = [];
    this._text = v === undefined || v === null ? '' : String(v);
  }
});
Object.defineProperty(Elem.prototype, 'innerHTML', {
  get: function () { return this._text; },
  set: function (v) {
    this.children.forEach(function (c) { c.parentNode = null; });
    this.children = [];
    this._text = String(v === undefined || v === null ? '' : v);
  }
});
Object.defineProperty(Elem.prototype, 'id', {
  get: function () { return this.attrs.id || ''; },
  set: function (v) { this.attrs.id = v; }
});
Elem.prototype.appendChild = function (c) {
  if (!c) return c;
  if (c.parentNode) c.parentNode.removeChild(c);
  c.parentNode = this;
  this.children.push(c);
  return c;
};
Elem.prototype.removeChild = function (c) {
  var i = this.children.indexOf(c);
  if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
  return c;
};
Elem.prototype.setAttribute = function (k, v) {
  this.attrs[k] = v;
  if (k === 'class') this.className = v;
  else if (k === 'id') this.attrs.id = v;
  else if (k === 'value') this.value = v;
  else if (k === 'disabled') this.disabled = true;
  else if (k === 'type') this.type = v;
};
Elem.prototype.getAttribute = function (k) { return this.attrs[k] === undefined ? null : this.attrs[k]; };
Elem.prototype.removeAttribute = function (k) { delete this.attrs[k]; };
Elem.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
Elem.prototype.removeEventListener = function (t, fn) {
  var a = this._listeners[t] || [];
  var i = a.indexOf(fn);
  if (i >= 0) a.splice(i, 1);
};
Elem.prototype.dispatch = function (evt) {
  var a = (this._listeners[evt.type] || []).slice();
  evt.target = evt.target || this;
  evt.preventDefault = evt.preventDefault || function () {};
  evt.stopPropagation = evt.stopPropagation || function () {};
  for (var i = 0; i < a.length; i++) a[i](evt);
  if (this.parentNode && !evt._noBubble) { evt._noBubble = true; this.parentNode.dispatch(evt); }
  return evt;
};
Elem.prototype.contains = function (n) {
  var cur = n;
  while (cur) { if (cur === this) return true; cur = cur.parentNode; }
  return false;
};
Elem.prototype.querySelector = function (sel) {
  var parts = String(sel).split(',').map(function (s) { return s.trim().toLowerCase(); });
  var self = this;
  function match(n) {
    if (n.nodeType !== 1) return false;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.charAt(0) === '.') { if (n._classes.has(p.slice(1))) return true; }
      else if (p.charAt(0) === '#') { if (n.id === p.slice(1)) return true; }
      else if (n.tagName.toLowerCase() === p) return true;
    }
    return false;
  }
  function walk(n) {
    for (var i = 0; i < n.children.length; i++) {
      var c = n.children[i];
      if (match(c)) return c;
      var r = walk(c);
      if (r) return r;
    }
    return null;
  }
  return walk(self);
};
Elem.prototype.querySelectorAll = function () { return []; };
Elem.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700 };
};
Elem.prototype.focus = function () { doc.activeElement = this; };
Elem.prototype.blur = function () {
  if (doc.activeElement === this) doc.activeElement = null;
  this.dispatch({ type: 'blur' });
};
Elem.prototype.click = function () { this.dispatch({ type: 'click' }); };
Elem.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
Elem.prototype.scrollIntoView = function () {};

function CanvasElem() {
  Elem.call(this, 'canvas');
  this.clientWidth = 1000;
  this.clientHeight = 700;
  this.width = 1000;
  this.height = 700;
}
CanvasElem.prototype = Object.create(Elem.prototype);
CanvasElem.prototype.constructor = CanvasElem;

/** 2D 上下文桩：任何未知方法都返回可链式调用的空对象，并记录所有绘制调用 */
var drawCalls = [];
function makeCtx() {
  var chain = {
    addColorStop: function () {},
    width: 10
  };
  var target = {};
  return new Proxy(target, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return function (s) { return { width: String(s).length * 6.2 }; };
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') {
        return function () { drawCalls.push({ m: String(k), a: Array.prototype.slice.call(arguments) }); return Object.create(chain); };
      }
      if (k === 'canvas') return null;
      return function () {
        drawCalls.push({ m: String(k), a: Array.prototype.slice.call(arguments) });
        return Object.create(chain);
      };
    },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
CanvasElem.prototype.getContext = function () {
  if (!this._ctx) this._ctx = makeCtx();
  return this._ctx;
};

var registry = {};
var doc = {
  nodeType: 9,
  _listeners: {},
  activeElement: null,
  createElement: function (tag) { return String(tag).toLowerCase() === 'canvas' ? new CanvasElem() : new Elem(tag); },
  createTextNode: function (t) { return new TextNode(t); },
  getElementById: function (id) { return registry[id] || null; },
  addEventListener: function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
  removeEventListener: function (t, fn) {
    var a = this._listeners[t] || [];
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  },
  dispatch: function (evt) {
    var a = (this._listeners[evt.type] || []).slice();
    evt.target = evt.target || this;
    evt.preventDefault = evt.preventDefault || function () {};
    evt.stopPropagation = evt.stopPropagation || function () {};
    for (var i = 0; i < a.length; i++) a[i](evt);
    return evt;
  }
};
doc.body = new Elem('body');
doc.documentElement = new Elem('html');
doc.readyState = 'complete';

var win = {
  devicePixelRatio: 1,
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: {
    _d: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem: function (k, v) { this._d[k] = String(v); },
    removeItem: function (k) { delete this._d[k]; }
  },
  addEventListener: function (t, fn) { (this._l = this._l || {})[t] = (this._l[t] || []).concat([fn]); },
  removeEventListener: function () {},
  dispatch: function (evt) {
    var a = ((this._l || {})[evt.type] || []).slice();
    for (var i = 0; i < a.length; i++) a[i](evt);
    return evt;
  },
  prompt: function () { return '新名字'; },
  confirm: function () { return true; }
};

globalThis.window = win;
globalThis.document = doc;
globalThis.requestAnimationFrame = function () { return 1; };
globalThis.cancelAnimationFrame = function () {};
globalThis.ResizeObserver = undefined;

/* 从 index.html 收集 id，预建 DOM 元素（保证 id 引用都能解析） */
var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
var idMatches = html.match(/id="[A-Za-z0-9_-]+"/g) || [];
var ids = idMatches.map(function (s) { return s.slice(4, -1); });
ids.forEach(function (id) {
  var e = id === 'board' ? new CanvasElem() : new Elem('div');
  e.setAttribute('id', id);
  registry[id] = e;
});
// 结构：把 canvas 放进 workspace，供 canvas.js 使用 parentElement
registry.workspace.appendChild(registry.board);

var M = require('../js/model.js');
var G = require('../js/graph.js');
var PS = require('../js/presets.js');
var S = require('../js/store.js');
var CV = require('../js/canvas.js');
var UI = require('../js/ui.js');

/* --------------------------------------------------------------- 断言工具 */

var pass = 0, fail = 0, failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; failures.push(msg); console.log('  \u2717 ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + '  [得到 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + ']'); }
function near(a, b, msg, eps) {
  eps = eps || 1e-6;
  ok(Math.abs(a - b) <= eps, msg + '  [得到 ' + a + '，期望 ' + b + ']');
}
function noThrow(fn, msg) {
  try { fn(); pass++; console.log('  \u2713 ' + msg); }
  catch (e) { fail++; failures.push(msg + ' → ' + e.message); console.log('  \u2717 ' + msg + ' → ' + e.message + '\n' + e.stack); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
function fire(node, type, extra) {
  var evt = Object.assign({ type: type, target: node, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, key: '', code: '', clientX: 0, clientY: 0, pointerId: 1, deltaY: 0, deltaMode: 0, files: null, dataTransfer: { setData: function () {}, getData: function () { return ''; } } }, extra || {});
  return node.dispatch(evt);
}
function findInputs(root) {
  var out = [];
  (function walk(n) {
    (n.children || []).forEach(function (c) {
      if (c.nodeType === 1) { if (c.tagName === 'INPUT' || c.tagName === 'SELECT' || c.tagName === 'TEXTAREA') out.push(c); walk(c); }
    });
  })(root);
  return out;
}
function findButtons(root) {
  var out = [];
  (function walk(n) {
    (n.children || []).forEach(function (c) {
      if (c.nodeType === 1) { if (c.tagName === 'BUTTON') out.push(c); walk(c); }
    });
  })(root);
  return out;
}
function allText(root) {
  var s = '';
  (function walk(n) {
    if (n.nodeType === 1 && !n.children.length) s += (n.textContent || '') + '|';
    (n.children || []).forEach(walk);
  })(root);
  return s;
}

/* ============================================================== 启动 */

section('启动：store → canvas → ui');
noThrow(function () { S.init(); }, 'store.init() 无异常');
noThrow(function () { CV.init(registry.board); }, 'canvas.init() 无异常');
noThrow(function () { UI.init(); }, 'ui.init() 无异常');
eq(registry.palette.children.length >= 4, true, '左侧栏渲染出多个分区（实际 ' + registry.palette.children.length + ' 个）');

section('画布绘制：空产线 / 有节点 / 模拟运行');
noThrow(function () { CV.render(); }, '空画布渲染无异常');
noThrow(function () { UI.newNode('source', { world: { x: -300, y: 0 } }); }, '添加输入端');
noThrow(function () { UI.newNode('machine', { world: { x: 0, y: 0 } }); }, '添加机器');
noThrow(function () { UI.newNode('sink', { world: { x: 400, y: 0 } }); }, '添加输出端');
eq(S.state.flow.nodes.length, 3, '画布上有 3 个节点');

var flow = S.state.flow;
var src = flow.nodes.filter(function (n) { return n.kind === 'diamond' && n.mode === 'source'; })[0];
var mch = flow.nodes.filter(function (n) { return n.kind === 'machine'; })[0];
var snk = flow.nodes.filter(function (n) { return n.kind === 'diamond' && n.mode === 'sink'; })[0];

section('物品与配方：数据链路');
noThrow(function () {
  S.mutate('测试数据', function () {
    var iron = M.makeItem({ name: '铁锭', state: 'solid' });
    var plate = M.makeItem({ name: '铁板', state: 'solid' });
    flow.items.push(iron, plate);
    src.emit.itemId = iron.id; src.emit.count = 1; src.emit.ticks = 20;
    mch.name = '压板机'; mch.power = 32; mch.ticks = 20;
    mch.recipe.inputs = [M.makeRecipeLine(iron.id, 1)];
    mch.recipe.outputs = [M.makeRecipeLine(plate.id, 1)];
    flow.links.push({
      id: M.uid('lnk'), from: { nodeId: src.id, side: 'out', index: 0 }, to: { nodeId: mch.id, side: 'in', index: 0 }, note: ''
    });
    flow.links.push({
      id: M.uid('lnk'), from: { nodeId: mch.id, side: 'out', index: 0 }, to: { nodeId: snk.id, side: 'in', index: 0 }, note: ''
    });
  });
}, '构建 源→机器→汇 链路无异常');
eq(S.state.analysis.counts.error, 0, '校验零错误');
eq(S.state.analysis.counts.warn, 0, '校验零警告');
noThrow(function () { CV.render(); }, '有内容的画布渲染无异常（含端口/连线/标签/提示）');

section('渲染几何：所有绘制调用的数值必须是有限数（无 NaN/Infinity）');
(function () {
  drawCalls.length = 0;
  CV.render();
  ok(drawCalls.length > 120, '一次渲染产生 ' + drawCalls.length + ' 个绘制调用');
  function bad(v, path) {
    if (typeof v === 'number') return !isFinite(v);
    if (Array.isArray(v)) return v.some(function (x, i) { return bad(x, path + '[' + i + ']'); });
    return false;
  }
  var nan = drawCalls.filter(function (c) { return c.a.some(function (a) { return bad(a, c.m); }); });
  ok(nan.length === 0, '没有任何绘制参数是 NaN/Infinity' + (nan.length ? '，例如 ' + nan[0].m + '(' + nan[0].a.join(',') + ')' : ''));
  var methods = {};
  drawCalls.forEach(function (c) { methods[c.m] = (methods[c.m] || 0) + 1; });
  ['bezierCurveTo', 'fillText', 'fill', 'stroke', 'setLineDash'].forEach(function (m) {
    ok((methods[m] || 0) > 0, '绘制过程中调用了 ' + m + '（' + (methods[m] || 0) + ' 次）');
  });
  // 端口方块必须落在节点边界上：抽样校验机器与菱形
  var machine = S.state.flow.nodes.filter(function (n) { return n.kind === 'machine'; })[0];
  var b = M.nodeBounds(machine);
  var allOnEdge = M.nodePorts(machine).inputs.every(function (p, i) {
    var w = M.portWorld(machine, 'in', i);
    return Math.abs(w.x - b.x) < 1e-6 && w.y > b.y && w.y < b.y + b.h;
  }) && M.nodePorts(machine).outputs.every(function (p, i) {
    var w = M.portWorld(machine, 'out', i);
    return Math.abs(w.x - (b.x + b.w)) < 1e-6 && w.y > b.y && w.y < b.y + b.h;
  });
  ok(allOnEdge, '机器端口都精确落在矩形左右边缘上且不超出高度');
  var dia = S.state.flow.nodes.filter(function (n) { return n.kind === 'diamond'; })[0];
  var dw = M.portWorld(dia, dia.mode === 'source' ? 'out' : 'in', 0);
  ok(Math.abs(Math.abs(dw.x - dia.x) - M.DIAMOND_HALF) < 1e-6 && Math.abs(dw.y - dia.y) < 1e-6, '菱形端口位于菱形尖端');
})();

section('HUD：理论最大耗电量与耗时');
ok(/32/.test(registry.hudPower.textContent), 'HUD 显示理论最大耗电量 32 EU/t（实际 “' + registry.hudPower.textContent + '”）');
ok(/20/.test(registry.hudTime.textContent), 'HUD 显示理论最大耗时 20 t（实际 “' + registry.hudTime.textContent + '”）');
ok(/机器 1/.test(registry.hudCounts.textContent), 'HUD 统计机器数（实际 “' + registry.hudCounts.textContent + '”）');

section('属性面板：选中机器');
noThrow(function () { S.selectNodes([mch.id], false); }, '选中机器');
eq(registry.inspector.classList.contains('hidden'), false, '属性面板显示出来');
ok(/耗电量/.test(allText(registry.inspector)), '面板包含“耗电量”字段');
ok(/配方/.test(allText(registry.inspector)), '面板包含配方编辑器');
var inputs = findInputs(registry.inspector);
var powerInput = inputs.filter(function (i) { return String(i.value) === '32'; })[0];
ok(!!powerInput, '找到耗电量输入框');
if (powerInput) {
  var histBefore = S.canUndo();
  noThrow(function () { fire(powerInput, 'focus'); fire(powerInput, 'input', {}); powerInput.value = '64'; fire(powerInput, 'input', {}); fire(powerInput, 'change'); }, '编辑耗电量（输入 + 提交）');
  eq(mchnPower(), 64, '机器耗电量被更新为 64');
  eq(S.canUndo(), true, '编辑进入撤销历史');
  S.undo();
  eq(mchnPower(), 32, '撤销后恢复到 32');
  S.redo();
  eq(mchnPower(), 64, '重做后回到 64');
}
function mchnPower() { return M.findNode(S.state.flow, mch.id).power; }

section('属性面板：配方增删');
(function () {
  S.selectNodes([mch.id], false);
  var btns = findButtons(registry.inspector);
  var addIn = btns.filter(function (b) { return /添加输入口/.test(b.textContent); })[0];
  ok(!!addIn, '存在“添加输入口”按钮');
  if (addIn) {
    var before = M.findNode(S.state.flow, mch.id).recipe.inputs.length;
    fire(addIn, 'click');
    eq(M.findNode(S.state.flow, mch.id).recipe.inputs.length, before + 1, '配方输入条数 +1');
    // 新增的输入口未设置物品 → 应报错
    ok(S.state.analysis.counts.error > 0, '未设置物品的输入口会报错');
    S.undo();
    eq(M.findNode(S.state.flow, mch.id).recipe.inputs.length, before, '撤销后配方恢复');
  }
})();

section('选择集与连线');
noThrow(function () { S.selectLinks([S.state.flow.links[0].id], false); }, '选中连线');
ok(/输出内容/.test(allText(registry.inspector)), '连线面板显示输出内容');
noThrow(function () { S.clearSelection(); }, '清空选择');
eq(registry.inspector.classList.contains('hidden'), true, '无选择时面板隐藏');

section('模拟运行');
noThrow(function () {
  fire(registry.btnPlay, 'click');
}, '点击“运行模拟”');
eq(CV.isPlaying(), true, '模拟进入运行态');
noThrow(function () { CV.render(); }, '运行态渲染无异常（物料圆点 + 效率条）');
ok(drawCalls.some(function (c) { return c.m === 'arc'; }), '运行态绘制了物料圆点/标注圆（arc）');
ok(drawCalls.filter(function (c) { return c.m === 'arc'; }).every(function (c) {
  return isFinite(c.a[0]) && isFinite(c.a[1]) && isFinite(c.a[2]) && c.a[2] >= 0;
}), '所有圆形绘制的圆心与半径有效');
ok(/实际总产出/.test(registry.hudSim.textContent), 'HUD 显示实际总产出（“' + registry.hudSim.textContent + '”）');
fire(registry.btnPlay, 'click');
eq(CV.isPlaying(), false, '再次点击暂停');

section('视图操作');
noThrow(function () { CV.fitToContent(); }, '适应视图');
noThrow(function () { CV.resetZoom(); }, '重置缩放');
noThrow(function () { fire(registry.btnZoomIn, 'click'); fire(registry.btnZoomOut, 'click'); }, '缩放按钮');
noThrow(function () { fire(registry.btnGrid, 'click'); CV.render(); fire(registry.btnGrid, 'click'); }, '网格开关 + 渲染');
noThrow(function () { fire(registry.btnSnap, 'click'); fire(registry.btnSnap, 'click'); }, '吸附开关');

section('保存 / 打开 / 导出（本地存储 + 文件）');
noThrow(function () { fire(registry.btnSave, 'click'); }, '点击“保存”');
eq(S.listFlows().length >= 1, true, '本地存档列表中已有条目（' + S.listFlows().length + ' 个）');
var savedName = S.state.flow.meta.name;
noThrow(function () { S.newFlow('临时流程'); }, '新建空白流程');
eq(S.state.flow.nodes.length, 0, '新流程为空');
noThrow(function () { S.openFlow(S.listFlows()[0].id); }, '打开刚才的存档');
eq(S.state.flow.nodes.length, 3, '存档内容被正确恢复');
noThrow(function () { S.exportFlow(); }, '导出流程文件（Blob + 下载）');
noThrow(function () { S.exportBackup(); }, '导出全部备份');

section('预设：存为预设 → 左侧栏出现 → 来自预设实例化');
noThrow(function () { S.selectNodes([mch.id], false); }, '选中机器');
(function () {
  var btns = findButtons(registry.inspector);
  var save = btns.filter(function (b) { return /存为预设/.test(b.textContent); })[0];
  ok(!!save, '存在“存为预设”按钮');
  if (save) {
    fire(save, 'click');
    eq(PS.list('machine').length, 1, '预设库中有 1 个机器预设（独立文件，所有流程通用）');
    ok(/压板机/.test(allText(registry.palette)), '左侧预设栏显示该预设');
    var p = PS.list('machine')[0];
    noThrow(function () { UI.addPresetInstance(p, { x: 200, y: 200 }); }, '从预设实例化到画布（自动补物品）');
    eq(S.state.flow.nodes.length, 4, '画布节点 +1');
  }
})();

section('物品库与预设库弹窗');
noThrow(function () { fire(registry.btnItems, 'click'); }, '打开物品库弹窗');
noThrow(function () { fire(registry.btnPresets, 'click'); }, '打开预设库弹窗');
noThrow(function () { fire(registry.btnHelp, 'click'); }, '打开帮助弹窗');
var modals = registry.modalRoot.children.length;
eq(modals, 3, '三个弹窗都在 modalRoot 中（' + modals + '）');

section('右键菜单 / 快捷菜单');
noThrow(function () { UI.showContextMenu({ type: 'node', nodeId: mch.id, world: { x: 0, y: 0 }, screen: { x: 10, y: 10 } }); }, '节点右键菜单');
noThrow(function () { UI.showContextMenu({ type: 'link', linkId: S.state.flow.links[0].id, world: { x: 0, y: 0 }, screen: { x: 10, y: 10 } }); }, '连线右键菜单');
noThrow(function () { UI.showContextMenu({ type: 'canvas', world: { x: 0, y: 0 }, screen: { x: 10, y: 10 } }); }, '空白处右键菜单');

section('删除与撤销');
(function () {
  var n0 = S.state.flow.nodes.length;
  S.selectNodes([snk.id], false);
  noThrow(function () { fire(doc, 'keydown', { key: 'Delete' }); }, 'Delete 删除所选');
  eq(S.state.flow.nodes.length, n0 - 1, '节点数 -1');
  noThrow(function () { S.undo(); }, '撤销删除');
  eq(S.state.flow.nodes.length, n0, '节点数恢复');
})();

section('画布交互：拖拽节点（按真实屏幕坐标命中）');
(function () {
  var target = S.state.flow.nodes.filter(function (n) { return n.kind === 'machine'; })[0];
  CV.fitToContent();
  var sp = CV.worldToScreen({ x: target.x, y: target.y });
  var startX = target.x, startY = target.y;
  S.selectNodes([target.id], false);
  fire(registry.board, 'pointerdown', { clientX: sp.x, clientY: sp.y, button: 0, pointerId: 7 });
  noThrow(function () {
    fire(registry.board, 'pointermove', { clientX: sp.x + 72, clientY: sp.y + 48, pointerId: 7 });
    fire(registry.board, 'pointerup', { clientX: sp.x + 72, clientY: sp.y + 48, pointerId: 7 });
  }, '拖动节点（pointerdown/move/up）');
  var zoom = S.state.view.zoom;
  ok(Math.abs(target.x - startX - 72 / zoom) < 0.01 && Math.abs(target.y - startY - 48 / zoom) < 0.01,
    '节点按指针位移换算到世界坐标移动（屏幕 Δ=72,48 → 世界 Δ=' + (target.x - startX).toFixed(1) + ',' + (target.y - startY).toFixed(1) + '，zoom=' + zoom.toFixed(3) + '）');
  ok(S.canUndo(), '拖拽进入撤销历史');
  var nid = target.id;
  S.undo();
  eq(M.findNode(S.state.flow, nid).x, startX, '撤销拖拽回到原位');
  S.redo();
})();

section('画布交互：从端口拖出连线');
(function () {
  var mch2 = UI.newNode('machine', { world: { x: 0, y: 420 } });
  S.mutate('准备测试端口', function () {
    mch2.recipe.inputs = [M.makeRecipeLine(src.emit.itemId, 1)];
  });
  S.refresh();
  var linksBefore = S.state.flow.links.length;
  CV.fitToContent();
  var from = CV.worldToScreen(M.portWorld(M.findNode(S.state.flow, src.id), 'out', 0));
  var to = CV.worldToScreen(M.portWorld(M.findNode(S.state.flow, mch2.id), 'in', 0));
  noThrow(function () {
    fire(registry.board, 'pointerdown', { clientX: from.x, clientY: from.y, button: 0, pointerId: 9 });
    fire(registry.board, 'pointermove', { clientX: to.x, clientY: to.y, pointerId: 9 });
    fire(registry.board, 'pointerup', { clientX: to.x, clientY: to.y, pointerId: 9 });
  }, '从输出口拖到输入口');
  eq(S.state.flow.links.length, linksBefore + 1, '成功创建一条新连线');
  var newLink = S.state.flow.links[S.state.flow.links.length - 1];
  var iss = S.state.analysis.linkIssues[newLink.id];
  ok(!iss || !/内容不匹配/.test(iss.msg), '新连线的内容与配方一致（不会被判为内容不匹配）' +
    (iss ? '；因源被两个下游均分而提示：' + iss.msg : ''));
  eq(newLink.to.nodeId, mch2.id, '新连线接到目标机器的输入口上');
})();

section('画布交互：框选 / 缩放 / 平移 / 右键');
(function () {
  S.clearSelection();
  CV.fitToContent();
  var a = CV.worldToScreen({ x: -1e5, y: -1e5 });
  var b = CV.worldToScreen({ x: 1e5, y: 1e5 });
  noThrow(function () {
    fire(registry.board, 'pointerdown', { clientX: a.x, clientY: a.y, button: 0, pointerId: 11 });
    fire(registry.board, 'pointermove', { clientX: b.x, clientY: b.y, pointerId: 11 });
    fire(registry.board, 'pointerup', { clientX: b.x, clientY: b.y, pointerId: 11 });
  }, '空白处框选');
  eq(S.state.selection.nodes.length, S.state.flow.nodes.length, '框选选中全部节点');
  noThrow(function () { fire(registry.board, 'wheel', { deltaY: -120, clientX: 500, clientY: 350 }); }, '滚轮缩放');
  noThrow(function () {
    fire(registry.board, 'pointerdown', { clientX: 20, clientY: 20, button: 1, pointerId: 8 });
    fire(registry.board, 'pointermove', { clientX: 60, clientY: 60, pointerId: 8 });
    fire(registry.board, 'pointerup', { clientX: 60, clientY: 60, pointerId: 8 });
  }, '中键平移');
  noThrow(function () { fire(registry.board, 'contextmenu', { clientX: 300, clientY: 300 }); }, '右键菜单事件');
  noThrow(function () { fire(registry.board, 'dblclick', { clientX: 500, clientY: 350 }); }, '双击事件');
  noThrow(function () { CV.render(); }, '交互后渲染无异常');
})();

section('快捷键');
noThrow(function () { fire(doc, 'keydown', { key: 'a', ctrlKey: true }); }, 'Ctrl+A 全选');
eq(S.state.selection.nodes.length, S.state.flow.nodes.length, '全选命中所有节点');
noThrow(function () { fire(doc, 'keydown', { key: 'Escape' }); }, 'Esc 取消选择');
eq(S.state.selection.nodes.length, 0, '选择已清空');
noThrow(function () { fire(doc, 'keydown', { key: 'z', ctrlKey: true }); }, 'Ctrl+Z 撤销');
noThrow(function () { fire(doc, 'keydown', { key: 'y', ctrlKey: true }); }, 'Ctrl+Y 重做');
noThrow(function () { fire(doc, 'keydown', { key: 'f' }); }, 'F 适应视图');
noThrow(function () { fire(doc, 'keydown', { key: 's', ctrlKey: true }); }, 'Ctrl+S 保存');
noThrow(function () { fire(doc, 'keydown', { key: '1' }); }, '普通按键不报错');

section('导入导出往返（含错误分支）');
noThrow(function () { S.importFlowText(M.flowToText(S.state.flow)); }, '导入自己导出的流程');
noThrow(function () { S.importFlowText('{不是 json'); }, '导入非法内容（应提示错误而不崩溃）');
noThrow(function () { UI.toast('error', '测试提示'); UI.toast('warn', '测试提示'); UI.toast('info', '测试提示'); }, '三种提示条');

section('回归：属性面板里重排配方行后，连线依然匹配（D1 的 UI 路径）');
(function () {
  S.newFlow('重排UI');
  var iron = M.makeItem({ name: '铁锭' });
  var copper = M.makeItem({ name: '铜锭' });
  var plate = M.makeItem({ name: '铁板' });
  var s1 = M.makeDiamond('source', { name: '铁源', itemId: iron.id, count: 1, ticks: 20 });
  var s2 = M.makeDiamond('source', { name: '铜源', itemId: copper.id, count: 1, ticks: 20 });
  var m = M.makeMachine({
    name: '重排机', power: 10, ticks: 20,
    inputs: [M.makeRecipeLine(iron.id, 1), M.makeRecipeLine(copper.id, 1)],
    outputs: [M.makeRecipeLine(plate.id, 1)]
  });
  s1.x = -520; s2.x = -520; s2.y = 160; m.x = 0; m.y = 0;
  S.mutate('准备重排测试', function () {
    S.state.flow.items.push(iron, copper, plate);
    S.state.flow.nodes.push(s1, s2, m);
    S.state.flow.links.push({ id: M.uid('lnk'), from: { nodeId: s1.id, side: 'out', index: 0 }, to: { nodeId: m.id, side: 'in', index: 0 }, note: '' });
    S.state.flow.links.push({ id: M.uid('lnk'), from: { nodeId: s2.id, side: 'out', index: 0 }, to: { nodeId: m.id, side: 'in', index: 1 }, note: '' });
  });
  eq(S.state.analysis.counts.error, 0, '初始接线无错误');
  S.selectNodes([m.id], false);
  var down = findButtons(registry.inspector).filter(function (b) { return b.getAttribute('title') === '下移'; })[0];
  ok(!!down, '找到配方行的“下移”按钮');
  if (down) {
    fire(down, 'click');
    eq(M.findNode(S.state.flow, m.id).recipe.inputs[0].itemId, copper.id, '配方第 1 行确实被换成了铜锭');
    eq(S.state.analysis.counts.error, 0, '重排后连线依旧全部匹配（连线跟随端口移动）');
    var link1 = M.findNode(S.state.flow, m.id).id && S.state.flow.links[0];
    eq(link1.to.index, 1, '铁锭源的连线跟着配方行移到第 2 个端口');
    S.undo();
    eq(S.state.analysis.counts.error, 0, '撤销重排后依然无错误');
    eq(M.findNode(S.state.flow, m.id).recipe.inputs[0].itemId, iron.id, '撤销后配方顺序恢复');
  }
})();

section('回归：删除配方行的确认提示与连线清理（D2 的 UI 路径）');
(function () {
  S.newFlow('删行UI');
  var A = M.makeItem({ name: 'A' });
  var B = M.makeItem({ name: 'B' });
  var out = M.makeItem({ name: '产物' });
  var sA = M.makeDiamond('source', { name: '源A', itemId: A.id, count: 1, ticks: 20 });
  var sB = M.makeDiamond('source', { name: '源B', itemId: B.id, count: 1, ticks: 20 });
  var m = M.makeMachine({
    name: '删行机', power: 10, ticks: 20,
    inputs: [M.makeRecipeLine(A.id, 1), M.makeRecipeLine(B.id, 1)],
    outputs: [M.makeRecipeLine(out.id, 1)]
  });
  sA.x = -520; sB.x = -520; sB.y = 160; m.x = 0; m.y = 0;
  S.mutate('准备删行测试', function () {
    S.state.flow.items.push(A, B, out);
    S.state.flow.nodes.push(sA, sB, m);
    S.state.flow.links.push({ id: M.uid('lnk'), from: { nodeId: sA.id, side: 'out', index: 0 }, to: { nodeId: m.id, side: 'in', index: 0 }, note: '' });
    S.state.flow.links.push({ id: M.uid('lnk'), from: { nodeId: sB.id, side: 'out', index: 0 }, to: { nodeId: m.id, side: 'in', index: 1 }, note: '' });
  });
  eq(S.state.analysis.counts.error, 0, '初始无错误');
  S.selectNodes([m.id], false);
  var before = S.state.flow.links.length;
  var del = findButtons(registry.inspector).filter(function (b) { return b.getAttribute('title') === '删除该条'; })[0];
  ok(!!del, '找到配方行的“删除该条”按钮');
  if (del) {
    fire(del, 'click'); // 会弹出确认框
    var confirms = registry.modalRoot.children.filter(function (c) { return /删除配方行/.test(allText(c)); });
    ok(confirms.length >= 1, '弹出确认对话框（提示该端口上的连线也会移除）');
    var yes = findButtons(confirms[confirms.length - 1]).filter(function (b) { return /确定/.test(b.textContent); })[0];
    ok(!!yes, '确认框里有“确定”按钮');
    if (yes) fire(yes, 'click');
    eq(S.state.flow.links.length, before - 1, '只移除了该端口上的那一条连线');
    eq(M.findNode(S.state.flow, m.id).recipe.inputs.length, 1, '配方剩 1 行');
    eq(S.state.analysis.counts.error, 0, '剩余连线依然匹配（索引已正确前移）');
  }
})();

section('回归：自动排版按钮（界面路径）');
(function () {
  S.newFlow('排版UI');
  var iron = M.makeItem({ name: '铁锭' });
  var plate = M.makeItem({ name: '铁板' });
  var snk = M.makeDiamond('sink', { name: '输出端', x: -800, y: 600 });
  var m = M.makeMachine({
    name: '机器', x: 100, y: -400, power: 10, ticks: 20,
    inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [M.makeRecipeLine(plate.id, 1)]
  });
  var src = M.makeDiamond('source', { name: '输入端', x: 900, y: 0, itemId: iron.id, count: 1, ticks: 20 });
  S.mutate('准备排版测试', function () {
    S.state.flow.items.push(iron, plate);
    S.state.flow.nodes.push(snk, m, src);
    S.state.flow.links.push({ id: M.uid('lnk'), from: { nodeId: src.id, side: 'out', index: 0 }, to: { nodeId: m.id, side: 'in', index: 0 }, note: '' });
    S.state.flow.links.push({ id: M.uid('lnk'), from: { nodeId: m.id, side: 'out', index: 0 }, to: { nodeId: snk.id, side: 'in', index: 0 }, note: '' });
  });
  eq(S.state.analysis.counts.error, 0, '排版前链路本身没有错误');
  var snapBefore = JSON.stringify(S.state.flow.nodes.map(function (n) { return [n.id, n.x, n.y]; }));
  ok(src.x > m.x && m.x > snk.x, '排版前是乱序的（输入端在最右侧）');
  noThrow(function () { fire(registry.btnLayout, 'click'); }, '点击工具栏“自动排版”');
  ok(src.x < m.x && m.x < snk.x, '排版后按步数从左到右：输入端 → 机器 → 输出端（x=' +
    Math.round(src.x) + ' / ' + Math.round(m.x) + ' / ' + Math.round(snk.x) + '）');
  eq(src.y, m.y, '单节点列沿同一中线对齐');
  ok(/步/.test(registry.toastRoot.textContent), '提示条说明了排版依据（“' + registry.toastRoot.textContent.slice(-60) + '”）');
  noThrow(function () { CV.render(); }, '排版后渲染无异常');
  S.undo();
  eq(JSON.stringify(S.state.flow.nodes.map(function (n) { return [n.id, n.x, n.y]; })), snapBefore, '一次撤销即可整体还原位置');
  S.redo();
  ok(src.id && M.findNode(S.state.flow, src.id).x < M.findNode(S.state.flow, m.id).x, '重做后仍是排版后的布局');

  // 空画布：应给出提示而不是报错
  S.newFlow('排版空');
  noThrow(function () { fire(registry.btnLayout, 'click'); }, '空画布点击自动排版不报错');
  ok(/还没有节点/.test(registry.toastRoot.textContent), '空画布给出“还没有节点”的提示');
})();

section('回归：缓存器（正方形）—— 左侧栏、属性面板、渲染、预设');
(function () {
  S.newFlow('缓存器UI');
  ok(/缓存器/.test(allText(registry.palette)), '左侧「机器」栏里出现缓存器条目');
  var buf = UI.newNode('buffer', { world: { x: 0, y: 0 } });
  eq(buf.kind, 'buffer', '通过左侧栏添加出缓存器节点');
  var size = M.bufferSize(buf);
  eq(size.w, size.h, '缓存器是正方形');
  noThrow(function () { CV.render(); }, '渲染白板缓存器无异常（未配置输入）');

  // 属性面板
  S.selectNodes([buf.id], false);
  var txt = allText(registry.inspector);
  ok(/输出强制与输入一致|镜像/.test(txt), '属性面板解释了“输出强制与输入一致”');
  var addBtn = findButtons(registry.inspector).filter(function (b) { return /添加输入/.test(b.textContent); })[0];
  ok(!!addBtn, '属性面板有“添加输入”按钮');
  if (addBtn) {
    fire(addBtn, 'click');
    eq(M.findNode(S.state.flow, buf.id).recipe.inputs.length, 1, '输入条数 +1');
    eq(M.nodePorts(M.findNode(S.state.flow, buf.id)).outputs.length, 1, '输出口同步派生为 1 个（镜像）');
    ok(S.state.analysis.counts.error > 0, '未设置物品/未接线的缓存器会报错');
    // 给输入设置物品
    var iron = M.makeItem({ name: '铁锭' });
    S.mutate('准备缓存器数据', function () {
      S.state.flow.items.push(iron);
      M.findNode(S.state.flow, buf.id).recipe.inputs[0].itemId = iron.id;
    });
    var ports = M.nodePorts(M.findNode(S.state.flow, buf.id));
    eq(ports.outputs[0].itemId, iron.id, '设置输入物品后输出口自动镜像同一物品');
    // 输出必须只读：面板里只有一个“物品选择”下拉（对应输入），没有任何输出编辑控件
    var txt2 = allText(registry.inspector);
    ok(/输出（强制镜像输入，不可编辑）/.test(txt2), '属性面板明确标注输出不可编辑');
    ok(/🔒/.test(txt2), '输出以只读（锁定）方式列出');
    var selects = findInputs(registry.inspector).filter(function (e) { return e.tagName === 'SELECT'; });
    eq(selects.length, M.findNode(S.state.flow, buf.id).recipe.inputs.length, '下拉选择框数量 = 输入条数（没有输出编辑控件）');
    noThrow(function () { CV.render(); }, '渲染有内容的缓存器无异常');
  }

  // 缓存器闭环：源 → 机器A → 缓存器 → 机器B → 机器A
  var mA, mB, src, sink;
  S.newFlow('缓存器闭环UI');
  var ingot = M.makeItem({ name: '铁锭' });
  var dust = M.makeItem({ name: '铁粉' });
  src = M.makeDiamond('source', { name: '铁锭源', itemId: ingot.id, count: 1, ticks: 20 });
  mA = M.makeMachine({
    name: '熔炼机', power: 32, ticks: 20,
    inputs: [M.makeRecipeLine(ingot.id, 2)], outputs: [M.makeRecipeLine(dust.id, 4)]
  });
  var b2 = M.makeBuffer({ name: '缓存器', inputs: [M.makeRecipeLine(dust.id, 4)] });
  mB = M.makeMachine({
    name: '压制机', power: 32, ticks: 20,
    inputs: [M.makeRecipeLine(dust.id, 4)], outputs: [M.makeRecipeLine(ingot.id, 2)]
  });
  sink = M.makeDiamond('sink', { name: '成品', filterItemId: ingot.id });
  S.mutate('搭建缓存器闭环', function () {
    S.state.flow.items.push(ingot, dust);
    S.state.flow.nodes.push(src, mA, b2, mB, sink);
  });
  var l1 = S.addLink(src.id, 0, mA.id, 0);
  var l2 = S.addLink(mA.id, 0, b2.id, 0);
  var l3 = S.addLink(b2.id, 0, mB.id, 0);
  var l4 = S.addLink(mB.id, 0, sink.id, 0);
  var l5 = S.addLink(mB.id, 0, mA.id, 0);   // 回流，构成经过缓存器的闭环
  ok(!!l1 && !!l2 && !!l3 && !!l4 && !!l5, '五条连线都建立成功');
  eq(S.state.analysis.counts.error, 0, '经过缓存器的闭环 0 错误' +
    (S.state.analysis.counts.error ? '：' + S.state.analysis.issueList[0].msg : ''));
  eq(S.state.analysis.bufferLoops.length, 1, '识别出 1 个经缓存器闭合的环路');
  ok(S.state.analysis.issueList.some(function (i) { return i.level === 'info' && /循环连接成立/.test(i.msg); }), '提示“循环连接成立”');

  // 两台机器绕过缓存器直连 → 必须报环路错误，并提示需要缓存器
  var direct = S.addLink(mA.id, 0, mB.id, 0);
  var errs = S.state.analysis.issueList.filter(function (i) { return i.level === 'error'; });
  ok(!!direct, '新增一条绕过缓存器的直连');
  ok(errs.some(function (i) { return /环路/.test(i.msg) && /缓存器/.test(i.msg); }),
    '两台机器直连成环时报错，并提示接入缓存器' + (errs.length ? '（' + errs[0].msg.slice(0, 40) + '）' : ''));
  S.undo();
  eq(S.state.analysis.counts.error, 0, '撤销直连后恢复为“经缓存器闭环”，0 错误');

  // 模拟：进出恒等
  S.selectNodes([b2.id], false);
  noThrow(function () { fire(registry.btnPlay, 'click'); }, '运行模拟（含缓存器）');
  CV.render();
  var simBuf = S.state.sim.buffer[b2.id];
  near(simBuf.totalIn, simBuf.totalOut, '缓存器总输入 = 总输出（' + M.fmtNum(simBuf.totalIn) + ' /s）');
  S.selectNodes([b2.id], false);   // 强制刷新属性面板
  var panelTxt = allText(registry.inspector);
  ok(/总输入 \/ 总输出/.test(panelTxt) &&
    panelTxt.indexOf(M.fmtNum(simBuf.totalIn) + ' /s') >= 0 &&
    panelTxt.indexOf(M.fmtNum(simBuf.totalOut) + ' /s') >= 0,
    '属性面板显示“总输入 / 总输出”速率：' + M.fmtNum(simBuf.totalIn) + ' /s = ' + M.fmtNum(simBuf.totalOut) + ' /s');
  ok(/通道 1/.test(panelTxt), '属性面板按通道列出「进 → 出」');
  fire(registry.btnPlay, 'click');

  // 缓存器预设
  var savePreset = findButtons(registry.inspector).filter(function (b) { return /存为预设/.test(b.textContent); })[0];
  ok(!!savePreset, '缓存器属性面板有“存为预设”');
  if (savePreset) {
    fire(savePreset, 'click');
    eq(PS.list('buffer').length, 1, '预设库中出现缓存器预设');
    var p = PS.list('buffer')[0];
    var created = PS.instantiate(M.createFlow('实例化'), p, 0, 0);
    eq(created.kind, 'buffer', '缓存器预设可实例化');
    eq(M.nodePorts(created).outputs.length, M.nodePorts(created).inputs.length, '实例化后输入输出口数量一致（镜像）');
  }
  noThrow(function () { CV.render(); }, '含缓存器与闭环的产线渲染无异常');
  ok(registry.hudCounts.textContent.length > 0, 'HUD 统计正常：' + registry.hudCounts.textContent);
})();

section('回归：导入「缓存器闭环」示例并渲染/排版（端到端）');
(function () {
  var fs = require('fs');
  var path = require('path');
  var file = path.join(__dirname, '..', 'samples', '示例产线-缓存器闭环.gtline.json');
  var text = fs.readFileSync(file, 'utf8');
  noThrow(function () { S.importFlowText(text); }, '导入示例产线-缓存器闭环.gtline.json');
  var bufs = S.state.flow.nodes.filter(function (n) { return n.kind === 'buffer'; });
  eq(bufs.length, 1, '示例里有 1 个缓存器');
  eq(S.state.analysis.counts.error, 0, '导入后 0 错误' + (S.state.analysis.counts.error ? '：' + S.state.analysis.issueList[0].msg : ''));
  eq(S.state.analysis.bufferLoops.length, 1, '识别出经缓存器闭合的环路');
  var sb = S.state.sim.buffer[bufs[0].id];
  near(sb.totalIn, sb.totalOut, '示例缓存器总进 = 总出（' + M.fmtNum(sb.totalIn) + ' /s）');
  ok(M.nodePorts(bufs[0]).outputs.every(function (p, i) {
    return p.itemId === M.nodePorts(bufs[0]).inputs[i].itemId;
  }), '示例缓存器的输出逐口镜像输入');
  noThrow(function () { CV.render(); }, '渲染含缓存器的示例无异常');
  S.selectNodes([bufs[0].id], false);
  ok(/总输入 \/ 总输出/.test(allText(registry.inspector)), '缓存器属性面板显示中转速率');
  noThrow(function () { fire(registry.btnLayout, 'click'); }, '对含缓存器的示例执行自动排版');
  eq(S.state.analysis.counts.error, 0, '排版后仍然 0 错误');
  noThrow(function () { CV.render(); }, '排版后渲染无异常');
})();

section('最终渲染一致性');
noThrow(function () { S.refresh(); CV.render(); }, '最终 refresh + render 无异常');
(function () {
  var fresh = G.analyze(S.state.flow);
  eq(S.state.analysis.counts.error, fresh.counts.error, 'store 内的分析结果与重新分析一致（错误数）');
  eq(S.state.analysis.counts.warn, fresh.counts.warn, 'store 内的分析结果与重新分析一致（警告数）');
  ok(S.state.analysis.issueList.every(function (i) { return i.level && i.msg; }), '每条问题都有级别与文字说明');
  var sim = G.simulate(S.state.flow, S.state.analysis);
  ok(typeof sim.totals.itemPerSec === 'number', '模拟结果可计算：实际总产出 ' + M.fmtNum(sim.totals.itemPerSec) + ' /s');
  var text = M.flowToText(S.state.flow);
  var round = M.parseFlowText(text);
  ok(round.ok && round.flow.nodes.length === S.state.flow.nodes.length, '最终流程可无损导出导入（' + round.flow.nodes.length + ' 节点）');
  eq(round.warnings.length, 0, '最终导出导入无修正警告');
})();

console.log('\n---------------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败列表：');
  failures.forEach(function (f) { console.log(' - ' + f); });
  process.exit(1);
}
console.log('集成冒烟测试全部通过。');
