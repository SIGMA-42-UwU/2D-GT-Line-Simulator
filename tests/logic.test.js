/* ============================================================================
 * GT 产线模拟器 — 逻辑层自动化测试（Node 直接运行，无需浏览器）
 *   node tests/logic.test.js
 * 覆盖：模型/端口几何/序列化/校验引擎/吞吐模拟/预设库
 * ==========================================================================*/
'use strict';

// 浏览器 API 打桩（presets.js 会用到 localStorage）
globalThis.window = {
  localStorage: {
    _d: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem: function (k, v) { this._d[k] = String(v); },
    removeItem: function (k) { delete this._d[k]; }
  }
};

var M = require('../js/model.js');
var G = require('../js/graph.js');
var PS = require('../js/presets.js');

var pass = 0, fail = 0;
var failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; failures.push(msg); console.log('  \u2717 ' + msg); }
}
function eq(a, b, msg) {
  ok(a === b, msg + '  [得到 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + ']');
}
function near(a, b, msg, eps) {
  eps = eps || 1e-6;
  ok(Math.abs(a - b) <= eps, msg + '  [得到 ' + a + '，期望 ' + b + ']');
}
function section(t) { console.log('\n== ' + t + ' =='); }

function mkLink(fromNode, fromIdx, toNode, toIdx) {
  return {
    id: M.uid('lnk'),
    from: { nodeId: fromNode.id, side: 'out', index: fromIdx },
    to: { nodeId: toNode.id, side: 'in', index: toIdx },
    note: ''
  };
}

/* ---------------------------------------------------- 场景：理想链路 */
function buildIdeal() {
  var flow = M.createFlow('理想链路');
  var iron = M.makeItem({ name: '铁锭', state: 'solid' });
  var copper = M.makeItem({ name: '铜锭', state: 'solid' });
  var circuit = M.makeItem({ name: '电路板', state: 'solid' });
  flow.items.push(iron, copper, circuit);

  var src = M.makeDiamond('source', { name: '铁锭源', x: -700, y: 0, itemId: iron.id, count: 1, ticks: 40 });
  var m1 = M.makeMachine({
    name: '轧机', x: -350, y: 0, power: 30, ticks: 40,
    inputs: [M.makeRecipeLine(iron.id, 1)],
    outputs: [M.makeRecipeLine(copper.id, 2)]
  });
  var m2 = M.makeMachine({
    name: '组装机', x: 60, y: 0, power: 60, ticks: 20,
    inputs: [M.makeRecipeLine(copper.id, 1)],
    outputs: [M.makeRecipeLine(circuit.id, 1)]
  });
  var sink = M.makeDiamond('sink', { name: '成品出料', x: 460, y: 0 });
  flow.nodes.push(src, m1, m2, sink);
  var l1 = mkLink(src, 0, m1, 0);
  var l2 = mkLink(m1, 0, m2, 0);
  var l3 = mkLink(m2, 0, sink, 0);
  flow.links.push(l1, l2, l3);
  return { flow: flow, src: src, m1: m1, m2: m2, sink: sink, iron: iron, copper: copper, circuit: circuit, l1: l1, l2: l2, l3: l3 };
}

/* ============================================================== 模型层 */

section('模型层：端口几何');
(function () {
  var m = M.makeMachine({
    inputs: [M.makeRecipeLine('a', 1), M.makeRecipeLine('b', 1), M.makeRecipeLine('c', 1), M.makeRecipeLine('d', 1)],
    outputs: [M.makeRecipeLine('x', 1)]
  });
  var size = M.machineSize(m);
  ok(size.h > M.MACHINE_MIN_H, '4 个输入口时机器高度自动增长：' + size.h);
  var ys = [];
  for (var i = 0; i < 4; i++) ys.push(M.portLocal(m, 'in', i).y);
  var distinct = ys.every(function (y, i) { return i === 0 || y > ys[i - 1]; });
  ok(distinct, '输入口自上而下按配方顺序排列：' + ys.map(function (y) { return y.toFixed(1); }).join(', '));
  var bodyTop = M.machineBody(m).top;
  ok(ys[0] >= bodyTop, '输入口不会侵入标题栏（' + ys[0].toFixed(1) + ' >= ' + bodyTop.toFixed(1) + '）');
  ok(M.portLocal(m, 'in', 0).x < 0 && M.portLocal(m, 'out', 0).x > 0, '输入口在左侧、输出口在右侧');
  var d = M.makeDiamond('source');
  eq(M.nodePorts(d).outputs.length, 1, '输入端（源）只有 1 个输出口');
  eq(M.nodePorts(d).inputs.length, 0, '输入端（源）没有输入口');
  var d2 = M.makeDiamond('sink');
  eq(M.nodePorts(d2).inputs.length, 1, '输出端（汇）只有 1 个输入口');
  eq(M.nodePorts(d2).outputs.length, 0, '输出端（汇）没有输出口');
})();

section('模型层：序列化往返');
(function () {
  var s = buildIdeal();
  var text = M.flowToText(s.flow);
  ok(text.indexOf('"__') < 0, '导出的 JSON 不含运行时临时字段');
  var parsed = M.parseFlowText(text);
  ok(parsed.ok, '导出文本可以被解析回来');
  eq(parsed.flow.nodes.length, 4, '节点数量保持');
  eq(parsed.flow.links.length, 3, '连线数量保持');
  eq(parsed.flow.items.length, 3, '物品数量保持');
  var m1 = M.findNode(parsed.flow, s.m1.id);
  eq(m1.recipe.inputs.length, 1, '配方输入条数保持');
  eq(m1.recipe.outputs[0].count, 2, '配方数量保持');
  eq(M.itemLabel(parsed.flow, m1.recipe.inputs[0].itemId), '铁锭', '物品引用保持');
  ok(parsed.warnings.length === 0, '往返无修正警告');
})();

section('模型层：容错导入');
(function () {
  var r = M.parseFlowText('{"nodes":[{"kind":"machine","name":"X","recipe":{"inputs":[{"itemId":"","count":0}]}}],"links":[{"from":{"nodeId":"nope"},"to":{"nodeId":"nope"}}]}');
  ok(r.ok, '残缺文件仍能导入');
  eq(r.flow.nodes.length, 1, '保留可识别节点');
  eq(r.flow.links.length, 0, '丢弃无效连线');
  ok(r.warnings.length >= 1, '给出修正警告：' + r.warnings[0]);
  var bad = M.parseFlowText('这不是 JSON');
  ok(!bad.ok, '非 JSON 文件被拒绝并给出错误');
})();

/* ============================================================== 校验层 */

section('校验引擎：理想链路应零错误零警告');
(function () {
  var s = buildIdeal();
  var an = G.analyze(s.flow);
  eq(an.counts.error, 0, '错误数 0' + (an.counts.error ? '，首个：' + an.issueList[0].msg : ''));
  eq(an.counts.warn, 0, '警告数 0' + (an.counts.warn ? '，首个：' + an.issueList[0].msg : ''));
  eq(an.stats.power, 90, '理论最大耗电量 = 30 + 60');
  eq(an.stats.ticks, 60, '理论最大耗时 = 40 + 20');
  eq(an.stats.machineCount, 2, '机器数量统计正确');
})();

section('校验引擎：内容不匹配 → 整条连线红色报错');
(function () {
  var s = buildIdeal();
  var bad = M.makeDiamond('source', { name: '铜锭源误接', x: -700, y: 240, itemId: s.copper.id, count: 1, ticks: 40 });
  s.flow.nodes.push(bad);
  var badLink = mkLink(bad, 0, s.m1, 0);
  s.flow.links.push(badLink);
  var an = G.analyze(s.flow);
  ok(an.linkIssues[badLink.id] && an.linkIssues[badLink.id].level === 'error', '接错的连线被标为错误（红）');
  ok(/内容不匹配/.test(an.linkIssues[badLink.id].msg), '错误信息说明内容不匹配：' + an.linkIssues[badLink.id].msg);
  ok(!an.linkIssues[s.l1.id], '正确的那条连线没有被误判');
  ok(an.portIssues[M.inPortKey(s.m1.id, 0)] && an.portIssues[M.inPortKey(s.m1.id, 0)].level === 'error', '机器输入口本身被标记为错误');
  ok(an.counts.error > 0, '整体错误计数增加');
})();

section('校验引擎：供料不足 / 过量');
(function () {
  var s = buildIdeal();
  s.src.emit.count = 1; s.src.emit.ticks = 80; // 0.25/s，但需要 0.5/s
  var an = G.analyze(s.flow);
  ok(an.issueList.some(function (i) { return /供料不足/.test(i.msg); }), '速率不足时报“供料不足”错误');

  s.src.emit.ticks = 10; // 2/s，只需要 0.5/s
  var an2 = G.analyze(s.flow);
  eq(an2.counts.error, 0, '过量时没有错误');
  ok(an2.issueList.some(function (i) { return /供料过量/.test(i.msg); }), '速率过量时报“供料过量”警告');
  ok(an2.issueList.filter(function (i) { return /供料过量/.test(i.msg); })[0].level === 'warn', '过量是警告级别');
})();

section('校验引擎：环路检测');
(function () {
  var flow = M.createFlow('环路');
  var iron = M.makeItem({ name: '铁' });
  var copper = M.makeItem({ name: '铜' });
  flow.items.push(iron, copper);
  var a = M.makeMachine({ name: 'A', power: 1, ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [M.makeRecipeLine(copper.id, 1)] });
  var b = M.makeMachine({ name: 'B', power: 1, ticks: 20, inputs: [M.makeRecipeLine(copper.id, 1)], outputs: [M.makeRecipeLine(iron.id, 1)] });
  flow.nodes.push(a, b);
  var l1 = mkLink(a, 0, b, 0);
  var l2 = mkLink(b, 0, a, 0);
  flow.links.push(l1, l2);
  var an = G.analyze(flow);
  eq(an.cycles.length, 1, '检测到 1 个强连通环路');
  ok(an.linkIssues[l1.id] && an.linkIssues[l1.id].level === 'error', '环路上的连线标红');
  ok(an.linkIssues[l2.id] && an.linkIssues[l2.id].level === 'error', '环路上的连线标红');
})();

section('校验引擎：输出端过滤不匹配');
(function () {
  var s = buildIdeal();
  s.sink.filter.itemId = s.iron.id; // 只接受铁锭，但接入的是电路板
  var an = G.analyze(s.flow);
  ok(an.linkIssues[s.l3.id] && an.linkIssues[s.l3.id].level === 'error', '输出端过滤不匹配 → 连线标红');
})();

/* ============================================================== 模拟层 */

section('模拟层：理想链路吞吐');
(function () {
  var s = buildIdeal();
  var an = G.analyze(s.flow);
  var sim = G.simulate(s.flow, an);
  near(sim.machine[s.m1.id].craftRate, 0.5, '轧机 0.5 次/s（1 铁锭/40t，供料 0.5/s）');
  near(sim.machine[s.m2.id].craftRate, 1, '组装机 1 次/s');
  near(sim.linkRate[s.l1.id], 0.5, '连线1 流量 0.5/s');
  near(sim.linkRate[s.l2.id], 1, '连线2 流量 1/s（2 铜锭 × 0.5 次/s）');
  near(sim.sink[s.sink.id].intake, 1, '输出端接收 1/s');
  near(sim.machine[s.m1.id].efficiency, 1, '轧机效率 100%');
  eq(sim.machine[s.m1.id].state, '满速运行', '机器状态为满速运行');
})();

section('模拟层：一对多均分');
(function () {
  var flow = M.createFlow('一对多');
  var iron = M.makeItem({ name: '铁锭' });
  flow.items.push(iron);
  var src = M.makeDiamond('source', { name: '源', itemId: iron.id, count: 2, ticks: 20 }); // 2/s
  var m1 = M.makeMachine({ name: 'M1', power: 5, ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [] });
  var m2 = M.makeMachine({ name: 'M2', power: 5, ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [] });
  flow.nodes.push(src, m1, m2);
  var l1 = mkLink(src, 0, m1, 0);
  var l2 = mkLink(src, 0, m2, 0);
  flow.links.push(l1, l2);
  var an = G.analyze(flow);
  var sim = G.simulate(flow, an);
  near(sim.linkRate[l1.id], 1, '一对多时每条连线分到 1/s');
  near(sim.machine[m1.id].craftRate, 1, 'M1 满速 1 次/s');
  near(sim.machine[m2.id].craftRate, 1, 'M2 满速 1 次/s');
  eq(an.counts.error, 0, '均分情况下无错误');
})();

section('模拟层：多对一累加');
(function () {
  var flow = M.createFlow('多对一');
  var iron = M.makeItem({ name: '铁锭' });
  flow.items.push(iron);
  var s1 = M.makeDiamond('source', { name: '源1', itemId: iron.id, count: 1, ticks: 40 }); // 0.5/s
  var s2 = M.makeDiamond('source', { name: '源2', itemId: iron.id, count: 1, ticks: 40 }); // 0.5/s
  var m = M.makeMachine({ name: 'M', power: 5, ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [] }); // 需要 1/s
  flow.nodes.push(s1, s2, m);
  var l1 = mkLink(s1, 0, m, 0);
  var l2 = mkLink(s2, 0, m, 0);
  flow.links.push(l1, l2);
  var an = G.analyze(flow);
  eq(an.counts.error, 0, '两条源叠加刚好满足需求，无错误');
  var sim = G.simulate(flow, an);
  near(sim.machine[m.id].craftRate, 1, '多对一累加后机器满速 1 次/s');
})();

section('模拟层：上游停机导致下游缺料');
(function () {
  var s = buildIdeal();
  s.src.emit.itemId = ''; // 源没设置物品
  var an = G.analyze(s.flow);
  var sim = G.simulate(s.flow, an);
  near(sim.machine[s.m1.id].craftRate, 0, '上游没有物料时下游机器不工作');
  eq(an.counts.error > 0, true, '未设置供料物品被报错');
})();

/* ============================================================== 预设层 */

section('预设库：从节点保存 / 跨流程实例化');
(function () {
  PS.clearAll();
  var s = buildIdeal();
  var p = PS.fromNode(s.flow, s.m1);
  eq(p.type, 'machine', '机器节点生成机器预设');
  eq(p.machine.power, 30, '预设保留耗电量');
  eq(p.machine.ticks, 40, '预设保留耗时');
  eq(p.machine.inputs[0].item.name, '铁锭', '预设内嵌物品快照（可跨文件复用）');
  PS.upsert(p);
  eq(PS.list('machine').length, 1, '预设写入库');

  var flow2 = M.createFlow('另一个流程');
  var node = PS.instantiate(flow2, p, 100, 100);
  eq(node.kind, 'machine', '预设实例化出机器节点');
  eq(node.power, 30, '实例化保留耗电量');
  eq(flow2.items.length, 2, '实例化时自动在目标流程创建缺失物品（铁锭/铜锭）');
  eq(M.itemLabel(flow2, node.recipe.outputs[0].itemId), '铜锭', '实例化保留输出物品');

  var flow3 = M.createFlow('流程3');
  var target = M.makeMachine({ name: '空机器' });
  flow3.nodes.push(target);
  ok(PS.applyToNode(flow3, p, target), '预设可以套用到已有节点');
  eq(target.power, 30, '套用后参数更新');

  var src = PS.fromNode(s.flow, s.src);
  eq(src.type, 'source', '输入端节点生成 source 预设');
  var itemP = PS.fromItem(s.flow, s.iron);
  eq(itemP.type, 'item', '物品生成物品预设');
  eq(itemP.item.state, 'solid', '物品预设保留物态');
  PS.upsert(src);
  PS.upsert(itemP);
  eq(PS.list().length, 3, '三类预设都在库中（机器/输入端/物品）');

  var obj = PS.exportObject();
  eq(obj.format, M.PRESET_FORMAT, '预设可以导出为独立文件对象');
  eq(obj.presets.length, 3, '导出的预设数量正确');
  PS.clearAll();
  eq(PS.list().length, 0, '清空预设库');
  var res = PS.importText(JSON.stringify(obj), { merge: true });
  ok(res.ok && res.added === 3, '预设文件可以导入回来：' + JSON.stringify(res));
  eq(PS.list().length, 3, '导入后预设数量正确');
  ok(PS.list().every(function (x) { return x.type && x.name; }), '导入的预设字段完整');
})();

section('预设库：空库无默认预设');
(function () {
  PS.clearAll();
  eq(PS.list().length, 0, '按需求：预设库默认为空，没有任何默认预设');
})();

/* ============================================================== 自动排版 */

function boxesOverlap(a, b) {
  var A = M.nodeBounds(a), B = M.nodeBounds(b);
  return A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
}
function assertNoOverlap(flow, label) {
  var nodes = flow.nodes, bad = [];
  for (var i = 0; i < nodes.length; i++) {
    for (var j = i + 1; j < nodes.length; j++) {
      if (boxesOverlap(nodes[i], nodes[j])) bad.push(nodes[i].name + '×' + nodes[j].name);
    }
  }
  ok(bad.length === 0, label + (bad.length ? '：重叠 ' + bad.slice(0, 3).join(', ') : ''));
}
function assertFinitePos(flow, label) {
  ok(flow.nodes.every(function (n) { return isFinite(n.x) && isFinite(n.y); }), label);
}

section('自动排版：步数 = 距输入端的最短连线长度');
(function () {
  var s = buildIdeal();
  var info = G.computeLayers(s.flow);
  eq(info.stepOf[s.src.id], 0, '输入端 = 第 0 步');
  eq(info.stepOf[s.m1.id], 1, '轧机 = 第 1 步');
  eq(info.stepOf[s.m2.id], 2, '组装机 = 第 2 步');
  eq(info.stepOf[s.sink.id], 3, '输出端 = 第 3 步');
  eq(info.maxStep, 3, '最大步数 = 3');
  eq(info.layers.length, 4, '共 4 列');
  eq(info.unreachable.length, 0, '没有不可达节点');
  eq(info.seeds.length, 1, '只有输入端是第 0 步起点');

  var res = G.autoLayout(s.flow, { snap: true });
  eq(res.columns, 4, '排版结果为 4 列');
  eq(res.maxStep, 3, '排版最大步数 3');
  ok(s.src.x < s.m1.x && s.m1.x < s.m2.x && s.m2.x < s.sink.x,
    'x 坐标随步数递增：' + [s.src.x, s.m1.x, s.m2.x, s.sink.x].join(' < '));
  eq(s.src.y, s.m1.y, '单节点列沿同一中线对齐');
  assertNoOverlap(s.flow, '排版后没有任何节点相互重叠');
  assertFinitePos(s.flow, '排版后所有坐标都是有限数');
  ok(s.flow.nodes.every(function (n) {
    return Math.abs(n.x / M.GRID - Math.round(n.x / M.GRID)) < 1e-9 &&
      Math.abs(n.y / M.GRID - Math.round(n.y / M.GRID)) < 1e-9;
  }), '坐标吸附到 24px 网格');

  // 整体居中于原点
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  s.flow.nodes.forEach(function (n) {
    var b = M.nodeBounds(n);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  });
  ok(Math.abs((minX + maxX) / 2) <= M.GRID && Math.abs((minY + maxY) / 2) <= M.GRID,
    '整体居中于世界原点（中心 ' + ((minX + maxX) / 2).toFixed(1) + ',' + ((minY + maxY) / 2).toFixed(1) + '）');

  // 幂等 / 确定性
  var snap1 = JSON.stringify(s.flow.nodes.map(function (n) { return [n.id, n.x, n.y]; }));
  G.autoLayout(s.flow, { snap: true });
  eq(JSON.stringify(s.flow.nodes.map(function (n) { return [n.id, n.x, n.y]; })), snap1, '重复排版结果完全一致（稳定可复现）');

  // 只动坐标，不动任何数据
  var s2 = buildIdeal();
  var withoutPos = function (f) {
    return JSON.stringify({
      items: f.items,
      nodes: f.nodes.map(function (n) { return [n.id, n.name, n.kind, n.power, n.ticks, n.recipe, n.emit, n.filter]; }),
      links: f.links
    });
  };
  var before = withoutPos(s2.flow);
  G.autoLayout(s2.flow, { snap: true });
  eq(withoutPos(s2.flow), before, '排版只改变 x/y，不修改配方、物品、连线等数据');
})();

section('自动排版：多路径取最短 / 自发产出算第 0 步 / 无来源环路放最后一列');
(function () {
  var flow = M.createFlow('分层');
  var iron = M.makeItem({ name: '铁锭' });
  flow.items.push(iron);
  var src = M.makeDiamond('source', { name: '输入端', itemId: iron.id, count: 1, ticks: 20 });
  var m1 = M.makeMachine({ name: 'M1', ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [M.makeRecipeLine(iron.id, 1)] });
  var m2 = M.makeMachine({ name: 'M2', ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [M.makeRecipeLine(iron.id, 1)] });
  var m3 = M.makeMachine({ name: 'M3', ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [M.makeRecipeLine(iron.id, 1)] });
  var target = M.makeMachine({ name: '双路汇合', ticks: 20, inputs: [M.makeRecipeLine(iron.id, 2)], outputs: [] });
  var maker = M.makeMachine({ name: '无输入自发机器', ticks: 20, inputs: [], outputs: [M.makeRecipeLine(iron.id, 1)] });
  var a = M.makeMachine({ name: '环A', ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [M.makeRecipeLine(iron.id, 1)] });
  var b = M.makeMachine({ name: '环B', ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [M.makeRecipeLine(iron.id, 1)] });
  flow.nodes.push(src, m1, m2, m3, target, maker, a, b);
  flow.links.push(
    mkLink(src, 0, m1, 0),
    mkLink(m1, 0, m2, 0),
    mkLink(m2, 0, m3, 0),
    mkLink(m3, 0, target, 0),
    mkLink(src, 0, target, 0),   // 直连，步数 1（另一条路径为 4）
    mkLink(a, 0, b, 0),
    mkLink(b, 0, a, 0)           // 无来源的纯环路
  );
  var info = G.computeLayers(flow);
  eq(info.stepOf[src.id], 0, '输入端第 0 步');
  eq(info.stepOf[m1.id], 1, 'M1 第 1 步');
  eq(info.stepOf[m2.id], 2, 'M2 第 2 步');
  eq(info.stepOf[m3.id], 3, 'M3 第 3 步');
  eq(info.stepOf[target.id], 1, '双路汇合取最短路径（直连 1 步，而不是绕行 4 步）');
  eq(info.stepOf[maker.id], 0, '没有任何上游连线的机器算第 0 步（它是物料起点）');
  eq(info.unreachable.length, 2, '无来源的纯环路 2 个节点不可达');
  ok(info.unreachable.indexOf(a.id) >= 0 && info.unreachable.indexOf(b.id) >= 0, '不可达节点是环A / 环B');
  eq(info.stepOf[a.id], info.maxStep, '不可达节点被放在最后一列（第 ' + info.maxStep + ' 步）');

  var res = G.autoLayout(flow, { snap: false });
  eq(res.unreachable, 2, '排版结果报告 2 个不可达节点');
  eq(res.seeds, 2, '第 0 步起点有 2 个（输入端 + 自发机器）');
  ok(src.x < target.x && target.x < m2.x, '双路汇合被放在第 1 列');
  ok(a.x > m3.x && b.x > m3.x, '不可达的环路被放到最后一列（最右侧）');
  eq(a.x, b.x, '同列节点 x 相同');
  ok(a.y !== b.y, '同列节点不同 y');
  assertNoOverlap(flow, '复杂分层排版无重叠');
  assertFinitePos(flow, '复杂分层排版坐标有效');
})();

section('自动排版：多来源并列第 0 步 + 多分支列内按重心排序');
(function () {
  var flow = M.createFlow('重心');
  var iron = M.makeItem({ name: '铁锭' });
  flow.items.push(iron);
  var s1 = M.makeDiamond('source', { name: '源1', itemId: iron.id, count: 1, ticks: 20 });
  var s2 = M.makeDiamond('source', { name: '源2', itemId: iron.id, count: 1, ticks: 20 });
  flow.nodes.push(s1, s2);
  // 4 台机器，其中 D 同时接源1（与 A/B/C 相同的上游）与源2
  var ms = [];
  ['A', 'B', 'C', 'D'].forEach(function (nm) {
    var m = M.makeMachine({ name: nm, ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [] });
    flow.nodes.push(m); ms.push(m);
  });
  flow.links.push(mkLink(s1, 0, ms[0], 0), mkLink(s1, 0, ms[1], 0), mkLink(s1, 0, ms[2], 0));
  flow.links.push(mkLink(s2, 0, ms[3], 0), mkLink(s1, 0, ms[3], 0));
  var info = G.computeLayers(flow);
  eq(info.stepOf[s1.id], 0, '源1 第 0 步');
  eq(info.stepOf[s2.id], 0, '源2 第 0 步');
  ok(ms.every(function (m) { return info.stepOf[m.id] === 1; }), '四台机器都在第 1 步');
  eq(info.layers[0].length, 2, '第 0 列有 2 个来源');
  eq(info.layers[1].length, 4, '第 1 列有 4 台机器');
  var res = G.autoLayout(flow, { snap: true });
  eq(res.columns, 2, '排版为 2 列');
  ok(s1.y !== s2.y, '同一列的来源错开摆放');
  assertNoOverlap(flow, '多来源排版无重叠');
})();

section('自动排版：空流程 / 单个节点 / 示例产线都安全');
(function () {
  var empty = M.createFlow('空');
  var r0 = G.autoLayout(empty, {});
  eq(r0.moved, 0, '空流程排版返回 moved=0（不报错）');
  eq(G.computeLayers(empty).layers.length, 1, '空流程表示为 1 个空列');

  var one = M.createFlow('单节点');
  one.nodes.push(M.makeMachine({ name: 'M', ticks: 20 }));
  var r1 = G.autoLayout(one, {});
  eq(r1.moved, 1, '单节点排版成功');
  eq(one.nodes[0].x, 0, '单个节点居中到 x=0');
  eq(one.nodes[0].y, 0, '单个节点居中到 y=0');
})();

/* ============================================================== 缓存器 */

section('缓存器：白板正方形，输出强制镜像输入');
(function () {
  var flow = M.createFlow('缓存器');
  var a = M.makeItem({ name: '铁粉' }), b = M.makeItem({ name: '铜粉' });
  flow.items.push(a, b);
  var buf = M.makeBuffer({
    name: '中转缓存', inputs: [M.makeRecipeLine(a.id, 2), M.makeRecipeLine(b.id, 5)]
  });
  flow.nodes.push(buf);
  var size = M.bufferSize(buf);
  eq(size.w, size.h, '形状是正方形（宽 = 高 = ' + size.w + '）');
  ok(size.w >= M.BUFFER_MIN_SIDE, '边长不小于最小值 ' + M.BUFFER_MIN_SIDE);

  var ports = M.nodePorts(buf);
  eq(ports.inputs.length, 2, '配置了 2 条输入 → 2 个输入口');
  eq(ports.outputs.length, 2, '输出口数量与输入口一一对应（2 个）');
  eq(ports.outputs[0].itemId, ports.inputs[0].itemId, '第 1 个输出口物品 = 第 1 个输入口物品');
  eq(ports.outputs[1].itemId, ports.inputs[1].itemId, '第 2 个输出口物品 = 第 2 个输入口物品');
  eq(ports.outputs[1].count, 5, '输出数量也镜像输入数量');
  ok(ports.outputs[0].mirrored === true, '输出口标记为镜像输出');

  eq(M.portLocal(buf, 'in', 0).y, M.portLocal(buf, 'out', 0).y, '第 1 条通道的输入口与输出口在同一行');
  eq(M.portLocal(buf, 'in', 1).y, M.portLocal(buf, 'out', 1).y, '第 2 条通道的输入口与输出口在同一行');
  ok(M.portLocal(buf, 'in', 0).x < 0 && M.portLocal(buf, 'out', 0).x > 0, '输入口在左侧、输出口在右侧');

  var ro = M.resolveOutPort(flow, buf.id, 1);
  eq(ro.source, 'buffer', '输出口的来源标记为缓存器');
  eq(ro.ticks, 0, '缓存器没有耗时（不限制速率）');
  eq(M.itemLabel(flow, ro.itemId), '铜粉', '输出口内容取自对应输入口');

  // 边长随输入条数增长但仍为正方形
  var big = M.makeBuffer({ name: '大缓存', inputs: [] });
  for (var i = 0; i < 8; i++) big.recipe.inputs.push(M.makeRecipeLine(a.id, 1));
  var bigSize = M.bufferSize(big);
  eq(bigSize.w, bigSize.h, '8 条输入时仍是正方形（' + bigSize.w + '）');
  ok(bigSize.w > size.w, '输入越多边长越大（' + size.w + ' → ' + bigSize.w + '）');
  eq(M.nodePorts(big).outputs.length, 8, '8 条输入 → 8 个输出口');
  eq(M.nodeBounds(big).w, bigSize.w, '外接尺寸与正方形边长一致');

  // 端口不能压到标题栏或底部信息条（画布上信息条画在 h/2-16 与 h/2-20）
  [1, 2, 3, 4, 6, 8].forEach(function (n) {
    var bb = M.makeBuffer({ name: 'B', inputs: [] });
    for (var ii = 0; ii < n; ii++) bb.recipe.inputs.push(M.makeRecipeLine('x', 1));
    var bs = M.bufferSize(bb);
    var firstY = M.portLocal(bb, 'in', 0).y;
    var lastY = M.portLocal(bb, 'in', n - 1).y;
    ok(firstY >= -bs.h / 2 + M.BUFFER_HEADER_H, n + ' 个输入时首个端口不侵入标题栏');
    ok(lastY <= bs.h / 2 - 16 - 12, n + ' 个输入时最后一行端口不压到底部信息条（间距 ' + (bs.h / 2 - 16 - lastY).toFixed(0) + 'px）');
  });
})();

section('缓存器：序列化往返（只存输入，输出自动派生）');
(function () {
  var flow = M.createFlow('缓存器序列化');
  var item = M.makeItem({ name: '硫酸', state: 'fluid' });
  flow.items.push(item);
  var buf = M.makeBuffer({ name: '酸罐', x: 120, y: -60, inputs: [M.makeRecipeLine(item.id, 250)] });
  flow.nodes.push(buf);
  var text = M.flowToText(flow);
  var parsed = M.parseFlowText(text);
  ok(parsed.ok && parsed.warnings.length === 0, '缓存器流程可无损往返');
  var nb = parsed.flow.nodes[0];
  eq(nb.kind, 'buffer', '节点类型保持为 buffer');
  eq(nb.recipe.inputs.length, 1, '输入条数保持');
  eq(nb.recipe.inputs[0].count, 250, '输入数量保持');
  eq(M.itemLabel(parsed.flow, nb.recipe.inputs[0].itemId), '硫酸', '物品引用保持');
  eq(M.nodePorts(nb).outputs.length, 1, '导入后输出仍然派生为 1 个');
  ok(!nb.recipe.outputs || nb.recipe.outputs.length === 0, '文件里不会保存输出（由输入派生）');
  // 兼容别名
  var alias = M.parseFlowText('{"format":"gtline.flow","nodes":[{"kind":"cache","name":"C","recipe":{"inputs":[{"itemId":"x","count":1}]}}]}');
  ok(alias.ok && alias.flow.nodes[0].kind === 'buffer', 'kind:"cache" 别名也能识别为缓存器');
})();

section('缓存器：进出速率恒等（模拟）');
(function () {
  var flow = M.createFlow('缓存器速率');
  var iron = M.makeItem({ name: '铁锭' });
  flow.items.push(iron);
  var src = M.makeDiamond('source', { name: '源', itemId: iron.id, count: 1, ticks: 20 }); // 1/s
  var buf = M.makeBuffer({ name: '缓存', inputs: [M.makeRecipeLine(iron.id, 1)] });
  var m = M.makeMachine({ name: 'M', power: 10, ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [] });
  flow.nodes.push(src, buf, m);
  var l1 = mkLink(src, 0, buf, 0), l2 = mkLink(buf, 0, m, 0);
  flow.links.push(l1, l2);
  var an = G.analyze(flow);
  eq(an.counts.error, 0, '经过缓存器的链路 0 错误');
  var sim = G.simulate(flow, an);
  near(sim.buffer[buf.id].totalIn, 1, '缓存器总输入 1/s');
  near(sim.buffer[buf.id].totalOut, 1, '缓存器总输出 1/s（与输入恰好相等）');
  near(sim.buffer[buf.id].ports[0].inRate, sim.buffer[buf.id].ports[0].outRate, '每条通道：进 = 出');
  near(sim.machine[m.id].craftRate, 1, '下游机器拿到 1/s 后满速');
  near(sim.linkRate[l2.id], 1, '缓存器下游连线流量 1/s');

  // 上游供料不足时，缓存器输出跟着变少（仍然恒等）
  src.emit.ticks = 80; // 0.25/s
  var an2 = G.analyze(flow);
  var sim2 = G.simulate(flow, an2);
  near(sim2.buffer[buf.id].totalIn, 0.25, '供料不足时缓存器输入 0.25/s');
  near(sim2.buffer[buf.id].totalOut, 0.25, '缓存器输出同样 0.25/s');
  ok(an2.issueList.some(function (i) { return /供料不足/.test(i.msg); }), '下游机器仍被正确判为供料不足（与模拟一致）');
})();

section('缓存器：多通道独立中转 + 下游扇出后总量守恒');
(function () {
  var flow = M.createFlow('多通道');
  var A = M.makeItem({ name: 'A' }), B = M.makeItem({ name: 'B' });
  flow.items.push(A, B);
  var srcA = M.makeDiamond('source', { name: '源A', itemId: A.id, count: 3, ticks: 20 }); // 3/s
  var srcB = M.makeDiamond('source', { name: '源B', itemId: B.id, count: 1, ticks: 40 }); // 0.5/s
  var buf = M.makeBuffer({ name: '双通道', inputs: [M.makeRecipeLine(A.id, 1), M.makeRecipeLine(B.id, 1)] });
  var m1 = M.makeMachine({ name: 'M1', ticks: 20, inputs: [M.makeRecipeLine(A.id, 1)], outputs: [] });
  var m2 = M.makeMachine({ name: 'M2', ticks: 20, inputs: [M.makeRecipeLine(A.id, 1)], outputs: [] });
  var m3 = M.makeMachine({ name: 'M3', ticks: 40, inputs: [M.makeRecipeLine(B.id, 1)], outputs: [] }); // 需要 0.5/s
  flow.nodes.push(srcA, srcB, buf, m1, m2, m3);
  var l1 = mkLink(srcA, 0, buf, 0);
  var l2 = mkLink(srcB, 0, buf, 1);
  var l3 = mkLink(buf, 0, m1, 0);
  var l4 = mkLink(buf, 0, m2, 0);   // 通道 1 下游扇出 2
  var l5 = mkLink(buf, 1, m3, 0);
  flow.links.push(l1, l2, l3, l4, l5);
  var an = G.analyze(flow);
  var sim = G.simulate(flow, an);
  near(sim.buffer[buf.id].ports[0].inRate, 3, '通道 1 输入 3/s');
  near(sim.buffer[buf.id].ports[0].outRate, 3, '通道 1 输出 3/s（扇出后两条线各 1.5/s 之和）');
  near(sim.buffer[buf.id].ports[1].inRate, 0.5, '通道 2 输入 0.5/s');
  near(sim.buffer[buf.id].ports[1].outRate, 0.5, '通道 2 输出 0.5/s');
  near(sim.buffer[buf.id].totalIn, 3.5, '总输入 3.5/s');
  near(sim.buffer[buf.id].totalOut, 3.5, '总输出 3.5/s（总输入 = 总输出）');
  near(sim.linkRate[l3.id], 1.5, '通道 1 扇出后每条下游连线 1.5/s');
  near(sim.linkRate[l4.id], 1.5, '通道 1 扇出后每条下游连线 1.5/s');
  near(sim.machine[m1.id].craftRate, 1, 'M1 受自身产能限制（1 次/s），多余的被浪费');
  near(sim.machine[m3.id].craftRate, 0.5, 'M3 拿到 0.5/s 后正好满速 0.5 次/s');
  ok(an.issueList.some(function (i) { return i.level === 'warn' && /供料过量/.test(i.msg); }), '中转过来的物料超过机器消耗 → 供料过量警告');
  eq(an.counts.error, 0, '多通道缓存器本身没有错误');
})();

section('缓存器：输入内容必须匹配（沿用机器的报错规则）');
(function () {
  var flow = M.createFlow('缓存器内容校验');
  var iron = M.makeItem({ name: '铁锭' }), copper = M.makeItem({ name: '铜锭' });
  flow.items.push(iron, copper);
  var src = M.makeDiamond('source', { name: '铜源', itemId: copper.id, count: 1, ticks: 20 });
  var buf = M.makeBuffer({ name: '缓存', inputs: [M.makeRecipeLine(iron.id, 1)] });
  var m = M.makeMachine({ name: 'M', ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [] });
  flow.nodes.push(src, buf, m);
  var bad = mkLink(src, 0, buf, 0);
  var good = mkLink(buf, 0, m, 0);
  flow.links.push(bad, good);
  var an = G.analyze(flow);
  ok(an.linkIssues[bad.id] && an.linkIssues[bad.id].level === 'error', '接错物品的缓存器输入连线标红');
  ok(/内容不匹配/.test(an.linkIssues[bad.id].msg), '报错说明内容不匹配');
  ok(!an.linkIssues[good.id], '缓存器输出到下游的连线没问题（输出仍是铁锭）');
  ok(an.portIssues[M.inPortKey(buf.id, 0)], '缓存器输入口被标记为问题端口');

  // 未接线的输入口 / 未连接的输出口
  var flow2 = M.createFlow('缓存器接线检查');
  flow2.items.push(iron);
  var buf2 = M.makeBuffer({ name: '孤立缓存', inputs: [M.makeRecipeLine(iron.id, 1)] });
  flow2.nodes.push(buf2);
  var an2 = G.analyze(flow2);
  ok(an2.issueList.some(function (i) { return i.level === 'error' && /缓存器.*没有接入任何连线/.test(i.msg); }), '未接线的缓存器输入口报错');
  ok(an2.issueList.some(function (i) { return i.level === 'warn' && /缓存器.*没有连接/.test(i.msg); }), '未连接的缓存器输出口警告');
})();

section('缓存器：打破循环连接（两台机器直连的警报保留）');
(function () {
  var A = M.makeItem({ name: '上料' }), X = M.makeItem({ name: '中间物' });
  // 环路：前段机（上料 → 中间物）→ 后段机（中间物 → 上料）→ 前段机
  function build(withBuffer) {
    var flow = M.createFlow(withBuffer ? '带缓存器的环' : '直连环');
    flow.items.push(A, X);
    var src = M.makeDiamond('source', { name: '外部上料', itemId: A.id, count: 1, ticks: 20 });
    var mA = M.makeMachine({ name: '前段机', power: 20, ticks: 20, inputs: [M.makeRecipeLine(A.id, 1)], outputs: [M.makeRecipeLine(X.id, 1)] });
    var mB = M.makeMachine({ name: '后段机', power: 20, ticks: 20, inputs: [M.makeRecipeLine(X.id, 1)], outputs: [M.makeRecipeLine(A.id, 1)] });
    flow.nodes.push(src, mA);
    var links = [mkLink(src, 0, mA, 0)];
    if (withBuffer) {
      var buf = M.makeBuffer({ name: '缓存器', inputs: [M.makeRecipeLine(X.id, 1)] });
      flow.nodes.push(buf, mB);
      links.push(mkLink(mA, 0, buf, 0), mkLink(buf, 0, mB, 0), mkLink(mB, 0, mA, 0));
      flow.links = links;
      return { flow: flow, src: src, mA: mA, mB: mB, buf: buf, links: links };
    }
    flow.nodes.push(mB);
    links.push(mkLink(mA, 0, mB, 0), mkLink(mB, 0, mA, 0));
    flow.links = links;
    return { flow: flow, src: src, mA: mA, mB: mB, links: links };
  }

  // 两台机器直接成环：保留报错，并提示需要缓存器
  var plain = build(false);
  var anPlain = G.analyze(plain.flow);
  eq(anPlain.counts.error, 2, '两台机器直连成环 → 2 条连线都报错' +
    (anPlain.counts.error !== 2 ? '，实际：' + anPlain.issueList.filter(function (i) { return i.level === 'error'; }).map(function (i) { return i.msg.slice(0, 30); }).join(' / ') : ''));
  ok(anPlain.cycles.length === 1, '检测到 1 个环路');
  ok(anPlain.issueList.filter(function (i) { return i.level === 'error'; }).every(function (i) {
    return /环路/.test(i.msg) && /缓存器/.test(i.msg);
  }), '报错信息提示“若需循环连接必须使用缓存器”');
  ok(anPlain.issueList.some(function (i) { return /接入一个「缓存器」/.test(i.msg); }), '报错里明确给出缓存器建议');
  eq(anPlain.bufferLoops.length, 0, '没有缓存器闭环');

  // 环路中接入缓存器：成立（无错误）
  var loop = build(true);
  var anLoop = G.analyze(loop.flow);
  eq(anLoop.counts.error, 0, '环路中接入缓存器后 0 错误' + (anLoop.counts.error ? '：' + anLoop.issueList[0].msg : ''));
  eq(anLoop.cycles.length, 1, '图上仍然存在闭环（只是被缓存器打破）');
  eq(anLoop.bufferLoops.length, 1, '识别为“经缓存器闭合的循环”');
  ok(anLoop.issueList.some(function (i) { return i.level === 'info' && /循环连接成立/.test(i.msg); }), '给出“循环连接成立”的说明');
  var sim = G.simulate(loop.flow, anLoop);
  near(sim.machine[loop.mA.id].craftRate, 1, '环内前段机满速 1 次/s');
  near(sim.machine[loop.mB.id].craftRate, 1, '环内后段机满速 1 次/s');
  near(sim.buffer[loop.buf.id].totalIn, 1, '缓存器中转 1/s');
  near(sim.buffer[loop.buf.id].totalOut, 1, '缓存器输出 1/s（进出恒等）');

  // 机器 → 缓存器 → 回到自己：也应被允许
  var selfLoop = M.createFlow('自反馈');
  var Z = M.makeItem({ name: 'Z' });
  selfLoop.items.push(Z);
  var m = M.makeMachine({ name: '自反馈机', ticks: 20, inputs: [M.makeRecipeLine(Z.id, 1)], outputs: [M.makeRecipeLine(Z.id, 1)] });
  var b = M.makeBuffer({ name: '缓冲', inputs: [M.makeRecipeLine(Z.id, 1)] });
  selfLoop.nodes.push(m, b);
  selfLoop.links.push(mkLink(m, 0, b, 0), mkLink(b, 0, m, 0));
  var anSelf = G.analyze(selfLoop);
  eq(anSelf.counts.error, 0, '机器经缓存器自反馈不再报环路错误');
  eq(anSelf.bufferLoops.length, 1, '识别为缓存器闭环');
})();

section('缓存器：自动排版与预设');
(function () {
  // 排版：带缓存器的环
  var flow = M.createFlow('排版缓存器');
  var it = M.makeItem({ name: '物料' });
  flow.items.push(it);
  var src = M.makeDiamond('source', { name: '源', itemId: it.id, count: 1, ticks: 20 });
  var m1 = M.makeMachine({ name: 'M1', ticks: 20, inputs: [M.makeRecipeLine(it.id, 1)], outputs: [M.makeRecipeLine(it.id, 1)] });
  var buf = M.makeBuffer({ name: '缓存', inputs: [M.makeRecipeLine(it.id, 1)] });
  var m2 = M.makeMachine({ name: 'M2', ticks: 20, inputs: [M.makeRecipeLine(it.id, 1)], outputs: [M.makeRecipeLine(it.id, 1)] });
  var sink = M.makeDiamond('sink', { name: '汇' });
  flow.nodes.push(src, m1, buf, m2, sink);
  flow.links.push(mkLink(src, 0, m1, 0), mkLink(m1, 0, buf, 0), mkLink(buf, 0, m2, 0), mkLink(m2, 0, sink, 0), mkLink(m2, 0, m1, 0));
  var info = G.computeLayers(flow);
  eq(info.stepOf[src.id], 0, '源第 0 步');
  eq(info.stepOf[m1.id], 1, 'M1 第 1 步');
  eq(info.stepOf[buf.id], 2, '缓存器第 2 步');
  ok(info.stepOf[m2.id] <= 3, 'M2 步数由最短路径决定（' + info.stepOf[m2.id] + '）');
  var res = G.autoLayout(flow, { snap: true });
  eq(res.columns >= 4, true, '排版出 ' + res.columns + ' 列');
  assertNoOverlap(flow, '含缓存器的产线排版无重叠');
  assertFinitePos(flow, '含缓存器的产线排版坐标有效');

  // 预设
  PS.clearAll();
  var p = PS.fromNode(flow, buf);
  eq(p.type, 'buffer', '缓存器节点生成 buffer 预设');
  ok(p.buffer.inputs.length === 1, '预设保留输入条数');
  eq(p.buffer.inputs[0].item.name, '物料', '预设内嵌物品快照');
  PS.upsert(p);
  eq(PS.list('buffer').length, 1, '预设库中出现缓存器预设');
  var target = M.createFlow('实例化缓存器');
  var created = PS.instantiate(target, p, 10, 20);
  eq(created.kind, 'buffer', '实例化出缓存器节点');
  eq(M.nodePorts(created).inputs.length, 1, '实例化后输入口数量正确');
  eq(M.nodePorts(created).outputs.length, 1, '实例化后输出口自动镜像');
  eq(created.name, '缓存', '实例化保留名称');
  var t2 = M.makeBuffer({ name: '空缓存' });
  ok(PS.applyToNode(target, p, t2), '预设可以套用到已有缓存器');
  eq(t2.recipe.inputs.length, 1, '套用后输入更新');
  eq(M.nodePorts(t2).outputs.length, 1, '套用后输出同步镜像');
  ok(!PS.applyToNode(target, p, M.makeMachine({ name: '机器' })), '机器类型的节点无法套用缓存器预设');
})();

section('缓存器：长链（30 级串联）能正确传播，进 = 出');
(function () {
  var flow = M.createFlow('缓存器长链');
  var ore = M.makeItem({ name: '物料' });
  flow.items.push(ore);
  var src = M.makeDiamond('source', { name: '源', itemId: ore.id, count: 1, ticks: 20 }); // 1/s
  flow.nodes.push(src);
  var chain = [];
  for (var i = 0; i < 30; i++) {
    var b = M.makeBuffer({ name: '缓存' + i, inputs: [M.makeRecipeLine(ore.id, 1)] });
    chain.push(b);
    flow.nodes.push(b);
  }
  var m = M.makeMachine({ name: '末端机', ticks: 20, inputs: [M.makeRecipeLine(ore.id, 1)], outputs: [] });
  flow.nodes.push(m);
  flow.links.push(mkLink(src, 0, chain[0], 0));
  for (var k = 0; k < chain.length - 1; k++) flow.links.push(mkLink(chain[k], 0, chain[k + 1], 0));
  flow.links.push(mkLink(chain[chain.length - 1], 0, m, 0));

  var t0 = Date.now();
  var an = G.analyze(flow);
  var sim = G.simulate(flow, an);
  var elapsed = Date.now() - t0;
  eq(an.counts.error, 0, '30 级缓存器链 0 错误');
  ok(chain.every(function (b) {
    var s = sim.buffer[b.id];
    return Math.abs(s.totalIn - 1) < 1e-6 && Math.abs(s.totalOut - 1) < 1e-6 && Math.abs(s.totalIn - s.totalRelay) < 1e-9;
  }), '每一级缓存器都把 1/s 原样传出（总进 = 总出 = 1/s）');
  near(sim.machine[m.id].craftRate, 1, '末端机器拿到 1/s 并满速');
  ok(elapsed < 3000, '长链模拟耗时可接受（' + elapsed + ' ms）');
})();

section('缓存器：边界与安全性（输出不可篡改 / 混合环路 / 不计耗电）');
(function () {
  // 1) 手改文件里给缓存器塞了独立的 outputs：导入后必须被忽略，输出仍由输入派生
  var X = M.makeItem({ name: 'X' }), Y = M.makeItem({ name: 'Y' });
  var raw = {
    format: 'gtline.flow', version: 1,
    items: [{ id: 'i-x', name: 'X', state: 'solid' }, { id: 'i-y', name: 'Y', state: 'solid' }],
    nodes: [{
      id: 'buf-1', kind: 'buffer', name: '被篡改的缓存器', x: 0, y: 0,
      recipe: { inputs: [{ id: 'r1', itemId: 'i-x', count: 2 }], outputs: [{ id: 'r2', itemId: 'i-y', count: 9 }] }
    }],
    links: []
  };
  var parsed = M.parseFlowText(JSON.stringify(raw));
  ok(parsed.ok, '被篡改的文件仍能导入');
  var nb = parsed.flow.nodes[0];
  var np = M.nodePorts(nb);
  eq(np.outputs.length, 1, '输出口数量仍由输入决定');
  eq(np.outputs[0].itemId, 'i-x', '输出物品被强制为输入物品（i-y 被忽略）');
  eq(np.outputs[0].count, 2, '输出数量被强制为输入数量（9 被忽略）');
  eq(M.resolveOutPort(parsed.flow, 'buf-1', 0).itemId, 'i-x', 'resolveOutPort 同样只认输入');

  // 2) 机器 A↔B 成环，同时另有一条经过缓存器的路径（同一 SCC）：机器环仍必须报错
  var flow = M.createFlow('混合环路');
  var A = M.makeItem({ name: '上料' }), Z = M.makeItem({ name: '中间物' });
  flow.items.push(A, Z);
  var src = M.makeDiamond('source', { name: '源', itemId: A.id, count: 1, ticks: 20 });
  var ma = M.makeMachine({ name: 'A机', ticks: 20, inputs: [M.makeRecipeLine(A.id, 1)], outputs: [M.makeRecipeLine(Z.id, 1)] });
  var mb = M.makeMachine({ name: 'B机', ticks: 20, inputs: [M.makeRecipeLine(Z.id, 1)], outputs: [M.makeRecipeLine(A.id, 1)] });
  var buf = M.makeBuffer({ name: '旁路缓存', inputs: [M.makeRecipeLine(Z.id, 1)] });
  var mc = M.makeMachine({ name: 'C机', ticks: 20, inputs: [M.makeRecipeLine(Z.id, 1)], outputs: [] });
  flow.nodes.push(src, ma, mb, buf, mc);
  var lDirect1 = mkLink(ma, 0, mb, 0);
  var lDirect2 = mkLink(mb, 0, ma, 0);   // A机 ↔ B机 直接成环（不含缓存器）
  var lBufIn = mkLink(ma, 0, buf, 0);    // 另有一条经过缓存器的支路
  var lBufOut = mkLink(buf, 0, mc, 0);
  flow.links.push(mkLink(src, 0, ma, 0), lDirect1, lDirect2, lBufIn, lBufOut);
  var an = G.analyze(flow);
  ok(an.linkIssues[lDirect1.id] && an.linkIssues[lDirect1.id].level === 'error', '机器 A↔B 的直接环路仍然报错（缓存器在别处也不能豁免）');
  ok(an.linkIssues[lDirect2.id] && an.linkIssues[lDirect2.id].level === 'error', '环路两条连线都标红');
  function cycleIssue(id) {
    var iss = an.linkIssues[id];
    return !!(iss && /环路/.test(iss.msg));
  }
  ok(!cycleIssue(lBufIn.id) && !cycleIssue(lBufOut.id), '经过缓存器的支路不会被判为环路违规（环上仍可能因其它原因报错）');
  ok(cycleIssue(lDirect1.id) && cycleIssue(lDirect2.id), '不含缓存器的那两条直接连线才是环路报错的对象');
  ok(/缓存器/.test(an.linkIssues[lDirect1.id].msg), '报错里带缓存器提示');

  // 3) 纯缓存器互环（无来源）：不报错、流量为 0
  var bflow = M.createFlow('缓存器互环');
  var it = M.makeItem({ name: '物料' });
  bflow.items.push(it);
  var b1 = M.makeBuffer({ name: 'B1', inputs: [M.makeRecipeLine(it.id, 1)] });
  var b2 = M.makeBuffer({ name: 'B2', inputs: [M.makeRecipeLine(it.id, 1)] });
  bflow.nodes.push(b1, b2);
  bflow.links.push(mkLink(b1, 0, b2, 0), mkLink(b2, 0, b1, 0));
  var anB = G.analyze(bflow);
  eq(anB.counts.error, 0, '缓存器之间互环不算错误（有缓冲）');
  var simB = G.simulate(bflow, anB);
  near(simB.buffer[b1.id].totalIn, 0, '没有外部来源时流量为 0（不会凭空产生物料）');
  near(simB.buffer[b1.id].totalIn, simB.buffer[b1.id].totalRelay, '缓存器互环里依然满足进 = 中转');

  // 4) 缓存器不计耗电/耗时
  var stats = M.createFlow('统计');
  var m1 = M.makeMachine({ name: 'M', power: 25, ticks: 30 });
  stats.nodes.push(m1);
  var an1 = G.analyze(stats);
  eq(an1.stats.power, 25, '只有机器计入耗电');
  eq(an1.stats.ticks, 30, '只有机器计入耗时');
  stats.nodes.push(M.makeBuffer({ name: 'B', inputs: [] }));
  var an2 = G.analyze(stats);
  eq(an2.stats.power, 25, '加入缓存器后理论最大耗电量不变');
  eq(an2.stats.ticks, 30, '加入缓存器后理论最大耗时不变');
  eq(an2.stats.bufferCount, 1, '统计里单独记录缓存器数量');
  eq(an2.stats.machineCount, 1, '机器数量不受影响');
})();

section('回归 D1/D2：缓存器闭环必须收敛、不凭空产生物料、进 = 出');
(function () {
  // ---- D1：有出料端的缓存器环（40/s 源 → B1 → B2 → 回到 B1，B2 另有出料）----
  var flow = M.createFlow('缓存器环-有出料');
  var it = M.makeItem({ name: '物料' });
  flow.items.push(it);
  var src = M.makeDiamond('source', { name: '源', itemId: it.id, count: 2, ticks: 1 }); // 40/s
  var b1 = M.makeBuffer({ name: 'B1', inputs: [M.makeRecipeLine(it.id, 1)] });
  var b2 = M.makeBuffer({ name: 'B2', inputs: [M.makeRecipeLine(it.id, 1)] });
  var sink = M.makeDiamond('sink', { name: '出料' });
  flow.nodes.push(src, b1, b2, sink);
  flow.links.push(mkLink(src, 0, b1, 0), mkLink(b1, 0, b2, 0), mkLink(b2, 0, b1, 0), mkLink(b2, 0, sink, 0));
  var an = G.analyze(flow);
  var sim = G.simulate(flow, an);
  eq(an.counts.error, 0, 'D1 无错误');
  eq(an.counts.warn, 0, 'D1 无警告（环内有出料端，不是堵塞环）');
  eq(sim.converged, true, 'D1 弛豫收敛（converged）');
  var maxDiff = 0;
  [b1, b2].forEach(function (b) {
    var s = sim.buffer[b.id];
    maxDiff = Math.max(maxDiff, Math.abs(s.totalIn - s.totalOut), Math.abs(s.totalIn - s.totalRelay));
    s.ports.forEach(function (p) {
      maxDiff = Math.max(maxDiff, Math.abs(p.inRate - p.outRate), Math.abs(p.inRate - p.relay));
    });
  });
  ok(maxDiff < 1e-6, 'D1 每条通道 进 = 中转 = 出（最大偏差 ' + maxDiff.toExponential(2) + '）');
  near(sim.sink[sink.id].intake, 40, 'D1 出料端恰好拿到 40/s（等于源供应量，无凭空产生）');
  near(sim.buffer[b1.id].totalIn, 80, 'D1 B1 的总吞吐 80/s（40 新料 + 40 循环料）');
  ok(sim.buffer[b1.id].totalIn <= 80 + 1e-6 && sim.buffer[b2.id].totalIn <= 80 + 1e-6, 'D1 不会超过环路的稳定吞吐');

  // ---- 20 级大环也应收敛 ----
  var big = M.createFlow('大环');
  big.items.push(it);
  var src2 = M.makeDiamond('source', { name: '源', itemId: it.id, count: 2, ticks: 1 });
  big.nodes.push(src2);
  var ring = [];
  for (var i = 0; i < 20; i++) {
    var rb = M.makeBuffer({ name: 'R' + i, inputs: [M.makeRecipeLine(it.id, 1)] });
    ring.push(rb);
    big.nodes.push(rb);
  }
  var sink2 = M.makeDiamond('sink', { name: '出料' });
  big.nodes.push(sink2);
  big.links.push(mkLink(src2, 0, ring[0], 0));
  for (var k = 0; k < 20; k++) big.links.push(mkLink(ring[k], 0, ring[(k + 1) % 20], 0));
  big.links.push(mkLink(ring[10], 0, sink2, 0));
  var t0 = Date.now();
  var anBig = G.analyze(big);
  var simBig = G.simulate(big, anBig);
  var elapsed = Date.now() - t0;
  eq(simBig.converged, true, '20 级缓存器环收敛');
  var worstBig = 0;
  ring.forEach(function (b) {
    var s = simBig.buffer[b.id];
    worstBig = Math.max(worstBig, Math.abs(s.totalIn - s.totalOut), Math.abs(s.totalIn - s.totalRelay));
  });
  ok(worstBig < 1e-6, '20 级环每条缓存器 进 = 出（最大偏差 ' + worstBig.toExponential(2) + '）');
  near(simBig.sink[sink2.id].intake, 40, '20 级环出料端仍是 40/s（守恒，不放大）');
  ok(elapsed < 3000, '20 级环模拟耗时可接受（' + elapsed + ' ms）');
  eq(anBig.counts.error, 0, '20 级环无错误');

  // ---- D2：没有出料/消耗端的缓存器环 → 堵塞、0 流量、给出警告 ----
  var stall = M.createFlow('堵塞环');
  stall.items.push(it);
  var src3 = M.makeDiamond('source', { name: '源', itemId: it.id, count: 2, ticks: 1 });
  var c1 = M.makeBuffer({ name: 'C1', inputs: [M.makeRecipeLine(it.id, 1)] });
  var c2 = M.makeBuffer({ name: 'C2', inputs: [M.makeRecipeLine(it.id, 1)] });
  stall.nodes.push(src3, c1, c2);
  stall.links.push(mkLink(src3, 0, c1, 0), mkLink(c1, 0, c2, 0), mkLink(c2, 0, c1, 0));
  var anStall = G.analyze(stall);
  var simStall = G.simulate(stall, anStall);
  eq(anStall.counts.error, 0, '堵塞环不算错误（有缓存器）');
  ok(anStall.issueList.some(function (i) { return i.level === 'warn' && /堵/.test(i.msg); }), '堵塞环给出“会装满堵塞”的警告');
  eq(Object.keys(anStall.stalledBuffers).length, 2, '识别出 2 个堵塞缓存器');
  [c1, c2].forEach(function (b) {
    var s = simStall.buffer[b.id];
    near(s.totalIn, 0, b.name + ' 堵塞时输入为 0（上游进不来）');
    near(s.totalOut, 0, b.name + ' 堵塞时输出为 0');
    near(s.totalRelay, 0, b.name + ' 堵塞时中转量为 0');
  });
  near(simStall.source[src3.id].used, 0, '源被堵塞：实际用量 0（不会显示成凭空循环的几百 /s）');
  eq(simStall.converged, true, '堵塞环模拟同样收敛（全 0）');
})();

section('回归 D3：删除/清空缓存器输入行时，镜像输出口上的连线一起处理');
(function () {
  var A = M.makeItem({ name: 'A' }), B = M.makeItem({ name: 'B' });
  var flow = M.createFlow('缓存器删行');
  flow.items.push(A, B);
  var buf = M.makeBuffer({ name: 'BUF', inputs: [M.makeRecipeLine(A.id, 1), M.makeRecipeLine(B.id, 1)] });
  var k1 = M.makeMachine({ name: 'K1', ticks: 20, inputs: [M.makeRecipeLine(A.id, 1)], outputs: [] });
  var k2 = M.makeMachine({ name: 'K2', ticks: 20, inputs: [M.makeRecipeLine(B.id, 1)], outputs: [] });
  flow.nodes.push(buf, k1, k2);
  var outA = mkLink(buf, 0, k1, 0);
  var outB = mkLink(buf, 1, k2, 0);
  flow.links.push(outA, outB);
  eq(M.recipeRowLinks(flow, buf, 'inputs', 0).length, 1, '第 1 行统计到它的镜像输出连线');
  eq(M.recipeRowLinks(flow, buf, 'inputs', 1).length, 1, '第 2 行统计到它的镜像输出连线');

  var res = M.removeRecipeRow(flow, buf, 'inputs', 0);
  eq(res.dropped.length, 1, '删除第 1 行：同时删除它镜像输出口上的连线');
  eq(flow.links.indexOf(outA), -1, '被删掉的正是 BUF 输出口 1 → K1 的连线（不会残留并改指别的物品）');
  eq(flow.links.length, 1, '另一条连线保留');
  eq(outB.from.index, 0, '原第 2 行的输出连线索引前移到 1 号通道');
  eq(outB.to.index, 0, 'K2 的输入口索引不变（它是独立节点）');
  eq(flow.nodes[0].recipe.inputs.length, 1, '配方剩 1 行');
  var an = G.analyze(flow);
  ok(!an.issueList.some(function (i) { return /已不存在/.test(i.msg); }), '不会出现“端口已不存在（配方被修改）”的误导报错');
  ok(!an.issueList.some(function (i) { return /只接受/.test(i.msg); }), '不会出现输出端口被改指到别的物品导致的误报');

  // 清空一侧：输入与镜像输出连线都要清掉
  var flow2 = M.createFlow('缓存器清空');
  flow2.items.push(A, B);
  var buf2 = M.makeBuffer({ name: 'BUF2', inputs: [M.makeRecipeLine(A.id, 1), M.makeRecipeLine(B.id, 1)] });
  var ka = M.makeMachine({ name: 'KA', ticks: 20, inputs: [M.makeRecipeLine(A.id, 1)], outputs: [] });
  var kb = M.makeMachine({ name: 'KB', ticks: 20, inputs: [M.makeRecipeLine(B.id, 1)], outputs: [] });
  var srcA = M.makeDiamond('source', { name: '源A', itemId: A.id, count: 1, ticks: 20 });
  var srcB = M.makeDiamond('source', { name: '源B', itemId: B.id, count: 1, ticks: 20 });
  flow2.nodes.push(buf2, ka, kb, srcA, srcB);
  flow2.links.push(mkLink(srcA, 0, buf2, 0), mkLink(srcB, 0, buf2, 1), mkLink(buf2, 0, ka, 0), mkLink(buf2, 1, kb, 0));
  eq(flow2.links.length, 4, '清空前 4 条连线（2 进 2 出）');
  var removed = M.clearRecipeSide(flow2, buf2, 'inputs');
  eq(removed, 4, '清空缓存器输入：输入与镜像输出共 4 条连线一起移除');
  eq(flow2.links.length, 0, '没有残留的悬空连线');
  eq(M.nodePorts(buf2).outputs.length, 0, '输出口随输入一起消失');
  var an2 = G.analyze(flow2);
  ok(!an2.issueList.some(function (i) { return /已不存在/.test(i.msg); }), '清空后不会留下“端口不存在”的误导报错');
})();

/* ============================================================== 健壮性 */

section('健壮性：极端/脏数据不产生 NaN、Infinity 或负流量');
(function () {
  var empty = M.createFlow('空');
  var an0 = G.analyze(empty);
  var sim0 = G.simulate(empty, an0);
  ok(isFinite(sim0.totals.itemPerSec) && sim0.totals.itemPerSec === 0, '空流程模拟结果为 0');

  var flow = M.createFlow('脏数据');
  flow.nodes.push(M.makeMachine({ name: 'M', ticks: 0, power: -5, inputs: [M.makeRecipeLine('', 0)], outputs: [] }));
  var parsed = M.parseFlowText(M.flowToText(flow));
  var m = parsed.flow.nodes[0];
  ok(m.ticks >= 1, '耗时 0 被纠正为最小 1 tick（实际 ' + m.ticks + '）');
  ok(m.power >= 0, '负耗电量被纠正为 0（实际 ' + m.power + '）');
  ok(m.recipe.inputs[0].count >= 1, '配方数量 0 被纠正为 ≥1');
  var an = G.analyze(parsed.flow);
  var sim = G.simulate(parsed.flow, an);
  ok(isFinite(sim.totals.itemPerSec), '脏数据模拟结果有限');
  Object.keys(sim.linkRate).forEach(function (k) {
    ok(isFinite(sim.linkRate[k]) && sim.linkRate[k] >= 0, '连线流量有限且非负：' + sim.linkRate[k]);
  });
  Object.keys(sim.machine).forEach(function (k) {
    ok(isFinite(sim.machine[k].craftRate) && sim.machine[k].craftRate >= 0, '机器速率有限且非负：' + sim.machine[k].craftRate);
  });
})();

section('健壮性：大规模一对多（扇出 12）—— 判定需与模拟的均分一致');
(function () {
  var flow = M.createFlow('大扇出');
  var iron = M.makeItem({ name: '铁锭' });
  flow.items.push(iron);
  var src = M.makeDiamond('source', { name: '源', itemId: iron.id, count: 6, ticks: 20 }); // 6/s
  flow.nodes.push(src);
  var made = [];
  for (var i = 0; i < 12; i++) {
    var m = M.makeMachine({ name: 'M' + i, power: 1, ticks: 20, inputs: [M.makeRecipeLine(iron.id, 2)], outputs: [] });
    flow.nodes.push(m);
    made.push(m);
    flow.links.push(mkLink(src, 0, m, 0));
  }
  var an = G.analyze(flow);
  var sim = G.simulate(flow, an);
  var total = 0;
  made.forEach(function (m) { total += sim.machine[m.id].craftRate; });
  near(sim.linkRate[flow.links[0].id], 0.5, '12 路均分：每路 0.5/s');
  near(total, 6 / 2, '总消耗速率不超过供给（12 × 0.25 次/s × 2 = 6/s）');
  eq(an.counts.error, 12, '每台机器都拿不到满速所需的 2/s，因此 12 条连线都报“供料不足”');
  ok(an.issueList.filter(function (i) { return i.level === 'error'; }).every(function (i) { return /供料不足/.test(i.msg); }), '错误类型都是供料不足');
  ok(made.every(function (m) { return Math.abs(sim.machine[m.id].craftRate - 0.25) < 1e-9; }), '模拟中每台机器 0.25 次/s（与判定一致）');
})();

/* ------------------------------------------------- 独立评审后的回归测试 */

section('回归 D1：重排配方时连线跟随它对应的端口，不会被改成不匹配');
(function () {
  var flow = M.createFlow('重排');
  var iron = M.makeItem({ name: '铁锭' });
  var copper = M.makeItem({ name: '铜锭' });
  var plate = M.makeItem({ name: '铁板' });
  flow.items.push(iron, copper, plate);
  var s1 = M.makeDiamond('source', { name: '铁锭源', itemId: iron.id, count: 1, ticks: 20 });
  var s2 = M.makeDiamond('source', { name: '铜锭源', itemId: copper.id, count: 1, ticks: 20 });
  var m = M.makeMachine({
    name: 'M', power: 10, ticks: 20,
    inputs: [M.makeRecipeLine(iron.id, 1), M.makeRecipeLine(copper.id, 1)],
    outputs: [M.makeRecipeLine(plate.id, 1)]
  });
  flow.nodes.push(s1, s2, m);
  var L1 = mkLink(s1, 0, m, 0);
  var L2 = mkLink(s2, 0, m, 1);
  flow.links.push(L1, L2);
  eq(G.analyze(flow).counts.error, 0, '初始接线无错误');
  ok(M.moveRecipeRow(flow, m, 'inputs', 0, 1), '下移配方行成功');
  eq(flow.nodes[2].recipe.inputs[0].itemId, copper.id, '配方第 1 行变成铜锭');
  eq(L1.to.index, 1, '铁锭源的连线跟随到第 2 个端口');
  eq(L2.to.index, 0, '铜锭源的连线跟随到第 1 个端口');
  eq(G.analyze(flow).counts.error, 0, '重排后依然无错误（连线跟着它需要的物品走）');
  ok(!M.moveRecipeRow(flow, m, 'inputs', 0, -1), '首行无法再上移（返回 false）');
})();

section('回归 D2：删除配方行只删除该行端口上的连线，其余索引正确前移');
(function () {
  var flow = M.createFlow('删行');
  var A = M.makeItem({ name: 'A' }), B = M.makeItem({ name: 'B' }), C = M.makeItem({ name: 'C' });
  var out = M.makeItem({ name: '产物' });
  flow.items.push(A, B, C, out);
  var sA = M.makeDiamond('source', { name: '源A', itemId: A.id, count: 1, ticks: 20 });
  var sB = M.makeDiamond('source', { name: '源B', itemId: B.id, count: 1, ticks: 20 });
  var sC = M.makeDiamond('source', { name: '源C', itemId: C.id, count: 1, ticks: 20 });
  var m = M.makeMachine({
    name: 'M', power: 10, ticks: 20,
    inputs: [M.makeRecipeLine(A.id, 1), M.makeRecipeLine(B.id, 1), M.makeRecipeLine(C.id, 1)],
    outputs: [M.makeRecipeLine(out.id, 1)]
  });
  flow.nodes.push(sA, sB, sC, m);
  var LA = mkLink(sA, 0, m, 0), LB = mkLink(sB, 0, m, 1), LC = mkLink(sC, 0, m, 2);
  flow.links.push(LA, LB, LC);
  eq(G.analyze(flow).counts.error, 0, '三条输入都匹配');
  var res = M.removeRecipeRow(flow, m, 'inputs', 0);
  eq(res.dropped.length, 1, '只丢弃 1 条连线（第 1 行端口上的那条）');
  eq(flow.links.length, 2, '另外两条连线保留');
  eq(flow.links.indexOf(LA), -1, '被丢弃的正是 A 的连线');
  eq(LB.to.index, 0, '原第 2 行的连线前移到第 1 个端口');
  eq(LC.to.index, 1, '原第 3 行的连线前移到第 2 个端口');
  eq(flow.nodes[3].recipe.inputs.length, 2, '配方剩 2 行');
  eq(G.analyze(flow).counts.error, 0, '删除后剩余连线依然匹配');
  var links = M.recipeRowLinks(flow, m, 'inputs', 1);
  eq(links.length, 1, 'recipeRowLinks 能正确统计某一行端口上的连线数');
})();

section('回归 D3：供料不足的判定与模拟的均分模型完全一致');
(function () {
  // 一个源 1/s，分给 3 台各需 1/s 的机器
  function build3() {
    var flow = M.createFlow('fanout');
    var iron = M.makeItem({ name: '铁锭' });
    flow.items.push(iron);
    var src = M.makeDiamond('source', { name: '源', itemId: iron.id, count: 1, ticks: 20 }); // 1/s
    flow.nodes.push(src);
    var ms = [];
    for (var i = 0; i < 3; i++) {
      var m = M.makeMachine({ name: 'M' + i, power: 1, ticks: 20, inputs: [M.makeRecipeLine(iron.id, 1)], outputs: [] });
      flow.nodes.push(m); ms.push(m);
      flow.links.push(mkLink(src, 0, m, 0));
    }
    return { flow: flow, src: src, ms: ms };
  }
  var b = build3();
  var an = G.analyze(b.flow);
  var sim = G.simulate(b.flow, an);
  eq(an.counts.error, 3, '三台机器都供料不足 → 3 个错误（不再出现“校验通过但全部饿死”）');
  ok(b.ms.every(function (m) { return Math.abs(sim.machine[m.id].craftRate - 1 / 3) < 1e-9; }), '模拟中每台 1/3 次/s');
  ok(b.ms.every(function (m) { return Math.abs(sim.machine[m.id].efficiency - 1 / 3) < 1e-9; }), '模拟效率 33%（与错误判定一致）');
  ok(!!an.shareNote[b.flow.links[0].id], '界面可显示均分说明：' + an.shareNote[b.flow.links[0].id]);

  // 一个源 1/s，分给需求 1/s 与 3/s 的两台机器
  var flow2 = M.createFlow('fanout2');
  var iron2 = M.makeItem({ name: '铁锭' });
  flow2.items.push(iron2);
  var src2 = M.makeDiamond('source', { name: '源', itemId: iron2.id, count: 1, ticks: 20 });
  var mA = M.makeMachine({ name: 'A(需1/s)', power: 1, ticks: 20, inputs: [M.makeRecipeLine(iron2.id, 1)], outputs: [] });
  var mB = M.makeMachine({ name: 'B(需3/s)', power: 1, ticks: 20, inputs: [M.makeRecipeLine(iron2.id, 3)], outputs: [] });
  flow2.nodes.push(src2, mA, mB);
  flow2.links.push(mkLink(src2, 0, mA, 0), mkLink(src2, 0, mB, 0));
  var an2 = G.analyze(flow2);
  var sim2 = G.simulate(flow2, an2);
  eq(an2.counts.error, 2, '两台都拿不到满速 → 两条都报错（与模拟一致）');
  near(sim2.machine[mA.id].efficiency, 0.5, 'A 实际效率 50%');
  near(sim2.machine[mB.id].efficiency, 1 / 6, 'B 实际效率约 16.7%');
})();

section('回归 D4：70 台机器的长链（数组顺序与流向相反）也能收敛');
(function () {
  var flow = M.createFlow('长链');
  var ore = M.makeItem({ name: '矿物' });
  flow.items.push(ore);
  var src = M.makeDiamond('source', { name: '源', itemId: ore.id, count: 1, ticks: 200 }); // 0.1/s
  var N = 70;
  var ms = [];
  for (var i = 0; i < N; i++) {
    ms.push(M.makeMachine({ name: 'M' + i, power: 1, ticks: 20, inputs: [M.makeRecipeLine(ore.id, 1)], outputs: [M.makeRecipeLine(ore.id, 1)] }));
  }
  // 故意按与流向相反的顺序放进 nodes，最坏情况下每轮只能推进一条边
  for (var j = N - 1; j >= 0; j--) flow.nodes.push(ms[j]);
  flow.nodes.push(src);
  flow.links.push(mkLink(src, 0, ms[0], 0));
  for (var k = 0; k < N - 1; k++) flow.links.push(mkLink(ms[k], 0, ms[k + 1], 0));
  var an = G.analyze(flow);
  var sim = G.simulate(flow, an);
  var worst = 0;
  ms.forEach(function (m) { worst = Math.max(worst, Math.abs(sim.machine[m.id].craftRate - 0.1)); });
  ok(worst < 1e-6, '70 台机器全部收敛到 0.1 次/s（最大偏差 ' + worst.toExponential(2) + '）');
  eq(sim.machine[ms[N - 1].id].state, '受限运行', '链尾机器状态为“受限运行”而不是错误的“满速运行”');
  near(sim.linkRate[flow.links[flow.links.length - 1].id], 0.1, '链尾连线流量 0.1/s');
})();

section('回归 D5：导入时越界端口索引的连线被丢弃并告警（不再静默改写）');
(function () {
  var base = buildIdeal();
  var raw = JSON.parse(M.flowToText(base.flow));
  raw.links[0].to.index = 9; // 机器只有 1 个输入口
  var parsed = M.parseFlowText(JSON.stringify(raw));
  ok(parsed.ok, '文件仍可导入');
  eq(parsed.flow.links.length, 2, '越界的那条连线被丢弃（原本 3 条）');
  ok(parsed.warnings.some(function (w) { return /不存在输入口/.test(w); }), '给出“端口不存在”的修正警告：' + parsed.warnings[0]);
  var an = G.analyze(parsed.flow);
  ok(!an.issueList.some(function (i) { return /内容不匹配/.test(i.msg); }), '不会因为静默改写而伪造出“内容不匹配”');
})();

section('回归 D6：重命名预设会同步内嵌节点名，实例化后名称正确');
(function () {
  PS.clearAll();
  var s = buildIdeal();
  var p = PS.fromNode(s.flow, s.m2);
  PS.upsert(p);
  ok(PS.rename(p.id, '组装机MK2'), '重命名成功');
  eq(PS.get(p.id).name, '组装机MK2', '预设名已更新');
  eq(PS.get(p.id).machine.name, '组装机MK2', '内嵌机器名同步更新');
  var f2 = M.createFlow('实例化');
  var node = PS.instantiate(f2, PS.get(p.id), 0, 0);
  eq(node.name, '组装机MK2', '实例化出来的节点使用新名称');
  eq(PS.get(p.id).machine.power, s.m2.power, '参数不受重命名影响');
})();

section('回归 D7：清空一侧配方会连带有该侧连线一起清理');
(function () {
  var s = buildIdeal();
  var removed = M.clearRecipeSide(s.flow, s.m1, 'inputs');
  eq(removed, 1, '清理掉 1 条输入连线');
  eq(s.flow.links.length, 2, '其余连线保留');
  eq(s.m1.recipe.inputs.length, 0, '输入配方已清空');
  var an = G.analyze(s.flow);
  ok(!an.issueList.some(function (i) { return /已不存在/.test(i.msg); }), '不会留下指向失效端口的悬空连线');
})();

section('健壮性：随机图（含缓存器与环路）不产生 NaN，缓存器进出恒等且结果可复现');
(function () {
  var seed = 20240607;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
  var bad = [];
  var GRAPHS = 200;
  for (var iter = 0; iter < GRAPHS; iter++) {
    var flow = M.createFlow('fuzz' + iter);
    var items = [];
    for (var ii = 0; ii < 3; ii++) { var it = M.makeItem({ name: 'I' + ii }); items.push(it); flow.items.push(it); }
    var nNodes = 2 + Math.floor(rnd() * 5);
    for (var n = 0; n < nNodes; n++) {
      var r = rnd();
      if (r < 0.22) {
        flow.nodes.push(M.makeDiamond('source', {
          name: 'S' + n, itemId: pick(items).id, count: 1 + Math.floor(rnd() * 3), ticks: 5 + Math.floor(rnd() * 80)
        }));
      } else if (r < 0.42) {
        var bIn = 1 + Math.floor(rnd() * 2), bLines = [];
        for (var bb = 0; bb < bIn; bb++) bLines.push(M.makeRecipeLine(pick(items).id, 1 + Math.floor(rnd() * 4)));
        flow.nodes.push(M.makeBuffer({ name: 'B' + n, inputs: bLines }));
      } else {
        var ins = [], outs = [];
        for (var a = 0; a < 1 + Math.floor(rnd() * 2); a++) ins.push(M.makeRecipeLine(pick(items).id, 1 + Math.floor(rnd() * 4)));
        for (var c = 0; c < 1 + Math.floor(rnd() * 2); c++) outs.push(M.makeRecipeLine(pick(items).id, 1 + Math.floor(rnd() * 4)));
        flow.nodes.push(M.makeMachine({
          name: 'M' + n, power: Math.floor(rnd() * 120), ticks: 5 + Math.floor(rnd() * 120), inputs: ins, outputs: outs
        }));
      }
    }
    var attempts = Math.floor(rnd() * 9);
    for (var k = 0; k < attempts; k++) {
      var froms = flow.nodes.filter(function (x) { return M.nodePorts(x).outputs.length; });
      var tos = flow.nodes.filter(function (x) { return M.nodePorts(x).inputs.length; });
      if (!froms.length || !tos.length) break;
      var f = pick(froms), t = pick(tos);
      if (f.id === t.id) continue;
      var fi = Math.floor(rnd() * M.nodePorts(f).outputs.length);
      var ti = Math.floor(rnd() * M.nodePorts(t).inputs.length);
      var dup = flow.links.some(function (l) {
        return l.from.nodeId === f.id && (l.from.index | 0) === fi && l.to.nodeId === t.id && (l.to.index | 0) === ti;
      });
      if (dup) continue;
      flow.links.push({ id: M.uid('lnk'), from: { nodeId: f.id, side: 'out', index: fi }, to: { nodeId: t.id, side: 'in', index: ti }, note: '' });
    }

    var an, sim;
    try {
      an = G.analyze(flow);
      sim = G.simulate(flow, an);
    } catch (e) {
      bad.push('图' + iter + ' 抛出异常：' + e.message);
      continue;
    }
    Object.keys(sim.linkRate).forEach(function (id) {
      var v = sim.linkRate[id];
      if (!isFinite(v) || v < 0) bad.push('图' + iter + ' 连线速率异常：' + v);
    });
    Object.keys(sim.machine).forEach(function (id) {
      var m = sim.machine[id];
      if (!isFinite(m.craftRate) || m.craftRate < 0) bad.push('图' + iter + ' 机器速率异常：' + m.craftRate);
      if (m.craftRate > m.maxCraftRate + 1e-9) bad.push('图' + iter + ' 机器超出产能上限');
      if (!isFinite(m.efficiency)) bad.push('图' + iter + ' 效率非有限数');
    });
    Object.keys(sim.buffer).forEach(function (id) {
      var b = sim.buffer[id];
      if (!isFinite(b.totalIn) || !isFinite(b.totalOut) || !isFinite(b.totalRelay)) bad.push('图' + iter + ' 缓存器速率非有限数');
      // 核心不变量：中转过量 = 输入量（进 = 出）；每条通道同样成立
      if (Math.abs(b.totalIn - b.totalRelay) > 1e-6) bad.push('图' + iter + ' 缓存器总中转 != 总输入：' + b.totalIn + ' vs ' + b.totalRelay);
      // 输出口都接上时，总输入必须严格等于总输出（不允许出现 79.38 vs 78.75 这种不一致）
      if (b.unconnectedOuts === 0 && Math.abs(b.totalIn - b.totalOut) > 1e-6) {
        bad.push('图' + iter + ' 缓存器总输入 != 总输出（输出口均已连接）：' + b.totalIn + ' vs ' + b.totalOut);
      }
      // 不允许凭空产生物料：缓存器吞吐不能超过它收到的物料
      b.ports.forEach(function (p) {
        if (Math.abs(p.inRate - p.relay) > 1e-6) bad.push('图' + iter + ' 缓存器通道中转 != 输入');
        if (p.connected && Math.abs(p.outRate - p.relay) > 1e-6) bad.push('图' + iter + ' 已连接的缓存器输出口实际输出 != 中转量');
        if (!p.connected && p.outRate > 1e-9) bad.push('图' + iter + ' 未连接的缓存器输出口却有流量');
        if (p.relay < -1e-9) bad.push('图' + iter + ' 缓存器中转量为负');
      });
    });
    // 模拟必须收敛（堵塞环按 0 处理，收敛环增益 ≤ 1/2）
    if (sim.converged === false) bad.push('图' + iter + ' 模拟未收敛');
    // 连线流量不能超过任何上游输出口的理论上限（不凭空产生物料）
    Object.keys(sim.linkRate).forEach(function (id) {
      var link = flow.links.filter(function (l) { return l.id === id; })[0];
      if (!link) return;
      var okey = M.outPortKey(link.from.nodeId, link.from.index);
      var cap = (an.outCaps && an.outCaps[okey]) || 0;
      var fan = flow.links.filter(function (l) { return l.from.nodeId === link.from.nodeId && (l.from.index | 0) === (link.from.index | 0); }).length || 1;
      // 有消耗的缓存器环允许超过“无环上限”（环内循环料），所以只对机器/输入端输出口设限
      var from = M.findNode(flow, link.from.nodeId);
      if (from && from.kind !== 'buffer' && sim.linkRate[id] > cap / fan + 1e-6) {
        bad.push('图' + iter + ' 连线流量超过上游理论上限：' + sim.linkRate[id] + ' > ' + (cap / fan));
      }
    });
    var again = G.simulate(flow, G.analyze(flow));
    if (JSON.stringify(again.linkRate) !== JSON.stringify(sim.linkRate)) bad.push('图' + iter + ' 两次模拟结果不一致');
  }
  ok(bad.length === 0, GRAPHS + ' 张随机图（含缓存器与环路）全部通过：无 NaN / 无负值 / 缓存器进出恒等 / 结果可复现' +
    (bad.length ? '；问题：' + bad.slice(0, 3).join('；') : ''));
})();

/* ============================================================== 示例文件 */

section('示例文件：都能导入、无需修正、数据自洽');
(function () {
  var fs = require('fs');
  var path = require('path');
  var dir = path.join(__dirname, '..', 'samples');
  if (!fs.existsSync(dir)) { ok(false, 'samples/ 目录存在'); return; }
  var files = fs.readdirSync(dir);
  var flowFiles = files.filter(function (f) { return /\.gtline\.json$/.test(f); });
  var presetFiles = files.filter(function (f) { return /\.gtpresets\.json$/.test(f); });
  ok(flowFiles.length >= 3, '存在 ' + flowFiles.length + ' 个示例流程文件（含缓存器闭环示例）');
  ok(presetFiles.length >= 1, '存在 ' + presetFiles.length + ' 个示例预设文件');

  flowFiles.forEach(function (f) {
    var parsed = M.parseFlowText(fs.readFileSync(path.join(dir, f), 'utf8'));
    ok(parsed.ok, '示例可解析：' + f);
    if (!parsed.ok) return;
    eq(parsed.warnings.length, 0, '示例无需修正警告：' + f);
    var an = G.analyze(parsed.flow);
    var sim = G.simulate(parsed.flow, an);
    ok(isFinite(sim.totals.itemPerSec), '示例模拟结果有限：' + f + '（' + M.fmtNum(sim.totals.itemPerSec) + '/s）');
    var seen = {};
    var dup = parsed.flow.nodes.concat(parsed.flow.links, parsed.flow.items).filter(function (x) {
      if (seen[x.id]) return true;
      seen[x.id] = true;
      return false;
    });
    eq(dup.length, 0, '示例中所有 id 唯一：' + f);
    var portOk = parsed.flow.links.every(function (l) {
      var fn = M.findNode(parsed.flow, l.from.nodeId);
      var tn = M.findNode(parsed.flow, l.to.nodeId);
      return fn && tn && (l.from.index | 0) < M.nodePorts(fn).outputs.length && (l.to.index | 0) < M.nodePorts(tn).inputs.length;
    });
    ok(portOk, '示例中所有连线的端口都存在：' + f);
    ok(parsed.flow.nodes.every(function (n) { return isFinite(n.x) && isFinite(n.y); }), '示例节点坐标有效：' + f);
    assertNoOverlap(parsed.flow, '示例节点互不重叠（示例本身已用自动排版生成）：' + f);
    // 示例本身应当是“按步数排版”的结果：每条连线都不逆着步数方向（回环边除外）
    var info = G.computeLayers(parsed.flow);
    var backward = parsed.flow.links.filter(function (l) {
      var fn = M.findNode(parsed.flow, l.from.nodeId), tn = M.findNode(parsed.flow, l.to.nodeId);
      return fn && tn && info.stepOf[tn.id] < info.stepOf[fn.id];
    });
    var an0 = G.analyze(parsed.flow);
    ok(backward.length === 0 || an0.cycles.length > 0, '示例的连线方向与步数一致（含环路的示例除外）：' + f);
    // 含缓存器的示例：总输入速率必须等于总输出速率
    var bufIds = parsed.flow.nodes.filter(function (n) { return n.kind === 'buffer'; }).map(function (n) { return n.id; });
    if (bufIds.length) {
      var sim0 = G.simulate(parsed.flow, an0);
      bufIds.forEach(function (id) {
        var b = sim0.buffer[id];
        ok(b && Math.abs(b.totalIn - b.totalOut) < 1e-9,
          '示例中的缓存器进出速率恒等（' + M.fmtNum(b ? b.totalIn : 0) + ' = ' + M.fmtNum(b ? b.totalOut : 0) + '/s）：' + f);
      });
    }
    var reflow = JSON.parse(M.flowToText(parsed.flow));
    G.autoLayout(reflow, { snap: true });
    assertNoOverlap(reflow, '对示例重新自动排版同样不产生重叠：' + f);
  });

  var green = null;
  flowFiles.forEach(function (f) {
    var parsed = M.parseFlowText(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!parsed.ok) return;
    var an = G.analyze(parsed.flow);
    if (an.counts.error === 0 && an.counts.warn === 0) green = f;
    ok(true, '示例“' + f + '”：错误 ' + an.counts.error + ' / 警告 ' + an.counts.warn);
  });
  ok(!!green, '至少有一个完全配平、零错误零警告的示例：' + green);

  presetFiles.forEach(function (f) {
    var raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    var lib = PS.normalizeLibrary(raw);
    ok(lib.presets.length > 0, '示例预设文件可解析（' + lib.presets.length + ' 个预设）：' + f);
    ok(lib.presets.every(function (p) { return p.type && p.name; }), '示例预设字段完整：' + f);
    var types = {};
    lib.presets.forEach(function (p) { types[p.type] = (types[p.type] || 0) + 1; });
    ok(types.machine >= 1 && types.item >= 1, '示例预设包含机器与物品预设：' + JSON.stringify(types));
    // 抽查：机器预设可以在空流程里实例化
    var mp = lib.presets.filter(function (p) { return p.type === 'machine'; })[0];
    var target = M.createFlow('预设导入测试');
    var node = PS.instantiate(target, mp, 0, 0);
    ok(!!node && node.recipe.outputs.length === mp.machine.outputs.length, '机器预设可实例化且输出条数一致：' + mp.name);
  });
})();

/* ============================================================== 结果 */

console.log('\n---------------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败列表：');
  failures.forEach(function (f) { console.log(' - ' + f); });
  process.exit(1);
}
console.log('全部逻辑测试通过。');
