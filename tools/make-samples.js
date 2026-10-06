/* ============================================================================
 * GT 产线模拟器 — 生成 samples/ 目录下的示例文件
 *   node tools/make-samples.js
 * 用真实的数据模型 API 构造示例，保证导出的 JSON 一定合法。
 * ==========================================================================*/
'use strict';

var fs = require('fs');
var path = require('path');

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

var ROOT = path.join(__dirname, '..');
var OUT = path.join(ROOT, 'samples');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function link(from, fi, to, ti) {
  return { id: M.uid('lnk'), from: { nodeId: from.id, side: 'out', index: fi }, to: { nodeId: to.id, side: 'in', index: ti }, note: '' };
}

/* ======================================================= 示例一：正常产线 */

function buildGreen() {
  var flow = M.createFlow('示例产线 · 铁矿 → 电路板');
  flow.meta.note = '导入后可直接运行模拟：这是一条速率完全配平的示例产线（0 错误 0 警告）。';
  flow.items.push(
    M.makeItem({ name: '铁矿石', state: 'solid', note: '矿物' }),
    M.makeItem({ name: '铁锭', state: 'solid', note: '锭' }),
    M.makeItem({ name: '铁板', state: 'solid', note: '板材' }),
    M.makeItem({ name: '电路板', state: 'solid', note: '成品' }),
    M.makeItem({ name: '蒸馏水', state: 'fluid', note: 'mB' }),
    M.makeItem({ name: '蒸汽', state: 'fluid', note: 'mB' })
  );
  var iron, ingot, plate, circuit, water, steam;
  iron = flow.items[0]; ingot = flow.items[1]; plate = flow.items[2];
  circuit = flow.items[3]; water = flow.items[4]; steam = flow.items[5];

  var srcOre = M.makeDiamond('source', { name: '铁矿石供料', x: -960, y: 0, itemId: iron.id, count: 2, ticks: 40 });
  var blast = M.makeMachine({
    name: '工业高炉', x: -600, y: 0, power: 32, ticks: 40,
    inputs: [M.makeRecipeLine(iron.id, 2)], outputs: [M.makeRecipeLine(ingot.id, 2)],
    note: '2 铁矿石 / 40t → 2 铁锭'
  });
  var press = M.makeMachine({
    name: '压板机', x: -220, y: 0, power: 30, ticks: 20,
    inputs: [M.makeRecipeLine(ingot.id, 1)], outputs: [M.makeRecipeLine(plate.id, 1)]
  });
  var assembler = M.makeMachine({
    name: '电路组装机', x: 200, y: 0, power: 64, ticks: 60,
    inputs: [M.makeRecipeLine(plate.id, 3)], outputs: [M.makeRecipeLine(circuit.id, 1)]
  });
  var sinkOut = M.makeDiamond('sink', { name: '成品出料', x: 620, y: 0, filterItemId: circuit.id });

  var srcWater = M.makeDiamond('source', { name: '蒸馏水供应', x: -960, y: 420, itemId: water.id, count: 500, ticks: 20 });
  var boiler = M.makeMachine({
    name: '蒸汽锅炉', x: -600, y: 420, power: 8, ticks: 20,
    inputs: [M.makeRecipeLine(water.id, 500)], outputs: [M.makeRecipeLine(steam.id, 500)]
  });
  var sinkSteam = M.makeDiamond('sink', { name: '蒸汽输出', x: -180, y: 420 });

  flow.nodes.push(srcOre, blast, press, assembler, sinkOut, srcWater, boiler, sinkSteam);
  flow.links.push(
    link(srcOre, 0, blast, 0),
    link(blast, 0, press, 0),
    link(press, 0, assembler, 0),
    link(assembler, 0, sinkOut, 0),
    link(srcWater, 0, boiler, 0),
    link(boiler, 0, sinkSteam, 0)
  );
  flow.view = { x: -170, y: 210, zoom: 0.72 };
  return flow;
}

/* =================================================== 示例二：报错演示产线 */

function buildBroken() {
  var flow = M.createFlow('示例产线 · 报错演示（请对照红色连线）');
  flow.meta.note = '故意包含三类问题：① 内容不匹配 ② 供料不足 ③ 物料环路 ④ 未填写配方。可用来验证报错规则。';
  var ingot = M.makeItem({ name: '铁锭', state: 'solid' });
  var copper = M.makeItem({ name: '铜锭', state: 'solid' });
  var plate = M.makeItem({ name: '铁板', state: 'solid' });
  flow.items.push(ingot, copper, plate);

  var srcIron = M.makeDiamond('source', { name: '铁锭源', x: -880, y: -120, itemId: ingot.id, count: 1, ticks: 40 });   // 0.5/s，不足
  var srcCopper = M.makeDiamond('source', { name: '铜锭源（故意接错）', x: -880, y: 120, itemId: copper.id, count: 1, ticks: 20 });
  var press = M.makeMachine({
    name: '压板机（需要铁锭）', x: -420, y: 0, power: 30, ticks: 20,
    inputs: [M.makeRecipeLine(ingot.id, 1)], outputs: [M.makeRecipeLine(plate.id, 1)]
  });
  var back = M.makeMachine({
    name: '回流机（构成环路 + 供料不足）', x: 60, y: 0, power: 5, ticks: 20,
    inputs: [M.makeRecipeLine(plate.id, 2)], outputs: [M.makeRecipeLine(plate.id, 1)],
    note: '输入需要 2 铁板/次，上游只能给 1/s'
  });
  var empty = M.makeMachine({
    name: '未填写配方的机器', x: 60, y: 400, power: 0, ticks: 20,
    inputs: [M.makeRecipeLine('', 1)], outputs: [M.makeRecipeLine('', 1)]
  });

  flow.nodes.push(srcIron, srcCopper, press, back, empty);
  flow.links.push(link(srcIron, 0, press, 0));   // 数量不足
  flow.links.push(link(srcCopper, 0, press, 0)); // 内容不匹配
  flow.links.push(link(press, 0, back, 0));
  flow.links.push(link(back, 0, press, 0));      // 与上一条构成环路，且内容与配方不符
  flow.view = { x: -330, y: 120, zoom: 0.78 };
  return flow;
}

/* ================================================ 示例三：缓存器闭环产线 */

function buildBufferLoop() {
  var flow = M.createFlow('示例产线 · 缓存器闭环（循环连接的正确做法）');
  flow.meta.note = '演示缓存器：用缓存器把“熔炼机 → 压制机 → 熔炼机”的循环连起来。' +
    '缓存器只能配置输入，输出强制与输入相同，且每条通道总输入速率 = 总输出速率。' +
    '如果没有缓存器，这两台机器直接成环会报错并提示接入缓存器。';
  var ingot = M.makeItem({ name: '铁锭', state: 'solid' });
  var dust = M.makeItem({ name: '铁粉', state: 'solid' });
  flow.items.push(ingot, dust);

  var src = M.makeDiamond('source', { name: '铁锭补充', x: 0, y: 0, itemId: ingot.id, count: 1, ticks: 20 }); // 1/s
  var smelt = M.makeMachine({
    name: '熔炼机', x: 0, y: 0, power: 32, ticks: 20,
    inputs: [M.makeRecipeLine(ingot.id, 2)],   // 需要 2/s：外部 1/s + 循环回来 1/s
    outputs: [M.makeRecipeLine(dust.id, 4)],   // 产出 4/s
    note: '2 铁锭/次 → 4 铁粉/次'
  });
  var buf = M.makeBuffer({
    name: '缓存器（打破闭环）', x: 0, y: 0,
    inputs: [M.makeRecipeLine(dust.id, 4)]
  });
  var press = M.makeMachine({
    name: '压制机', x: 0, y: 0, power: 32, ticks: 20,
    inputs: [M.makeRecipeLine(dust.id, 4)],    // 消耗 4/s
    outputs: [M.makeRecipeLine(ingot.id, 2)]   // 产出 2/s：1/s 出料 + 1/s 回流
  });
  var sink = M.makeDiamond('sink', { name: '成品出料', x: 0, y: 0, filterItemId: ingot.id });

  flow.nodes.push(src, smelt, buf, press, sink);
  flow.links.push(
    link(src, 0, smelt, 0),
    link(smelt, 0, buf, 0),
    link(buf, 0, press, 0),
    link(press, 0, sink, 0),
    link(press, 0, smelt, 0)   // 循环连接（经过缓存器）
  );
  return flow;
}

/* ============================================================ 预设文件 */

function buildPresets(green) {
  var byName = {};
  green.nodes.forEach(function (n) { byName[n.name] = n; });
  green.items.forEach(function (it) {
    PS.upsert(PS.fromItem(green, it));
  });
  ['工业高炉', '压板机', '电路组装机', '蒸汽锅炉'].forEach(function (n) {
    PS.upsert(PS.fromNode(green, byName[n]));
  });
  PS.upsert(PS.fromNode(green, green.nodes.filter(function (n) { return n.name === '铁矿石供料'; })[0]));
  PS.upsert(PS.fromNode(green, green.nodes.filter(function (n) { return n.name === '成品出料'; })[0]));
  return PS.exportObject();
}

/* ================================================================ 输出 */

function writeJson(file, obj) {
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(obj, null, 2), 'utf8');
  return fs.statSync(path.join(OUT, file)).size;
}

var green = buildGreen();
// 用自动排版生成示例的初始布局（按“距输入端的最短步数”分列），保证示例本身就是排版好的
var layout1 = G.autoLayout(green, { snap: true, rowGap: 72, columnGap: 165 });
green.view = { x: 0, y: 0, zoom: 0.78 };
var anGreen = G.analyze(green);
var simGreen = G.simulate(green, anGreen);
var broken = buildBroken();
G.autoLayout(broken, { snap: true, rowGap: 72, columnGap: 165 });
broken.view = { x: 0, y: 0, zoom: 0.78 };
var anBroken = G.analyze(broken);
var brokenSim = G.simulate(broken, anBroken);

var bufLoop = buildBufferLoop();
G.autoLayout(bufLoop, { snap: true, rowGap: 72, columnGap: 175 });
bufLoop.view = { x: 0, y: 0, zoom: 0.72 };
var anBufLoop = G.analyze(bufLoop);
var bufLoopSim = G.simulate(bufLoop, anBufLoop);

var s1 = writeJson('示例产线-铁矿到电路板.gtline.json', JSON.parse(M.flowToText(green)));
var s2 = writeJson('示例产线-报错演示.gtline.json', JSON.parse(M.flowToText(broken)));
var s4 = writeJson('示例产线-缓存器闭环.gtline.json', JSON.parse(M.flowToText(bufLoop)));
var s3 = writeJson('示例预设库.gtpresets.json', buildPresets(green));

function report(name, flow, an, sim) {
  console.log('\n--- ' + name + ' ---');
  console.log('节点 ' + flow.nodes.length + ' / 连线 ' + flow.links.length + ' / 物品 ' + flow.items.length);
  console.log('理论最大耗电量 ' + an.stats.power + ' EU/t，理论最大耗时 ' + an.stats.ticks + ' t (' + (an.stats.ticks / 20) + ' s)');
  console.log('错误 ' + an.counts.error + ' / 警告 ' + an.counts.warn + ' / 提示 ' + (an.counts.info || 0));
  console.log('模拟总产出 ' + M.fmtNum(sim.totals.itemPerSec) + ' /s');
  an.issueList.slice(0, 8).forEach(function (i) { console.log('   [' + i.level + '] ' + i.msg); });
}

function checkLayout(name, flow) {
  var nodes = flow.nodes, bad = [];
  for (var i = 0; i < nodes.length; i++) {
    for (var j = i + 1; j < nodes.length; j++) {
      var A = M.nodeBounds(nodes[i]), B = M.nodeBounds(nodes[j]);
      if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) {
        bad.push(nodes[i].name + '×' + nodes[j].name);
      }
    }
  }
  var info = G.computeLayers(flow);
  var order = true;
  flow.links.forEach(function (l) {
    var fn = M.findNode(flow, l.from.nodeId), tn = M.findNode(flow, l.to.nodeId);
    if (fn && tn && info.stepOf[tn.id] < info.stepOf[fn.id]) order = false;
  });
  console.log('\n排版检查 ' + name + '：列数 ' + (info.maxStep + 1) + '，重叠 ' + bad.length +
    '，连线方向全部向右 ' + (order ? '是' : '否（存在回环边，属预期）'));
  return bad.length === 0;
}

report('示例一（应为 0 错误 0 警告）', green, anGreen, simGreen);
report('示例二（故意报错）', broken, anBroken, brokenSim);
report('示例三（缓存器闭环，应为 0 错误 0 警告）', bufLoop, anBufLoop, bufLoopSim);

var layoutOk = checkLayout('示例一', green) && checkLayout('示例二', broken) && checkLayout('示例三', bufLoop);

// 缓存器：总输入速率必须等于总输出速率
var bufOk = true;
Object.keys(bufLoopSim.buffer).forEach(function (id) {
  var b = bufLoopSim.buffer[id];
  if (Math.abs(b.totalIn - b.totalOut) > 1e-9) bufOk = false;
  console.log('缓存器“' + (M.findNode(bufLoop, id) || {}).name + '”：总进 ' + M.fmtNum(b.totalIn) + '/s = 总出 ' + M.fmtNum(b.totalOut) + '/s');
});
console.log('缓存器进出恒等：' + (bufOk ? '通过' : '失败') + '；经缓存器闭合的环路 ' + anBufLoop.bufferLoops.length + ' 个');

console.log('\n已写入 samples/：');
console.log('  ' + (s1 / 1024).toFixed(1) + ' KB  示例产线-铁矿到电路板.gtline.json');
console.log('  ' + (s2 / 1024).toFixed(1) + ' KB  示例产线-报错演示.gtline.json');
console.log('  ' + (s4 / 1024).toFixed(1) + ' KB  示例产线-缓存器闭环.gtline.json');
console.log('  ' + (s3 / 1024).toFixed(1) + ' KB  示例预设库.gtpresets.json');

if (anGreen.counts.error !== 0 || anGreen.counts.warn !== 0) {
  console.error('\n警告：示例一不是“干净”的示例（存在错误/警告），请检查。');
  process.exit(1);
}
if (anBufLoop.counts.error !== 0 || anBufLoop.counts.warn !== 0) {
  console.error('\n警告：缓存器闭环示例不是“干净”的示例，请检查。');
  anBufLoop.issueList.forEach(function (i) { console.error('   [' + i.level + '] ' + i.msg); });
  process.exit(1);
}
if (!bufOk) {
  console.error('\n警告：缓存器进出速率不等，请检查模拟逻辑。');
  process.exit(1);
}
if (!anBufLoop.bufferLoops.length) {
  console.error('\n警告：没有识别出“经缓存器闭合的环路”。');
  process.exit(1);
}
if (anBroken.counts.error < 3) {
  console.error('\n警告：示例二没有覆盖到预期的错误类型。');
  process.exit(1);
}
if (!layoutOk) {
  console.error('\n警告：示例排版检查未通过（存在重叠），请检查自动排版算法。');
  process.exit(1);
}
console.log('\n示例生成完成且一致性校验通过。');
