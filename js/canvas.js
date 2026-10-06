/* ============================================================================
 * GT 产线模拟器 — canvas.js
 * 纯 2D 渲染（Canvas 2D）+ 交互（平移/缩放/拖拽/连线/框选/提示）
 * ==========================================================================*/
(function (root, factory) {
  'use strict';
  var api = factory(root.GT && root.GT.model, root.GT && root.GT.graph, root.GT && root.GT.store);
  root.GT = root.GT || {};
  root.GT.canvas = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M, G, S) {
  'use strict';
  if (!M) throw new Error('canvas.js 需要先加载 model.js');
  if (!S) throw new Error('canvas.js 需要先加载 store.js');

  var CO = {
    bg: '#0b0f13',
    grid: '#141b23',
    gridMajor: '#1b2632',
    node: '#161c24',
    nodeTop: '#1e2733',
    border: '#313c4a',
    borderHover: '#4a5a6e',
    link: '#6e7f93',
    linkHot: '#9fb2c6',
    text: '#dde5ee',
    textDim: '#8b9bad',
    accent: '#f0a020',
    accent2: '#4aa3d8',
    error: '#e5484d',
    warn: '#e0a23a',
    ok: '#4fbf7b',
    sim: '#3fc9b8',
    buffer: '#8f7fe0',
    white: '#ffffff'
  };

  var FONT = '"Segoe UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif';
  var PORT_HIT = 15;
  var LINK_HIT = 9;

  var cvs = null, ctx = null, wrap = null, dpr = 1;
  var W = 0, H = 0;
  var rafId = 0, needsRender = true;
  var lastTime = 0, running = false;
  var hover = { nodeId: null, linkId: null, port: null, screen: { x: 0, y: 0 } };
  var drag = null;
  var spaceDown = false;
  var listeners = {};
  var tooltipLines = [];

  function onApi(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function fire(evt, payload) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[canvas] ' + evt, e); }
    });
  }

  function state() { return S.state; }
  function view() { return S.state.view; }
  function flow() { return S.state.flow; }
  function analysis() { return S.state.analysis; }
  function sim() { return S.state.sim; }

  /* ---------------------------------------------------------- 坐标变换 */

  function worldToScreen(p) {
    var v = view();
    return { x: (p.x - v.x) * v.zoom + W / 2, y: (p.y - v.y) * v.zoom + H / 2 };
  }
  function screenToWorld(p) {
    var v = view();
    return { x: (p.x - W / 2) / v.zoom + v.x, y: (p.y - H / 2) / v.zoom + v.y };
  }
  function worldRect() {
    var tl = screenToWorld({ x: 0, y: 0 });
    var br = screenToWorld({ x: W, y: H });
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  /* ------------------------------------------------------------ 绘图工具 */

  function pathRoundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function setFont(size, weight) {
    ctx.font = (weight ? weight + ' ' : '') + size + 'px ' + FONT;
  }

  function ellipsize(text, maxWidth) {
    text = String(text === null || text === undefined ? '' : text);
    if (maxWidth <= 6) return '';
    if (ctx.measureText(text).width <= maxWidth) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
  }

  function textHalo(text, x, y, align, color, size, weight) {
    setFont(size, weight);
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * (1 / view().zoom);
    ctx.strokeStyle = 'rgba(6,9,12,0.72)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function itemColor(itemId) {
    var it = M.findItem(flow(), itemId);
    return (it && it.color) || '#697785';
  }
  function itemName(itemId) {
    var it = M.findItem(flow(), itemId);
    if (!it) return itemId ? '(已删除物品)' : '未设置物品';
    return it.name;
  }
  function itemState(itemId) {
    var it = M.findItem(flow(), itemId);
    return it ? it.state : M.SOLID;
  }

  function drawChip(x, y, size, color, hollow) {
    var r = size * 0.28;
    ctx.beginPath();
    if (hollow) {
      pathRoundRect(x - size / 2, y - size / 2, size, size, r);
      ctx.fillStyle = 'rgba(10,14,18,0.9)';
      ctx.fill();
      ctx.lineWidth = Math.max(1.4, size * 0.22);
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      pathRoundRect(x - size / 2, y - size / 2, size, size, r);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------- 网格 */

  function drawGrid() {
    var v = view();
    var showGrid = !state().prefs || state().prefs.grid !== false;
    var step = M.GRID;
    if (showGrid) {
      while (step * v.zoom < 13) step *= 2;
      var left = v.x - W / (2 * v.zoom), right = v.x + W / (2 * v.zoom);
      var top = v.y - H / (2 * v.zoom), bottom = v.y + H / (2 * v.zoom);
      var x, y, sx, sy;
      ctx.lineWidth = 1;
      ctx.strokeStyle = CO.grid;
      ctx.beginPath();
      for (x = Math.floor(left / step) * step; x <= right; x += step) {
        sx = Math.round((x - v.x) * v.zoom + W / 2) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, H);
      }
      for (y = Math.floor(top / step) * step; y <= bottom; y += step) {
        sy = Math.round((y - v.y) * v.zoom + H / 2) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(W, sy);
      }
      ctx.stroke();

      // 每 5 格加粗
      var major = step * 5;
      ctx.strokeStyle = CO.gridMajor;
      ctx.beginPath();
      for (x = Math.floor(left / major) * major; x <= right; x += major) {
        sx = Math.round((x - v.x) * v.zoom + W / 2) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, H);
      }
      for (y = Math.floor(top / major) * major; y <= bottom; y += major) {
        sy = Math.round((y - v.y) * v.zoom + H / 2) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(W, sy);
      }
      ctx.stroke();
    }

    // 原点十字
    var o = worldToScreen({ x: 0, y: 0 });
    if (o.x > -20 && o.x < W + 20 && o.y > -20 && o.y < H + 20) {
      ctx.strokeStyle = 'rgba(240,160,32,0.22)';
      ctx.beginPath();
      ctx.moveTo(o.x - 12, o.y); ctx.lineTo(o.x + 12, o.y);
      ctx.moveTo(o.x, o.y - 12); ctx.lineTo(o.x, o.y + 12);
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------- 连线 */

  function linkGeom(link) {
    var fn = M.findNode(flow(), link.from.nodeId);
    var tn = M.findNode(flow(), link.to.nodeId);
    if (!fn || !tn) return null;
    var p0 = M.portWorld(fn, 'out', link.from.index);
    var p1 = M.portWorld(tn, 'in', link.to.index);
    var dx = Math.max(46, Math.abs(p1.x - p0.x) * 0.45);
    var c0 = { x: p0.x + dx, y: p0.y };
    var c1 = { x: p1.x - dx, y: p1.y };
    return { p0: p0, c0: c0, c1: c1, p1: p1 };
  }

  function bezierAt(g, t) {
    var mt = 1 - t;
    var a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return {
      x: a * g.p0.x + b * g.c0.x + c * g.c1.x + d * g.p1.x,
      y: a * g.p0.y + b * g.c0.y + c * g.c1.y + d * g.p1.y
    };
  }
  function bezierTangent(g, t) {
    var mt = 1 - t;
    var a = 3 * mt * mt, b = 6 * mt * t, c = 3 * t * t;
    return {
      x: a * (g.c0.x - g.p0.x) + b * (g.c1.x - g.c0.x) + c * (g.p1.x - g.c1.x),
      y: a * (g.c0.y - g.p0.y) + b * (g.c1.y - g.c0.y) + c * (g.p1.y - g.c1.y)
    };
  }

  function linkStatus(link) {
    var iss = analysis().linkIssues[link.id];
    return iss ? iss : null;
  }

  function drawLinks(px) {
    var links = flow().links;
    var v = view();
    var r = worldRect();
    var pad = 220;
    var i;
    for (i = 0; i < links.length; i++) {
      var link = links[i];
      var g = linkGeom(link);
      if (!g) continue;
      var minX = Math.min(g.p0.x, g.p1.x), maxX = Math.max(g.p0.x, g.p1.x);
      var minY = Math.min(g.p0.y, g.p1.y), maxY = Math.max(g.p0.y, g.p1.y);
      if (maxX < r.x - pad || minX > r.x + r.w + pad || maxY < r.y - pad || minY > r.y + r.h + pad) continue;

      var iss = linkStatus(link);
      var selected = state().selection.links.indexOf(link.id) >= 0;
      var isHover = hover.linkId === link.id;
      var base = CO.link;
      if (iss && iss.level === 'error') base = CO.error;
      else if (iss && iss.level === 'warn') base = CO.warn;
      else if (isHover || selected) base = CO.linkHot;

      var content = M.resolveOutPort(flow(), link.from.nodeId, link.from.index);
      var strokeColor = base;
      if (!iss && content && content.itemId) strokeColor = base;

      ctx.save();
      ctx.lineCap = 'round';

      // 外发光/描边
      ctx.beginPath();
      ctx.moveTo(g.p0.x, g.p0.y);
      ctx.bezierCurveTo(g.c0.x, g.c0.y, g.c1.x, g.c1.y, g.p1.x, g.p1.y);
      ctx.lineWidth = (selected || isHover ? 6 : 5) * px;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(g.p0.x, g.p0.y);
      ctx.bezierCurveTo(g.c0.x, g.c0.y, g.c1.x, g.c1.y, g.p1.x, g.p1.y);
      ctx.lineWidth = (selected ? 3.2 : 2.2) * px;
      ctx.strokeStyle = strokeColor;
      if (iss && iss.level === 'error') {
        ctx.setLineDash([9 * px, 5 * px]);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // 方向箭头（中段，指向输入端）
      var mid = bezierAt(g, 0.5);
      var tan = bezierTangent(g, 0.5);
      var len = Math.sqrt(tan.x * tan.x + tan.y * tan.y) || 1;
      var ux = tan.x / len, uy = tan.y / len;
      var as = 9, aw = 5.4;
      ctx.beginPath();
      ctx.moveTo(mid.x + ux * as, mid.y + uy * as);
      ctx.lineTo(mid.x - ux * as * 0.35 - uy * aw, mid.y - uy * as * 0.35 + ux * aw);
      ctx.lineTo(mid.x - ux * as * 0.35 + uy * aw, mid.y - uy * as * 0.35 - ux * aw);
      ctx.closePath();
      ctx.fillStyle = strokeColor;
      ctx.fill();

      if (selected) {
        ctx.lineWidth = 1 * px;
        ctx.strokeStyle = 'rgba(240,160,32,0.7)';
        ctx.stroke();
      }

      // 标签：显示上游输出口输出的内容
      drawLinkLabel(g, link, content, iss, px);

      // 模拟物流圆点
      if (isRunning() && content && content.itemId) {
        drawFlowDots(g, link, content, strokeColor, px);
      }
      ctx.restore();
    }
  }

  function drawLinkLabel(g, link, content, iss, px) {
    var showRate = state().prefs.showRates && isRunning();
    var label = content && content.itemId ? (itemName(content.itemId) + ' ×' + content.count) : '未设置物品';
    if (showRate && content && content.itemId) {
      var rate = (sim().linkRate[link.id] || 0);
      label += '  ' + M.fmtNum(rate) + '/s';
    }
    var t = 0.5;
    var p = bezierAt(g, t);
    var tan = bezierTangent(g, t);
    var len = Math.sqrt(tan.x * tan.x + tan.y * tan.y) || 1;
    var nx = -tan.y / len, ny = tan.x / len;

    setFont(11.5, '500');
    var tw = ctx.measureText(label).width;
    var padX = 7, h = 19, w = tw + padX * 2 + 12;
    var cx = p.x + nx * 15, cy = p.y + ny * 15;

    var boxFill = '#10161d';
    var border = 'rgba(120,140,160,0.35)';
    var textColor = CO.textDim;
    if (iss && iss.level === 'error') { boxFill = '#2a1416'; border = 'rgba(229,72,77,0.8)'; textColor = '#ffb3b5'; }
    else if (iss && iss.level === 'warn') { boxFill = '#2a2113'; border = 'rgba(224,162,58,0.75)'; textColor = '#f2cf94'; }
    else if (content && content.itemId) { textColor = CO.text; }

    ctx.globalAlpha = 0.96;
    pathRoundRect(cx - w / 2, cy - h / 2, w, h, 5);
    ctx.fillStyle = boxFill;
    ctx.fill();
    ctx.lineWidth = 1 * px + 0.6;
    ctx.strokeStyle = border;
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (content && content.itemId) {
      drawChip(cx - w / 2 + 9, cy, 9, itemColor(content.itemId), itemState(content.itemId) === M.FLUID);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    setFont(11.5, '500');
    ctx.fillStyle = textColor;
    ctx.fillText(label, cx - w / 2 + 17, cy + 0.5);

    if (iss && iss.level === 'error') {
      ctx.beginPath();
      ctx.arc(cx + w / 2 - 6, cy - h / 2 + 2, 7, 0, Math.PI * 2);
      ctx.fillStyle = CO.error;
      ctx.fill();
      ctx.fillStyle = '#fff';
      setFont(10.5, 'bold');
      ctx.textAlign = 'center';
      ctx.fillText('!', cx + w / 2 - 6, cy - h / 2 + 2.5);
      ctx.textAlign = 'left';
    }
  }

  function drawFlowDots(g, link, content, color, px) {
    var rate = sim().linkRate[link.id] || 0;
    if (rate <= 1e-6) return;
    var n = M.clamp(Math.round(rate / 2) + 1, 1, 4);
    var color2 = itemColor(content.itemId);
    for (var k = 0; k < n; k++) {
      var t = ((link.__phase || 0) + k / n) % 1;
      var p = bezierAt(g, t);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = color2;
      ctx.globalAlpha = 0.95;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1 * px;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------- 节点 */

  function drawNodes(px) {
    var nodes = flow().nodes;
    var r = worldRect();
    var pad = 160;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var b = M.nodeBounds(node);
      if (b.x > r.x + r.w + pad || b.x + b.w < r.x - pad || b.y > r.y + r.h + pad || b.y + b.h < r.y - pad) continue;
      if (node.kind === 'machine') drawMachine(node, px);
      else if (node.kind === 'buffer') drawBuffer(node, px);
      else drawDiamond(node, px);
    }
  }

  function nodeIssueLevel(nodeId) {
    var ni = analysis().nodeIssues[nodeId];
    return ni ? ni.level : null;
  }

  function issueCountsFor(nodeId) {
    var list = analysis().issueList || [];
    var err = 0, warn = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].nodeId === nodeId) {
        if (list[i].level === 'error') err++;
        else if (list[i].level === 'warn') warn++;
      }
    }
    return { err: err, warn: warn };
  }

  function drawPort(node, side, index, px) {
    var p = M.portLocal(node, side, index);
    var w = M.findNode(flow(), node.id);
    var ports = M.nodePorts(w);
    var list = side === 'in' ? ports.inputs : ports.outputs;
    var info = list[index];
    if (!info) return;
    var key = side === 'in' ? M.inPortKey(node.id, index) : M.outPortKey(node.id, index);
    var pIss = analysis().portIssues[key];
    var isHover = hover.port && hover.port.nodeId === node.id && hover.port.side === side && hover.port.index === index;
    var sz = isHover ? 15 : 13;
    var color = info.itemId ? itemColor(info.itemId) : '#5c6b7a';
    if (pIss && pIss.level === 'error') color = CO.error;
    else if (pIss && pIss.level === 'warn') color = CO.warn;

    ctx.save();
    ctx.translate(node.x + p.x, node.y + p.y);
    pathRoundRect(-sz / 2, -sz / 2, sz, sz, 2.5);
    ctx.fillStyle = side === 'in' ? 'rgba(12,17,22,0.95)' : color;
    ctx.fill();
    ctx.lineWidth = (side === 'in' ? 2.4 : 1.2) * Math.max(px, 0.8);
    ctx.strokeStyle = side === 'in' ? color : 'rgba(0,0,0,0.45)';
    ctx.stroke();
    if (pIss && pIss.level === 'error') {
      ctx.beginPath();
      ctx.arc(0, -sz * 0.85, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = CO.error;
      ctx.fill();
      ctx.fillStyle = '#fff';
      setFont(9.5, 'bold');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', 0, -sz * 0.85 + 0.5);
    }
    ctx.restore();
  }

  function portLabel(node, side, index, px) {
    if (view().zoom < 0.62) return;
    var s = M.machineSize(node);
    var p = M.portLocal(node, side, index);
    var ports = M.nodePorts(node);
    var info = (side === 'in' ? ports.inputs : ports.outputs)[index];
    if (!info) return;
    var avail = s.w / 2 - 24;
    var countText = ' ×' + info.count;
    setFont(11.5, '500');
    var cw = ctx.measureText(countText).width;
    var name = info.itemId ? itemName(info.itemId) : '未设置物品';
    name = ellipsize(name, Math.max(28, avail - cw));
    var x = side === 'in' ? node.x + p.x + 24 : node.x + p.x - 24;
    var align = side === 'in' ? 'left' : 'right';
    var color = info.itemId ? CO.text : CO.error;
    textHalo(name + countText, x, node.y + p.y, align, color, 11.5, '500');
    // 序号
    ctx.globalAlpha = 0.7;
    textHalo(String(index + 1), node.x + p.x + (side === 'in' ? 11 : -11), node.y + p.y - 11, 'center', CO.textDim, 9, '600');
    ctx.globalAlpha = 1;
  }

  function drawMachine(node, px) {
    var s = M.machineSize(node);
    var x = node.x - s.w / 2, y = node.y - s.h / 2;
    var selected = state().selection.nodes.indexOf(node.id) >= 0;
    var isHover = hover.nodeId === node.id;
    var lvl = nodeIssueLevel(node.id);
    var counts = issueCountsFor(node.id);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    pathRoundRect(x, y, s.w, s.h, 8);
    var grad = ctx.createLinearGradient(0, y, 0, y + s.h);
    grad.addColorStop(0, '#1b222c');
    grad.addColorStop(1, '#11161d');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // 标题栏
    ctx.save();
    pathRoundRect(x, y, s.w, M.MACHINE_HEADER_H, 8);
    ctx.clip();
    ctx.fillStyle = '#212b38';
    ctx.fillRect(x, y, s.w, M.MACHINE_HEADER_H);
    ctx.fillStyle = 'rgba(240,160,32,0.10)';
    ctx.fillRect(x, y, s.w, 3);
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(x, y + M.MACHINE_HEADER_H);
    ctx.lineTo(x + s.w, y + M.MACHINE_HEADER_H);
    ctx.lineWidth = 1 * Math.max(px, 0.7);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.stroke();

    // 边框
    pathRoundRect(x, y, s.w, s.h, 8);
    var border = CO.border;
    var bw = 1.3;
    if (isHover || selected) { border = selected ? CO.accent : CO.borderHover; }
    if (lvl === 'error') { border = CO.error; bw = 2; }
    else if (lvl === 'warn' && !selected) { border = CO.warn; bw = 1.7; }
    if (selected) bw = 2.2;
    ctx.lineWidth = bw * Math.max(px, 0.85);
    ctx.strokeStyle = border;
    ctx.stroke();

    // 名称
    textHalo(ellipsize(node.name || '机器', s.w - 46), x + 12, y + 20, 'left', CO.text, 14.5, '600');
    // 副标题：耗电 / 耗时
    var sub = '⚡ ' + M.fmtNum(node.power) + ' EU/t    ⏱ ' + M.fmtNum(node.ticks) + ' t (' + M.fmtNum(node.ticks / M.TICKS_PER_SECOND) + ' s)';
    textHalo(sub, x + 12, y + 40, 'left', CO.textDim, 11, '500');

    // 配方为空提示
    var nIns = node.recipe.inputs.length, nOuts = node.recipe.outputs.length;
    if (!nIns && !nOuts) {
      textHalo('白板机器：尚未设置配方', node.x, y + M.MACHINE_HEADER_H + 24, 'center', 'rgba(224,162,58,0.85)', 12, '500');
    }

    // 输入 / 输出端口及标签
    for (var i = 0; i < nIns; i++) { drawPort(node, 'in', i, px); portLabel(node, 'in', i, px); }
    for (var j = 0; j < nOuts; j++) { drawPort(node, 'out', j, px); portLabel(node, 'out', j, px); }

    // 效率条（模拟开启时）
    if (isRunning() && sim() && sim().machine[node.id]) {
      var m = sim().machine[node.id];
      var barW = s.w - 24, barY = y + s.h - 10;
      ctx.beginPath();
      ctx.rect(x + 12, barY, barW, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fill();
      var eff = M.clamp(m.efficiency, 0, 1);
      ctx.beginPath();
      ctx.rect(x + 12, barY, barW * eff, 5);
      ctx.fillStyle = eff >= 0.999 ? CO.ok : (eff > 0 ? CO.warn : CO.error);
      ctx.fill();
      textHalo(Math.round(eff * 100) + '%', x + s.w - 14, y + 14, 'right',
        eff >= 0.999 ? CO.ok : (eff > 0 ? CO.warn : CO.error), 12, '700');
    }

    // 问题角标
    if (counts.err || counts.warn) {
      var bx = x + s.w - 14, by = y + 14;
      var color = counts.err ? CO.error : CO.warn;
      ctx.beginPath();
      ctx.arc(bx, by, 9, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#fff';
      setFont(11, 'bold');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(counts.err || counts.warn), bx, by + 0.5);
    } else if (isRunning() && sim() && sim().machine[node.id] && !sim().machine[node.id].efficiency) {
      /* noop */
    }

    ctx.restore();
  }

  /**
   * 缓存器：白板正方形。左侧输入口、右侧输出口一一对应（同一行），
   * 中间画出「中转箭头」表示输出强制与输入相同；模拟运行时显示实际进出速率。
   */
  function drawBuffer(node, px) {
    var size = M.bufferSize(node);
    var x = node.x - size.w / 2, y = node.y - size.h / 2;
    var selected = state().selection.nodes.indexOf(node.id) >= 0;
    var isHover = hover.nodeId === node.id;
    var lvl = nodeIssueLevel(node.id);
    var counts = issueCountsFor(node.id);
    var ports = M.nodePorts(node);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    pathRoundRect(x, y, size.w, size.h, 7);
    var grad = ctx.createLinearGradient(x, y, x + size.w, y + size.h);
    grad.addColorStop(0, '#221f33');
    grad.addColorStop(1, '#131120');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // 标题栏
    ctx.save();
    pathRoundRect(x, y, size.w, M.BUFFER_HEADER_H, 7);
    ctx.clip();
    ctx.fillStyle = '#2a2740';
    ctx.fillRect(x, y, size.w, M.BUFFER_HEADER_H);
    ctx.fillStyle = 'rgba(143,127,224,0.35)';
    ctx.fillRect(x, y, size.w, 3);
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(x, y + M.BUFFER_HEADER_H);
    ctx.lineTo(x + size.w, y + M.BUFFER_HEADER_H);
    ctx.lineWidth = 1 * Math.max(px, 0.7);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.stroke();

    // 边框
    pathRoundRect(x, y, size.w, size.h, 7);
    var border = 'rgba(143,127,224,0.75)', bw = 1.6;
    if (lvl === 'error') { border = CO.error; bw = 2; }
    else if (lvl === 'warn') { border = CO.warn; bw = 1.8; }
    if (isHover) border = CO.borderHover;
    if (selected) { border = CO.accent; bw = 2.2; }
    ctx.lineWidth = bw * Math.max(px, 0.85);
    ctx.strokeStyle = border;
    ctx.stroke();

    // 名称
    textHalo(ellipsize(node.name || '缓存器', size.w - 40), node.x, y + 22, 'center', CO.text, 14, '600');

    // 每一条输入 → 输出中转通道
    var simInfo = sim() && sim().buffer[node.id];
    for (var i = 0; i < ports.inputs.length; i++) {
      var info = ports.inputs[i];
      var pIn = M.portLocal(node, 'in', i);
      var pOut = M.portLocal(node, 'out', i);
      var ry = node.y + pIn.y;
      var x1 = node.x + pIn.x, x2 = node.x + pOut.x;
      var color = info.itemId ? itemColor(info.itemId) : CO.error;

      // 中转箭头
      ctx.beginPath();
      ctx.moveTo(x1 + 10, ry);
      ctx.lineTo(x2 - 14, ry);
      ctx.lineWidth = 5 * px;
      ctx.strokeStyle = 'rgba(143,127,224,0.28)';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2 - 15, ry - 6);
      ctx.lineTo(x2 - 15, ry + 6);
      ctx.lineTo(x2 - 5, ry);
      ctx.closePath();
      ctx.fillStyle = 'rgba(143,127,224,0.85)';
      ctx.fill();

      // 物品标签（居中）
      var label = info.itemId ? (itemName(info.itemId) + ' ×' + info.count) : '未设置物品';
      var mid = (x1 + x2) / 2;
      setFont(11.5, '600');
      var tw = ctx.measureText(label).width;
      var boxW = Math.min(tw + 24, size.w - 30);
      pathRoundRect(mid - boxW / 2, ry - 10, boxW, 20, 5);
      ctx.fillStyle = 'rgba(12,10,20,0.92)';
      ctx.fill();
      ctx.lineWidth = 1 * px + 0.5;
      ctx.strokeStyle = info.itemId ? 'rgba(143,127,224,0.55)' : CO.error;
      ctx.stroke();
      if (info.itemId) drawChip(mid - boxW / 2 + 10, ry, 10, color, itemState(info.itemId) === M.FLUID);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      setFont(11.5, '600');
      ctx.fillStyle = info.itemId ? CO.text : CO.error;
      ctx.fillText(ellipsize(label, boxW - 24), mid - boxW / 2 + 18, ry + 0.5);

      // 端口与序号
      drawPort(node, 'in', i, px);
      drawPort(node, 'out', i, px);
      if (view().zoom >= 0.62) {
        ctx.globalAlpha = 0.7;
        textHalo(String(i + 1), x1 + 11, ry - 11, 'center', CO.textDim, 9, '600');
        textHalo(String(i + 1), x2 - 11, ry - 11, 'center', CO.textDim, 9, '600');
        ctx.globalAlpha = 1;
      }

      // 模拟：显示进出速率
      if (isRunning() && simInfo && simInfo.ports[i]) {
        var pr = simInfo.ports[i];
        textHalo(M.fmtNum(pr.inRate) + '→' + M.fmtNum(pr.outRate) + '/s', mid, ry + 16, 'center', CO.sim, 10, '600');
      }
    }

    if (!ports.inputs.length) {
      textHalo('白板缓存器：还没有配置输入', node.x, node.y + 12, 'center', 'rgba(224,162,58,0.85)', 12, '500');
      textHalo('输出会强制与输入一致', node.x, node.y + 32, 'center', CO.textDim, 11, '500');
    }

    // 进出总量（模拟时显示恒等关系）
    var isStalled = !!(analysis().stalledBuffers && analysis().stalledBuffers[node.id]);
    if (isStalled && ports.inputs.length) {
      var sbarW = size.w - 24, sbarY = y + size.h - 11;
      ctx.beginPath();
      ctx.rect(x + 12, sbarY, sbarW, 4);
      ctx.fillStyle = 'rgba(224,162,58,0.55)';
      ctx.fill();
      textHalo('堵塞：闭环内没有出料端（流量 0）', node.x, y + size.h - 20, 'center', CO.warn, 10.5, '700');
    } else if (isRunning() && simInfo && ports.inputs.length) {
      var barW = size.w - 24, barY = y + size.h - 11;
      ctx.beginPath();
      ctx.rect(x + 12, barY, barW, 4);
      ctx.fillStyle = 'rgba(143,127,224,0.5)';
      ctx.fill();
      var eq = Math.abs(simInfo.totalIn - simInfo.totalOut) < 1e-6;
      var line = eq
        ? ('进 ' + M.fmtNum(simInfo.totalIn) + '/s = 出 ' + M.fmtNum(simInfo.totalOut) + '/s')
        : ('进 ' + M.fmtNum(simInfo.totalIn) + '/s · 出 ' + M.fmtNum(simInfo.totalOut) + '/s（' + simInfo.unconnectedOuts + ' 个输出口未接）');
      textHalo(line, node.x, y + size.h - 20, 'center', eq ? CO.sim : CO.warn, 10.5, '600');
    } else if (ports.inputs.length) {
      textHalo('缓存器 · ' + ports.inputs.length + ' 进 / ' + ports.outputs.length + ' 出（内容强制一致）',
        node.x, y + size.h - 16, 'center', 'rgba(143,127,224,0.9)', 10, '600');
    }

    if (counts.err || counts.warn) {
      var bx = x + size.w - 13, by = y + 13;
      ctx.beginPath();
      ctx.arc(bx, by, 9, 0, Math.PI * 2);
      ctx.fillStyle = counts.err ? CO.error : CO.warn;
      ctx.fill();
      ctx.fillStyle = '#fff';
      setFont(11, 'bold');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(counts.err || counts.warn), bx, by + 0.5);
    }
    ctx.restore();
  }

  function drawDiamond(node, px) {
    var H2 = M.DIAMOND_HALF;
    var selected = state().selection.nodes.indexOf(node.id) >= 0;
    var isHover = hover.nodeId === node.id;
    var lvl = nodeIssueLevel(node.id);
    var counts = issueCountsFor(node.id);
    var isSource = node.mode === 'source';

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(node.x, node.y - H2);
    ctx.lineTo(node.x + H2, node.y);
    ctx.lineTo(node.x, node.y + H2);
    ctx.lineTo(node.x - H2, node.y);
    ctx.closePath();
    var grad = ctx.createLinearGradient(node.x, node.y - H2, node.x, node.y + H2);
    if (isSource) { grad.addColorStop(0, '#1d2a24'); grad.addColorStop(1, '#101a16'); }
    else { grad.addColorStop(0, '#1c2634'); grad.addColorStop(1, '#101620'); }
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    var border = CO.border, bw = 1.4;
    if (lvl === 'error') { border = CO.error; bw = 2; }
    else if (lvl === 'warn') { border = CO.warn; bw = 1.7; }
    if (isHover) border = CO.borderHover;
    if (selected) { border = CO.accent; bw = 2.2; }
    ctx.lineWidth = bw * Math.max(px, 0.85);
    ctx.strokeStyle = border;
    ctx.stroke();

    // 端口（唯一的输出/输入口）
    var side = isSource ? 'out' : 'in';
    drawPort(node, side, 0, px);

    // 名称（上方）
    textHalo(ellipsize(node.name || (isSource ? '输入端' : '输出端'), H2 * 2.2), node.x, node.y - H2 - 16, 'center', CO.text, 14, '600');

    // 内部：物态 + 内容
    var info = isSource ? node.emit : node.filter;
    var hasItem = !!(info && info.itemId);
    if (hasItem) {
      drawChip(node.x, node.y - 16, 13, itemColor(info.itemId), itemState(info.itemId) === M.FLUID);
      textHalo(ellipsize(itemName(info.itemId), 74), node.x, node.y + 4, 'center', CO.text, 11.5, '600');
      textHalo(isSource ? ('×' + info.count) : (info.count ? ('≥' + info.count) : '接收'),
        node.x, node.y + 22, 'center', CO.textDim, 11, '500');
    } else {
      textHalo('未设置', node.x, node.y - 4, 'center', 'rgba(229,72,77,0.9)', 11.5, '600');
      textHalo(isSource ? '供料物品' : '接受任意', node.x, node.y + 14, 'center', CO.textDim, 10.5, '500');
    }

    // 方向箭头提示（画在没有端口的那一侧尖端，表示物料穿过该方块的方向）
    var ax = isSource ? node.x - H2 + 2 : node.x + H2 - 2;
    var dir = isSource ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(ax, node.y - 6);
    ctx.lineTo(ax, node.y + 6);
    ctx.lineTo(ax + dir * 11, node.y);
    ctx.closePath();
    ctx.fillStyle = isSource ? 'rgba(79,191,123,0.85)' : 'rgba(74,163,216,0.85)';
    ctx.fill();

    // 底部说明
    var sub;
    if (isSource) {
      sub = '每 ' + M.fmtNum(node.emit.ticks) + ' t 产出 ' + M.fmtNum(node.emit.count) + ' 个 · ' + M.fmtNum(M.ratePerSecond(node.emit.count, node.emit.ticks)) + '/s';
    } else {
      sub = hasItem ? ('只接受 ' + itemName(node.filter.itemId)) : '接受任意物品';
    }
    textHalo(sub, node.x, node.y + H2 + 16, 'center', CO.textDim, 11, '500');
    textHalo(isSource ? '物料源（输出口）' : '物料汇（输入口）', node.x, node.y + H2 + 32, 'center', isSource ? 'rgba(79,191,123,0.8)' : 'rgba(74,163,216,0.8)', 10, '600');

    if (counts.err || counts.warn) {
      var bx = node.x + H2 * 0.5, by = node.y - H2 * 0.5;
      ctx.beginPath();
      ctx.arc(bx, by, 9, 0, Math.PI * 2);
      ctx.fillStyle = counts.err ? CO.error : CO.warn;
      ctx.fill();
      ctx.fillStyle = '#fff';
      setFont(11, 'bold');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(counts.err || counts.warn), bx, by + 0.5);
    }
    ctx.restore();
  }

  /* --------------------------------------------------- 拖拽中的连线/框选 */

  function drawPending(px) {
    if (!drag) return;
    if (drag.mode === 'link' && drag.pending) {
      var g = linkGeomFromPending();
      if (!g) return;
      var ok = drag.pending.valid;
      ctx.save();
      ctx.setLineDash([8 * px, 6 * px]);
      ctx.beginPath();
      ctx.moveTo(g.p0.x, g.p0.y);
      ctx.bezierCurveTo(g.c0.x, g.c0.y, g.c1.x, g.c1.y, g.p1.x, g.p1.y);
      ctx.lineWidth = 2.2 * px;
      ctx.strokeStyle = ok ? CO.sim : 'rgba(140,160,180,0.65)';
      ctx.stroke();
      ctx.setLineDash([]);
      var p = bezierAt(g, 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, ok ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = ok ? CO.sim : 'rgba(140,160,180,0.5)';
      ctx.fill();
      ctx.restore();
    }
    if (drag.mode === 'marquee' && drag.marquee) {
      var m = drag.marquee;
      var x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
      var w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
      ctx.save();
      ctx.fillStyle = 'rgba(240,160,32,0.09)';
      ctx.strokeStyle = 'rgba(240,160,32,0.75)';
      ctx.lineWidth = 1.2 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
  }

  function linkGeomFromPending() {
    var p = drag.pending;
    var a = M.portWorld(M.findNode(flow(), p.fromNodeId), p.fromSide, p.fromIndex);
    if (!a) return null;
    var b = p.targetWorld || pointerWorld;
    if (!b) return null;
    var p0, p1;
    if (p.fromSide === 'out') { p0 = a; p1 = b; }
    else { p0 = b; p1 = a; }
    var dx = Math.max(46, Math.abs(p1.x - p0.x) * 0.45);
    return { p0: p0, c0: { x: p0.x + dx, y: p0.y }, c1: { x: p1.x - dx, y: p1.y }, p1: p1 };
  }

  /* -------------------------------------------------------------- 提示 */

  function buildTooltip() {
    tooltipLines = [];
    var f = flow();
    if (hover.port) {
      var node = M.findNode(f, hover.port.nodeId);
      if (!node) return;
      var side = hover.port.side, idx = hover.port.index;
      var ports = M.nodePorts(node);
      var info = (side === 'in' ? ports.inputs : ports.outputs)[idx];
      var key = side === 'in' ? M.inPortKey(node.id, idx) : M.outPortKey(node.id, idx);
      var iss = analysis().portIssues[key];
      tooltipLines.push({ t: node.name + ' · ' + (side === 'in' ? '输入口' : '输出口') + ' ' + (idx + 1), c: CO.text, b: true });
      if (info) {
        tooltipLines.push({ t: (side === 'in' ? '要求：' : '输出：') + (info.itemId ? (itemName(info.itemId) + ' ×' + info.count) : '未设置物品'), c: info.itemId ? CO.textDim : CO.error });
        if (side === 'out' && node.kind === 'machine') tooltipLines.push({ t: '速率：' + M.fmtRate(info.count, node.ticks), c: CO.textDim });
        if (side === 'out' && node.kind === 'diamond') tooltipLines.push({ t: '速率：' + M.fmtRate(info.count, info.ticks), c: CO.textDim });
      }
      tooltipLines.push({ t: side === 'in' ? '可接入多条连线（多对一）' : '可接出多条连线（一对多）', c: CO.textDim });
      if (iss) iss.msgs.forEach(function (m) { tooltipLines.push({ t: m, c: iss.level === 'error' ? '#ff9ea1' : '#f2cf94' }); });
      return;
    }
    if (hover.linkId) {
      var link = null;
      for (var i = 0; i < f.links.length; i++) if (f.links[i].id === hover.linkId) { link = f.links[i]; break; }
      if (!link) return;
      var fn = M.findNode(f, link.from.nodeId), tn = M.findNode(f, link.to.nodeId);
      var content = M.resolveOutPort(f, link.from.nodeId, link.from.index);
      var iss2 = analysis().linkIssues[link.id];
      tooltipLines.push({ t: (fn ? fn.name : '?') + ' → ' + (tn ? tn.name : '?'), c: CO.text, b: true });
      tooltipLines.push({ t: '输出内容：' + (content && content.itemId ? (itemName(content.itemId) + ' ×' + content.count) : '未设置物品'), c: content && content.itemId ? CO.textDim : CO.error });
      if (content && content.itemId) {
        var rateText = content.source === 'buffer'
          ? '速率：随输入（缓存器进出速率恒等）'
          : ('速率：' + M.fmtRate(content.count, content.ticks));
        tooltipLines.push({ t: rateText + (isRunning() ? '　实际：' + M.fmtNum(sim().linkRate[link.id] || 0) + '/s' : ''), c: CO.textDim });
      }
      if (analysis().shareNote && analysis().shareNote[link.id]) {
        tooltipLines.push({ t: analysis().shareNote[link.id], c: CO.textDim });
      }
      if (iss2) tooltipLines.push({ t: iss2.msg, c: iss2.level === 'error' ? '#ff9ea1' : '#f2cf94' });
      else tooltipLines.push({ t: '匹配正常', c: CO.ok });
      tooltipLines.push({ t: '单击选中，Delete 删除', c: CO.textDim });
      return;
    }
    if (hover.nodeId) {
      var nd = M.findNode(f, hover.nodeId);
      if (!nd) return;
      var counts = issueCountsFor(nd.id);
      tooltipLines.push({ t: nd.name, c: CO.text, b: true });
      var layerInfo = null;
      try { layerInfo = G.computeLayers(f); } catch (e) { layerInfo = null; }
      if (layerInfo && layerInfo.stepOf[nd.id] !== undefined) {
        tooltipLines.push({ t: '排版步数：第 ' + layerInfo.stepOf[nd.id] + ' 步（距输入端 ' + layerInfo.stepOf[nd.id] + ' 条连线）', c: CO.accent2 });
      }
      if (nd.kind === 'machine') {
        tooltipLines.push({ t: '机器 · ' + M.fmtNum(nd.power) + ' EU/t · ' + M.fmtNum(nd.ticks) + ' t (' + M.fmtNum(nd.ticks / M.TICKS_PER_SECOND) + ' s)', c: CO.textDim });
        tooltipLines.push({ t: '配方：' + nd.recipe.inputs.length + ' 输入 / ' + nd.recipe.outputs.length + ' 输出', c: CO.textDim });
        if (isRunning() && sim().machine[nd.id]) {
          var mi = sim().machine[nd.id];
          tooltipLines.push({ t: '模拟：' + mi.state + '　' + M.fmtNum(mi.craftRate) + ' 次/s（上限 ' + M.fmtNum(mi.maxCraftRate) + '）', c: CO.sim });
          if (mi.bottleneck) tooltipLines.push({ t: '瓶颈：' + mi.bottleneck, c: '#f2cf94' });
        }
      } else if (nd.kind === 'buffer') {
        var bports = M.nodePorts(nd);
        tooltipLines.push({ t: '缓存器（白板正方形）· ' + bports.inputs.length + ' 进 / ' + bports.outputs.length + ' 出', c: CO.textDim });
        tooltipLines.push({ t: '输出强制与输入一致：第 i 个输出口 = 第 i 个输入口的内容', c: CO.textDim });
        if (isRunning() && sim().buffer[nd.id]) {
          var sbi = sim().buffer[nd.id];
          tooltipLines.push({
            t: '模拟：总进 ' + M.fmtNum(sbi.totalIn) + '/s = 总中转 ' + M.fmtNum(sbi.totalRelay) + '/s' +
              (sbi.unconnectedOuts ? '（' + sbi.unconnectedOuts + ' 个输出口未连接）' : '，总出 ' + M.fmtNum(sbi.totalOut) + '/s'),
            c: CO.sim
          });
          sbi.ports.forEach(function (pp) {
            tooltipLines.push({ t: '　通道' + (pp.index + 1) + '：' + (pp.itemId ? itemName(pp.itemId) : '未设置') + '　进 ' + M.fmtNum(pp.inRate) + '/s → 出 ' + M.fmtNum(pp.outRate) + '/s' + (pp.connected ? '' : '（输出口未连接）'), c: CO.textDim });
          });
        }
        tooltipLines.push({ t: '可放在环路中打破闭环（两台机器直连成环会报错）', c: 'rgba(143,127,224,0.95)' });
      } else {
        tooltipLines.push({ t: (nd.mode === 'source' ? '输入端（物料源）' : '输出端（物料汇）'), c: CO.textDim });
        if (nd.mode === 'source') tooltipLines.push({ t: '产出 ' + (nd.emit.itemId ? itemName(nd.emit.itemId) : '未设置') + ' ×' + nd.emit.count + ' / ' + M.fmtNum(nd.emit.ticks) + ' t', c: CO.textDim });
      }
      var msgs = analysis().nodeIssues[nd.id];
      if (msgs) msgs.msgs.slice(0, 3).forEach(function (m) { tooltipLines.push({ t: m, c: msgs.level === 'error' ? '#ff9ea1' : '#f2cf94' }); });
      if (!counts.err && !counts.warn) tooltipLines.push({ t: '双击打开属性面板', c: CO.textDim });
      return;
    }
    if (flow().nodes.length === 0) {
      tooltipLines.push({ t: '从左侧「输出 / 输入 / 机器 / 预设」栏拖入或点击添加节点', c: CO.textDim });
    }
  }

  function drawTooltip() {
    if (!tooltipLines.length) return;
    var padX = 11, padY = 9, lineH = 18, maxW = 0;
    setFont(12, '500');
    tooltipLines.forEach(function (l) { maxW = Math.max(maxW, ctx.measureText(l.t).width); });
    var w = Math.min(maxW + padX * 2, 380);
    var h = tooltipLines.length * lineH + padY * 2;
    var x = hover.screen.x + 18, y = hover.screen.y + 18;
    if (x + w > W - 8) x = hover.screen.x - w - 14;
    if (y + h > H - 8) y = Math.max(8, H - h - 8);
    if (x < 8) x = 8;

    ctx.save();
    pathRoundRect(x, y, w, h, 8);
    ctx.fillStyle = 'rgba(10,14,19,0.96)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,145,170,0.45)';
    ctx.stroke();
    var ly = y + padY + lineH / 2;
    tooltipLines.forEach(function (l) {
      setFont(12, l.b ? '700' : '500');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = l.c || CO.text;
      ctx.fillText(ellipsize(l.t, w - padX * 2), x + padX, ly);
      ly += lineH;
    });
    ctx.restore();
  }

  /* ------------------------------------------------------------ 命中测试 */

  function hitPort(world) {
    var nodes = flow().nodes;
    var v = view();
    var tol = PORT_HIT / Math.max(v.zoom, 0.4);
    var best = null, bestD = tol;
    for (var i = nodes.length - 1; i >= 0; i--) {
      var node = nodes[i];
      var ports = M.nodePorts(node);
      var sides = [{ s: 'in', list: ports.inputs }, { s: 'out', list: ports.outputs }];
      for (var si = 0; si < 2; si++) {
        var side = sides[si].s, list = sides[si].list;
        for (var k = 0; k < list.length; k++) {
          var p = M.portWorld(node, side, k);
          var d = Math.sqrt((p.x - world.x) * (p.x - world.x) + (p.y - world.y) * (p.y - world.y));
          if (d <= bestD) { bestD = d; best = { nodeId: node.id, side: side, index: k, world: p }; }
        }
      }
    }
    return best;
  }

  function pointInNode(node, world) {
    if (M.isDiamond(node)) {
      var dx = Math.abs(world.x - node.x), dy = Math.abs(world.y - node.y);
      return (dx / M.DIAMOND_HALF + dy / M.DIAMOND_HALF) <= 1;
    }
    var b = M.nodeBounds(node);
    return world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y && world.y <= b.y + b.h;
  }

  function hitNode(world) {
    var nodes = flow().nodes;
    for (var i = nodes.length - 1; i >= 0; i--) {
      if (pointInNode(nodes[i], world)) return nodes[i];
    }
    return null;
  }

  function hitLink(world) {
    var links = flow().links;
    var v = view();
    var tol = LINK_HIT / Math.max(v.zoom, 0.4);
    var best = null, bestD = tol;
    for (var i = 0; i < links.length; i++) {
      var g = linkGeom(links[i]);
      if (!g) continue;
      for (var s = 0; s <= 24; s++) {
        var p = bezierAt(g, s / 24);
        var d = Math.sqrt((p.x - world.x) * (p.x - world.x) + (p.y - world.y) * (p.y - world.y));
        if (d < bestD) { bestD = d; best = links[i]; }
      }
    }
    return best;
  }

  /* --------------------------------------------------------------- 交互 */

  var pointerWorld = { x: 0, y: 0 };
  var pointerScreen = { x: 0, y: 0 };

  function evtPos(e) {
    var r = cvs.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function isPanGesture(e) {
    return e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown);
  }

  function onPointerDown(e) {
    if (e.button === 2) e.preventDefault();
    var sp = evtPos(e);
    var wp = screenToWorld(sp);
    pointerScreen = sp; pointerWorld = wp;
    cvs.setPointerCapture && cvs.setPointerCapture(e.pointerId);
    var port = hitPort(wp);
    var node = hitNode(wp);

    if (isPanGesture(e)) {
      drag = { mode: 'pan', startScreen: sp, startView: { x: view().x, y: view().y }, moved: false };
      return;
    }
    if (e.button !== 0) return;

    if (port) {
      drag = {
        mode: 'link', moved: false, pointerId: e.pointerId,
        pending: { fromNodeId: port.nodeId, fromSide: port.side, fromIndex: port.index, valid: false }
      };
      return;
    }
    if (node) {
      var sel = state().selection.nodes;
      if (sel.indexOf(node.id) < 0) {
        S.selectNodes([node.id], e.shiftKey);
      } else if (e.shiftKey) {
        S.toggleNode(node.id, false);
        if (state().selection.nodes.indexOf(node.id) < 0) return;
      }
      var starts = {};
      S.selectedNodes().forEach(function (n) { starts[n.id] = { x: n.x, y: n.y }; });
      if (!Object.keys(starts).length) starts[node.id] = { x: node.x, y: node.y };
      drag = { mode: 'node', moved: false, startWorld: wp, starts: starts, pointerId: e.pointerId, primary: node.id, before: S.beginDrag() };
      return;
    }
    var link = hitLink(wp);
    if (link) {
      S.selectLinks([link.id], e.shiftKey);
      drag = { mode: 'none', moved: false };
      return;
    }
    // 空白：框选
    if (!e.shiftKey) S.clearSelection();
    drag = { mode: 'marquee', marquee: { x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y }, moved: false, additive: e.shiftKey, pointerId: e.pointerId };
  }

  function onPointerMove(e) {
    var sp = evtPos(e);
    var wp = screenToWorld(sp);
    pointerScreen = sp; pointerWorld = wp;
    hover.screen = sp;

    if (!drag) {
      var port = hitPort(wp);
      var node = port ? null : hitNode(wp);
      var link = (port || node) ? null : hitLink(wp);
      var changed = false;
      var newPort = port ? port.nodeId + '|' + port.side + '|' + port.index : null;
      var oldPort = hover.port ? hover.port.nodeId + '|' + hover.port.side + '|' + hover.port.index : null;
      if (newPort !== oldPort) { hover.port = port ? { nodeId: port.nodeId, side: port.side, index: port.index } : null; changed = true; }
      var nid = node ? node.id : null;
      if (nid !== hover.nodeId) { hover.nodeId = nid; changed = true; }
      var lid = link ? link.id : null;
      if (lid !== hover.linkId) { hover.linkId = lid; changed = true; }
      cvs.style.cursor = port ? 'crosshair' : (node ? 'move' : (link ? 'pointer' : (spaceDown ? 'grab' : 'default')));
      if (changed) invalidate();
      return;
    }

    if (drag.mode === 'pan') {
      var v = view();
      v.x = drag.startView.x - (sp.x - drag.startScreen.x) / v.zoom;
      v.y = drag.startView.y - (sp.y - drag.startScreen.y) / v.zoom;
      drag.moved = true;
      invalidate();
      return;
    }
    if (drag.mode === 'node') {
      var dx = wp.x - drag.startWorld.x;
      var dy = wp.y - drag.startWorld.y;
      if (state().prefs.snap && !e.altKey) {
        var p0 = drag.starts[drag.primary];
        if (p0) {
          dx = Math.round((p0.x + dx) / M.GRID) * M.GRID - p0.x;
          dy = Math.round((p0.y + dy) / M.GRID) * M.GRID - p0.y;
        }
      }
      Object.keys(drag.starts).forEach(function (id) {
        var n = M.findNode(flow(), id);
        if (!n) return;
        n.x = drag.starts[id].x + dx;
        n.y = drag.starts[id].y + dy;
      });
      drag.moved = true;
      S.state.dirty = true;
      invalidate();
      emitLiveChange();
      return;
    }
    if (drag.mode === 'link') {
      var target = hitPort(wp);
      var okTarget = null;
      if (target && target.nodeId !== drag.pending.fromNodeId && target.side !== drag.pending.fromSide) {
        okTarget = target;
      }
      drag.pending.valid = !!okTarget;
      drag.pending.target = okTarget;
      drag.pending.targetWorld = okTarget ? okTarget.world : wp;
      drag.moved = true;
      invalidate();
      return;
    }
    if (drag.mode === 'marquee') {
      drag.marquee.x1 = wp.x;
      drag.marquee.y1 = wp.y;
      drag.moved = true;
      invalidate();
      return;
    }
  }

  function onPointerUp(e) {
    if (cvs.releasePointerCapture && e.pointerId !== undefined) {
      try { cvs.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    if (!drag) return;
    var d = drag;
    drag = null;

    if (d.mode === 'node' && d.moved) {
      S.commitDrag(d.before, '移动节点');
      fire('nodes:moved', {});
    } else if (d.mode === 'link') {
      if (d.pending && d.pending.valid && d.pending.target) {
        var t = d.pending.target;
        if (d.pending.fromSide === 'out') {
          S.addLink(d.pending.fromNodeId, d.pending.fromIndex, t.nodeId, t.index);
        } else {
          S.addLink(t.nodeId, t.index, d.pending.fromNodeId, d.pending.fromIndex);
        }
      }
      invalidate();
    } else if (d.mode === 'marquee' && d.moved) {
      var m = d.marquee;
      var x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
      var y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
      var ids = [];
      flow().nodes.forEach(function (n) {
        var b = M.nodeBounds(n);
        if (b.x + b.w >= x0 && b.x <= x1 && b.y + b.h >= y0 && b.y <= y1) {
          if (!d.additive || state().selection.nodes.indexOf(n.id) < 0) ids.push(n.id);
        }
      });
      S.selectNodes(ids, d.additive);
      invalidate();
    } else if (d.mode === 'pan') {
      S.scheduleAutosave();
      invalidate();
    } else {
      invalidate();
    }
  }

  var liveTimer = null;
  function emitLiveChange() {
    if (liveTimer) return;
    liveTimer = setTimeout(function () {
      liveTimer = null;
      S.emit('change', { label: 'move-live' });
    }, 60);
  }

  function onWheel(e) {
    e.preventDefault();
    var sp = evtPos(e);
    var before = screenToWorld(sp);
    var v = view();
    var factor = Math.pow(1.0016, -e.deltaY * (e.deltaMode === 1 ? 20 : 1));
    v.zoom = M.clamp(v.zoom * factor, 0.2, 3.2);
    var after = screenToWorld(sp);
    v.x += before.x - after.x;
    v.y += before.y - after.y;
    invalidate();
    S.scheduleAutosave();
  }

  function onDblClick(e) {
    var sp = evtPos(e);
    var wp = screenToWorld(sp);
    var node = hitNode(wp);
    if (node) fire('node:dblclick', { nodeId: node.id });
    else fire('canvas:dblclick', { world: wp, screen: sp });
  }

  function onContextMenu(e) {
    e.preventDefault();
    var sp = evtPos(e);
    var wp = screenToWorld(sp);
    var target = { type: 'canvas', world: wp, screen: sp };
    var port = hitPort(wp);
    var node = port ? null : hitNode(wp);
    var link = (port || node) ? null : hitLink(wp);
    if (node) target = { type: 'node', nodeId: node.id, world: wp, screen: sp };
    else if (link) target = { type: 'link', linkId: link.id, world: wp, screen: sp };
    else if (port) target = { type: 'port', port: port, world: wp, screen: sp };
    fire('context', target);
  }

  function onKeyDown(e) {
    if (e.code === 'Space' && !spaceDown && !isTypingTarget(e.target)) {
      spaceDown = true;
      cvs.style.cursor = 'grab';
    }
  }
  function onKeyUp(e) {
    if (e.code === 'Space') { spaceDown = false; cvs.style.cursor = 'default'; }
  }
  function isTypingTarget(el) {
    if (!el) return false;
    var t = (el.tagName || '').toLowerCase();
    return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable;
  }

  /* -------------------------------------------------------- 渲染主循环 */

  function isRunning() { return !!state().run.playing && state().flow.nodes.length > 0; }

  function frame(ts) {
    rafId = 0;
    var dt = lastTime ? Math.min(0.05, (ts - lastTime) / 1000) : 0;
    lastTime = ts;
    if (isRunning() && dt > 0) {
      var speed = state().run.speed || 1;
      var links = flow().links;
      for (var i = 0; i < links.length; i++) {
        var l = links[i];
        var rate = (S.state.sim && S.state.sim.linkRate[l.id]) || 0;
        if (rate <= 1e-6) continue;
        var perSec = M.clamp(0.12 + Math.log2(1 + rate) * 0.16, 0.12, 1.1) * speed;
        l.__phase = ((l.__phase || 0) + dt * perSec) % 1;
      }
      needsRender = true;
    }
    if (needsRender) render();
    if (isRunning()) schedule();
  }

  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(frame);
  }
  function invalidate() {
    needsRender = true;
    if (!rafId) rafId = requestAnimationFrame(frame);
    else schedule();
  }

  function render() {
    needsRender = false;
    if (!cvs) return;
    W = cvs.clientWidth; H = cvs.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = CO.bg;
    ctx.fillRect(0, 0, W, H);
    drawGrid();

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(view().zoom, view().zoom);
    ctx.translate(-view().x, -view().y);
    var px = 1 / view().zoom;
    drawLinks(px);
    drawNodes(px);
    drawPending(px);
    ctx.restore();

    buildTooltip();
    drawTooltip();

    if (flow().nodes.length === 0) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(150,168,186,0.55)';
      setFont(16, '600');
      ctx.fillText('空产线：从左侧栏拖入「输入端 / 输出端 / 机器」开始搭建', W / 2, H / 2 - 14);
      setFont(12.5, '400');
      ctx.fillStyle = 'rgba(140,158,176,0.45)';
      ctx.fillText('拖拽端口连线 · 滚轮缩放 · 中键/右键/空格拖动平移 · 双击节点编辑属性', W / 2, H / 2 + 16);
      ctx.restore();
    }
  }

  function resize() {
    if (!cvs) return;
    dpr = window.devicePixelRatio || 1;
    W = cvs.clientWidth; H = cvs.clientHeight;
    var nw = Math.max(1, Math.round(W * dpr)), nh = Math.max(1, Math.round(H * dpr));
    if (cvs.width !== nw || cvs.height !== nh) {
      cvs.width = nw;
      cvs.height = nh;
    }
    invalidate();
  }

  /* -------------------------------------------------------- 视图辅助 */

  function fitToContent(padding) {
    var nodes = flow().nodes;
    var v = view();
    if (!nodes.length) {
      v.x = 0; v.y = 0; v.zoom = 1;
      invalidate();
      return;
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      var b = M.nodeBounds(n);
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    });
    var pad = typeof padding === 'number' ? padding : 90;
    var w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    W = cvs.clientWidth; H = cvs.clientHeight;
    var z = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
    v.zoom = M.clamp(z, 0.2, 2);
    v.x = (minX + maxX) / 2;
    v.y = (minY + maxY) / 2;
    invalidate();
    S.scheduleAutosave();
  }

  function resetZoom() {
    view().zoom = 1;
    invalidate();
  }

  /** 找到一块空白位置用于新节点（避免叠在一起） */
  function findFreeSpot(world, size) {
    var x = world.x, y = world.y;
    var nodes = flow().nodes;
    var tries = 0;
    while (tries < 60) {
      var clash = false;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (Math.abs(n.x - x) < (size ? size.w : 180) * 0.62 && Math.abs(n.y - y) < (size ? size.h : 120) * 0.62) { clash = true; break; }
      }
      if (!clash) break;
      x += 44; y += 36;
      tries++;
    }
    return { x: x, y: y };
  }

  function centerWorld() {
    return { x: view().x, y: view().y };
  }

  /* --------------------------------------------------------------- 初始化 */

  function init(canvasEl) {
    cvs = canvasEl;
    wrap = cvs.parentElement;
    ctx = cvs.getContext('2d');
    resize();

    cvs.addEventListener('pointerdown', onPointerDown);
    cvs.addEventListener('pointermove', onPointerMove);
    cvs.addEventListener('pointerup', onPointerUp);
    cvs.addEventListener('pointercancel', onPointerUp);
    cvs.addEventListener('pointerleave', function () {
      hover.nodeId = null; hover.linkId = null; hover.port = null;
      invalidate();
    });
    cvs.addEventListener('wheel', onWheel, { passive: false });
    cvs.addEventListener('dblclick', onDblClick);
    cvs.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () { resize(); });
      ro.observe(wrap || cvs);
    }

    S.on('change', function () { invalidate(); });
    S.on('analysis', function () { invalidate(); });
    S.on('flow:replaced', function (p) {
      hover = { nodeId: null, linkId: null, port: null, screen: { x: 0, y: 0 } };
      if (!p || p.reason !== 'history') {
        if (state().prefs.autoFit) fitToContent();
      }
      invalidate();
    });

    invalidate();
    return api;
  }

  var api = {
    init: init, resize: resize, invalidate: invalidate, render: render,
    worldToScreen: worldToScreen, screenToWorld: screenToWorld, worldRect: worldRect,
    fitToContent: fitToContent, resetZoom: resetZoom, findFreeSpot: findFreeSpot,
    centerWorld: centerWorld, hitNode: hitNode, hitPort: hitPort, hitLink: hitLink,
    on: onApi,
    getHover: function () { return hover; },
    setPlaying: function (on) {
      state().run.playing = !!on;
      if (on) { lastTime = 0; schedule(); }
      invalidate();
    },
    isPlaying: function () { return !!state().run.playing; },
    colors: CO
  };
  return api;
});
