/* ============================================================================
 * GT 产线模拟器 — 静态一致性检查
 *   node tests/static-check.js
 * 检查：JS 里引用的 DOM id 是否都存在于 index.html；资源文件是否存在；
 *       脚本加载顺序是否正确；导出面（public API）是否完整。
 * ==========================================================================*/
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

var pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  \u2713 ' + msg); }
  else { fail++; console.log('  \u2717 ' + msg); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* 1. index.html 中声明的 id */
var htmlIds = {};
(html.match(/id="([A-Za-z0-9_\-]+)"/g) || []).forEach(function (s) {
  htmlIds[s.slice(4, -1)] = true;
});
ok(Object.keys(htmlIds).length > 15, 'index.html 中共声明 ' + Object.keys(htmlIds).length + ' 个 id');

/* 2. 脚本中引用的 id */
var jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter(function (f) { return /\.js$/.test(f); });
var referenced = {};
jsFiles.forEach(function (f) {
  var src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  var re = /(?:\$\(|getElementById\()\s*'([A-Za-z0-9_\-]+)'\s*\)/g;
  var m;
  while ((m = re.exec(src))) {
    referenced[m[1]] = referenced[m[1]] || [];
    referenced[m[1]].push(f);
  }
});
section('DOM id 交叉引用');
var missing = Object.keys(referenced).filter(function (id) { return !htmlIds[id]; });
ok(missing.length === 0, '所有被 JS 引用的 id 都存在于 index.html' + (missing.length ? '：缺失 ' + missing.join(', ') : ''));
ok(Object.keys(referenced).length >= 20, 'JS 引用了 ' + Object.keys(referenced).length + ' 个 DOM 元素');

/* 3. 资源文件存在性 */
section('资源与加载顺序');
var scripts = (html.match(/<script src="([^"]+)"/g) || []).map(function (s) { return s.replace(/<script src="|"/g, ''); });
scripts.forEach(function (s) { ok(fs.existsSync(path.join(ROOT, s)), '脚本存在：' + s); });
var css = (html.match(/<link[^>]+href="([^"]+)"/g) || []).map(function (s) { return s.replace(/.*href="|"/g, ''); });
css.forEach(function (c) { ok(fs.existsSync(path.join(ROOT, c)), '样式存在：' + c); });

var expectOrder = ['js/model.js', 'js/graph.js', 'js/presets.js', 'js/store.js', 'js/canvas.js', 'js/ui.js', 'js/main.js'];
ok(scripts.join(',') === expectOrder.join(','), '脚本加载顺序正确：model → graph → presets → store → canvas → ui → main');

// 每个脚本都要声明 charset，避免中文在 file:// 下乱码
var noCharset = (html.match(/<script src="[^"]+"(?![^>]*charset)/g) || []);
ok(noCharset.length === 0, '所有 script 标签都声明了 charset' + (noCharset.length ? '：' + noCharset.join(' ') : ''));
ok(/<meta charset="utf-8">/i.test(html), 'index.html 声明 UTF-8');

/* 4. 各模块的全局挂载与导出面 */
section('模块加载方式与导出面');
var requirements = [
  { file: 'js/model.js', global: 'root.GT.model', exports: ['createFlow', 'normalizeFlow', 'parseFlowText', 'flowToText', 'nodePorts', 'portWorld', 'machineSize', 'makeMachine', 'makeDiamond', 'makeItem', 'ensureItem', 'ratePerSecond', 'fmtRate', 'fmtTicks'] },
  { file: 'js/graph.js', global: 'root.GT.graph', exports: ['analyze', 'simulate', 'emptyAnalysis', 'tarjanSCC'] },
  { file: 'js/presets.js', global: 'root.GT.presets', exports: ['load', 'save', 'list', 'upsert', 'remove', 'fromNode', 'fromItem', 'instantiate', 'applyToNode', 'exportObject', 'importObject', 'exportFile', 'importText', 'clearAll'] },
  { file: 'js/store.js', global: 'root.GT.store', exports: ['init', 'mutate', 'undo', 'redo', 'addLink', 'deleteSelection', 'saveFlowAs', 'openFlow', 'exportFlow', 'importFlowText', 'exportBackup', 'importBackup', 'readFile', 'beginDrag', 'commitDrag', 'scheduleAutosave'] },
  { file: 'js/canvas.js', global: 'root.GT.canvas', exports: ['init', 'render', 'invalidate', 'worldToScreen', 'screenToWorld', 'fitToContent', 'findFreeSpot', 'setPlaying', 'hitNode', 'hitPort'] },
  { file: 'js/ui.js', global: 'root.GT.ui', exports: ['init', 'renderAll', 'toast', 'openModal', 'showContextMenu', 'newNode', 'addPresetInstance', 'pickFile'] }
];
requirements.forEach(function (r) {
  var src = fs.readFileSync(path.join(ROOT, r.file), 'utf8');
  ok(src.indexOf(r.global) >= 0, r.file + ' 挂载到 ' + r.global);
  var missingExp = r.exports.filter(function (name) {
    return !(new RegExp('(^|[,\\s{])' + name + '\\s*:', 'm').test(src) || new RegExp('api\\.' + name + '\\s*=').test(src));
  });
  ok(missingExp.length === 0, r.file + ' 导出面完整（' + r.exports.length + ' 项）' + (missingExp.length ? '：缺少 ' + missingExp.join(', ') : ''));
});

/* 5. 危险模式检查 */
section('代码卫生');
jsFiles.forEach(function (f) {
  var src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  var lines = src.split('\n');
  var innerRootUse = [];
  var inFactory = false;
  lines.forEach(function (line, i) {
    if (/factory\(/.test(line) && /\)\s*;?\s*$/.test(line) === false && /function \(/.test(line) === false) { /* noop */ }
    if (/^\s*function \(M[,)]/.test(line)) inFactory = true;
    if (inFactory && /\broot\.GT/.test(line)) innerRootUse.push(i + 1);
  });
  ok(innerRootUse.length === 0, f + ' 没有在 factory 内部误用 root' + (innerRootUse.length ? '（第 ' + innerRootUse.join(',') + ' 行）' : ''));
  ok(src.indexOf('console.log') < 0 || /tests?\//.test(f), f + ' 没有遗留调试输出（console.log）');
});
ok(!/debugger/.test(jsFiles.map(function (f) { return fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'); }).join('\n')), '代码中没有 debugger 语句');

/* 6. 需求要点自查（关键词存在于界面/文档） */
section('需求关键词覆盖');
var allJs = jsFiles.map(function (f) { return fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'); }).join('\n');
[
  ['理论最大耗电量', 'HUD 耗电量'],
  ['理论最大耗时', 'HUD 耗时'],
  ['固体', '物品属性 固体'],
  ['流体', '物品属性 流体'],
  ['配方', '配方编辑'],
  ['EU/t', '耗电量单位'],
  ['输入端（物料源）', '菱形输入端'],
  ['输出端（物料汇）', '菱形输出端'],
  ['一对多', '连线能力'],
  ['多对一', '连线能力'],
  ['内容不匹配', '红字报错规则'],
  ['缓存器', '白板缓存器方块'],
  ['正方形', '缓存器形状'],
  ['输出强制与输入', '缓存器输出镜像'],
  ['循环连接', '缓存器打破闭环'],
  ['自动排版', '按步数分列排版']
].forEach(function (pair) {
  ok(allJs.indexOf(pair[0]) >= 0 || html.indexOf(pair[0]) >= 0, '界面/逻辑包含「' + pair[0] + '」（' + pair[1] + '）');
});

console.log('\n---------------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
console.log('静态检查全部通过。');
