/* ============================================================================
 * GT 产线模拟器 — graph.js
 * 校验引擎（配方/连线/环路/可达性） + 吞吐模拟（固定点迭代）
 *
 * 无 DOM 依赖，可在 Node 中测试。
 * ==========================================================================*/
(function (root, factory) {
  'use strict';
  var api = factory(root.GT && root.GT.model);
  root.GT = root.GT || {};
  root.GT.graph = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  if (!M) throw new Error('graph.js 需要先加载 model.js');

  var LEVEL_ORDER = { error: 0, warn: 1, info: 2 };

  function emptyAnalysis() {
    return {
      stats: {
        machineCount: 0, sourceCount: 0, sinkCount: 0, bufferCount: 0, nodeCount: 0, linkCount: 0, itemCount: 0,
        power: 0, ticks: 0, maxCraftRate: 0
      },
      linkIssues: {}, portIssues: {}, nodeIssues: {}, shareNote: {}, outCaps: {},
      stalledBuffers: {}, stalled: null,
      issueList: [], counts: { error: 0, warn: 0, info: 0 },
      cycles: [], bufferLoops: [], craftRateMax: {}
    };
  }

  function addIssue(res, issue) {
    issue.level = issue.level || 'error';
    res.issueList.push(issue);
    res.counts[issue.level] = (res.counts[issue.level] || 0) + 1;
    if (issue.linkId) {
      var li = res.linkIssues[issue.linkId];
      if (!li || LEVEL_ORDER[issue.level] < LEVEL_ORDER[li.level]) {
        res.linkIssues[issue.linkId] = { level: issue.level, msg: issue.msg };
      } else if (li && li.msg.indexOf(issue.msg) < 0) {
        li.msg += '；' + issue.msg;
      }
    }
    if (issue.portKey) {
      var pi = res.portIssues[issue.portKey];
      if (!pi) { pi = res.portIssues[issue.portKey] = { level: issue.level, msgs: [], expected: issue.expected || null, actuals: [] }; }
      if (LEVEL_ORDER[issue.level] < LEVEL_ORDER[pi.level]) pi.level = issue.level;
      if (pi.msgs.indexOf(issue.msg) < 0) pi.msgs.push(issue.msg);
      if (issue.expected) pi.expected = issue.expected;
    }
    if (issue.nodeId) {
      var ni = res.nodeIssues[issue.nodeId];
      if (!ni) { ni = res.nodeIssues[issue.nodeId] = { level: issue.level, msgs: [] }; }
      if (LEVEL_ORDER[issue.level] < LEVEL_ORDER[ni.level]) ni.level = issue.level;
      if (ni.msgs.indexOf(issue.msg) < 0) ni.msgs.push(issue.msg);
    }
  }

  function itemNameOf(flow, itemId) {
    var it = M.findItem(flow, itemId);
    return it ? it.name : (itemId ? '已删除物品' : '未设置物品');
  }

  /**
   * 输入口内容校验（机器与缓存器共用）：
   * 检查接入该输入口的每条连线上游输出的物品，是否正是这个输入口要求的物品。
   * 返回 { mismatch, entries:[{link, fromNode, fromLabel, content, matched}] }
   */
  function checkInputContents(flow, res, nodeById, cfg) {
    var incoming = M.linksOfPort(flow, cfg.node.id, 'in', cfg.index);
    var out = { mismatch: false, entries: [] };
    for (var i = 0; i < incoming.length; i++) {
      var link = incoming[i];
      var fromNode = nodeById[link.from.nodeId];
      var content = M.resolveOutPort(flow, link.from.nodeId, link.from.index);
      var fromLabel = fromNode ? fromNode.name + ' 输出口 ' + ((link.from.index | 0) + 1) : '?';
      var entry = { link: link, fromNode: fromNode, fromLabel: fromLabel, content: content, matched: false };
      if (!content || !content.itemId) {
        out.mismatch = true;
        addIssue(res, {
          level: 'error', linkId: link.id, nodeId: cfg.node.id, portKey: cfg.portKey, expected: cfg.expected,
          msg: cfg.ownerLabel + '的输入口 ' + (cfg.index + 1) + ' 接入了“' + fromLabel +
            '”，但上游没有设置输出物品，无法供料。'
        });
      } else if (cfg.expectItemId && content.itemId !== cfg.expectItemId) {
        out.mismatch = true;
        var expItem = M.findItem(flow, cfg.expectItemId);
        var actItem = M.findItem(flow, content.itemId);
        var stateHint = '';
        if (expItem && actItem && expItem.name === actItem.name && expItem.state !== actItem.state) {
          stateHint = '（名称相同但物态不同：要求' + (M.STATE_LABEL[expItem.state] || expItem.state) + '，实际' + (M.STATE_LABEL[actItem.state] || actItem.state) + '）';
        }
        addIssue(res, {
          level: 'error', linkId: link.id, nodeId: cfg.node.id, portKey: cfg.portKey, expected: cfg.expected,
          msg: '内容不匹配：' + cfg.ownerLabel + '输入口 ' + (cfg.index + 1) + ' 要求“' +
            itemNameOf(flow, cfg.expectItemId) + '”，而“' + fromLabel + '”输出的是“' +
            itemNameOf(flow, content.itemId) + '”' + stateHint + '。'
        });
      } else if (content.itemId && cfg.expectItemId) {
        entry.matched = true;
      }
      out.entries.push(entry);
    }
    return out;
  }

  /** 计算单个机器满速产能：crafts/s */
  function maxCraftRate(node) {
    return M.TICKS_PER_SECOND / M.num(node && node.ticks, M.TICKS_PER_SECOND, 1);
  }

  /**
   * 各输出口的「理论最大速率」（个或 mB / 秒）。
   *  - 机器输出口 = 满速产能 × 配方数量
   *  - 输入端（物料源）= 数量 × 20 ÷ 间隔 tick
   *  - 缓存器输出口 = 它对应输入口汇入的速率之和（进出速率恒等，只做中转）
   * 递归计算，遇到环路时该分支按 0 计（闭环本身不能凭空产生物料）。
   * 校验与模拟共用这套数值，保证“界面判定”与“模拟结果”一致。
   */
  function computeOutCaps(flow, nodeById, outFanout) {
    var caps = {};
    var inProgress = {};
    var nodes = (flow && flow.nodes) || [];
    var links = (flow && flow.links) || [];
    var incomingOf = {};
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      if (!nodeById[l.from.nodeId] || !nodeById[l.to.nodeId]) continue;
      var ik = M.inPortKey(l.to.nodeId, l.to.index);
      (incomingOf[ik] = incomingOf[ik] || []).push(l);
    }
    function linkCap(link) {
      var key = M.outPortKey(link.from.nodeId, link.from.index);
      var fan = outFanout[key] || 1;
      return maxOut(link.from.nodeId, link.from.index) / fan;
    }
    function maxIn(nodeId, index) {
      var list = incomingOf[M.inPortKey(nodeId, index)] || [];
      var sum = 0;
      for (var k = 0; k < list.length; k++) sum += linkCap(list[k]);
      return sum;
    }
    function maxOut(nodeId, index) {
      var key = M.outPortKey(nodeId, index);
      if (caps[key] !== undefined) return caps[key];
      if (inProgress[key]) return 0;
      inProgress[key] = true;
      var node = nodeById[nodeId];
      var val = 0;
      if (node) {
        var ports = M.nodePorts(node).outputs;
        var p = ports[index];
        if (node.kind === 'machine') {
          val = p ? maxCraftRate(node) * p.count : 0;
        } else if (node.kind === 'diamond') {
          val = (p && node.emit && node.emit.itemId) ? M.ratePerSecond(node.emit.count, node.emit.ticks) : 0;
        } else if (node.kind === 'buffer') {
          val = p ? maxIn(nodeId, index) : 0;
        }
      }
      delete inProgress[key];
      caps[key] = val;
      return val;
    }
    for (var n = 0; n < nodes.length; n++) {
      var outs = M.nodePorts(nodes[n]).outputs;
      for (var o = 0; o < outs.length; o++) maxOut(nodes[n].id, o);
    }
    return caps;
  }

  /* ------------------------------------------------------------- 强连通分量 */

  function tarjanSCC(nodeIds, adj) {
    var index = 0, stack = [], onStack = {}, indices = {}, low = {}, comps = [];
    // 迭代式 DFS，避免深图爆栈
    for (var s = 0; s < nodeIds.length; s++) {
      var start = nodeIds[s];
      if (indices[start] !== undefined) continue;
      var callStack = [{ v: start, i: 0 }];
      while (callStack.length) {
        var frame = callStack[callStack.length - 1];
        var v = frame.v;
        if (frame.i === 0) {
          indices[v] = low[v] = index++;
          stack.push(v); onStack[v] = true;
        }
        var neigh = adj[v] || [];
        if (frame.i < neigh.length) {
          var w = neigh[frame.i++];
          if (indices[w] === undefined) {
            callStack.push({ v: w, i: 0 });
          } else if (onStack[w]) {
            low[v] = Math.min(low[v], indices[w]);
          }
        } else {
          callStack.pop();
          if (callStack.length) {
            var p = callStack[callStack.length - 1].v;
            low[p] = Math.min(low[p], low[v]);
          }
          if (low[v] === indices[v]) {
            var comp = [], u;
            do { u = stack.pop(); onStack[u] = false; comp.push(u); } while (u !== v);
            comps.push(comp);
          }
        }
      }
    }
    return comps;
  }

  /* ------------------------------------------------ 无消耗缓存器闭环（会堵塞） */

  /**
   * 找出「没有出料/消耗端的纯缓存器闭环」：环上每个输出口的扇出都是 1。
   * 这种环路的增益 = 1，数学上不存在稳态（现实中缓存器会装满并堵塞），
   * 因此模拟中把整环流量按 0 处理（上游物料被堵住），并在校验中给出警告。
   * 返回 { has, nodes:{id:true}, inPorts:{key:true}, outPorts:{key:true}, links:{id:true} }
   */
  function findStalledLoops(flow) {
    var result = { has: false, nodes: {}, inPorts: {}, outPorts: {}, links: {} };
    if (!flow || !flow.nodes || !flow.links) return result;
    var byId = {};
    flow.nodes.forEach(function (n) { byId[n.id] = n; });
    var outCount = {};
    flow.links.forEach(function (l) {
      var k = M.outPortKey(l.from.nodeId, l.from.index);
      outCount[k] = (outCount[k] || 0) + 1;
    });
    var ringLinks = [];
    flow.links.forEach(function (l) {
      var fn = byId[l.from.nodeId], tn = byId[l.to.nodeId];
      if (!fn || !tn) return;
      if (fn.kind !== 'buffer' || tn.kind !== 'buffer') return;
      if ((outCount[M.outPortKey(l.from.nodeId, l.from.index)] || 1) !== 1) return;
      ringLinks.push(l);
    });
    if (!ringLinks.length) return result;
    var bufferIds = [];
    flow.nodes.forEach(function (n) { if (n.kind === 'buffer') bufferIds.push(n.id); });
    var adjacency = {};
    ringLinks.forEach(function (l) {
      (adjacency[l.from.nodeId] = adjacency[l.from.nodeId] || []).push(l.to.nodeId);
    });
    var comps = tarjanSCC(bufferIds, adjacency);
    var ringSccOf = {};
    comps.forEach(function (comp, ci) {
      if (comp.length < 2) return;
      comp.forEach(function (id) { ringSccOf[id] = ci; });
    });
    ringLinks.forEach(function (l) {
      var ci = ringSccOf[l.from.nodeId];
      if (ci === undefined || ci !== ringSccOf[l.to.nodeId]) return;
      result.has = true;
      result.nodes[l.from.nodeId] = true;
      result.nodes[l.to.nodeId] = true;
      result.links[l.id] = true;
      result.outPorts[M.outPortKey(l.from.nodeId, l.from.index)] = true;
      result.inPorts[M.inPortKey(l.to.nodeId, l.to.index)] = true;
    });
    return result;
  }

  /* ---------------------------------------------------------------- 校验 */

  function analyze(flow) {
    var res = emptyAnalysis();
    if (!flow) return res;

    var nodes = flow.nodes || [];
    var links = flow.links || [];
    var i;

    for (i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      res.stats.nodeCount++;
      if (nd.kind === 'machine') {
        res.stats.machineCount++;
        res.stats.power += M.num(nd.power, 0);
        res.stats.ticks += M.num(nd.ticks, 0);
        res.craftRateMax[nd.id] = maxCraftRate(nd);
      } else if (nd.kind === 'diamond') {
        if (nd.mode === 'source') res.stats.sourceCount++; else res.stats.sinkCount++;
      } else if (nd.kind === 'buffer') {
        res.stats.bufferCount++;
      }
    }
    res.stats.itemCount = (flow.items || []).length;
    res.stats.linkCount = links.length;
    res.stats.maxCraftRate = 0;

    var nodeById = {};
    for (i = 0; i < nodes.length; i++) {
      nodeById[nodes[i].id] = nodes[i];
      if (!M.str(nodes[i].name, '').trim()) {
        addIssue(res, { level: 'warn', nodeId: nodes[i].id, msg: '节点没有名称。' });
      }
    }

    // 名称重复提示
    var nameMap = {};
    for (i = 0; i < nodes.length; i++) {
      var nm = M.str(nodes[i].name, '').trim();
      if (!nm) continue;
      if (!nameMap[nm]) nameMap[nm] = [];
      nameMap[nm].push(nodes[i]);
    }
    Object.keys(nameMap).forEach(function (nm) {
      if (nameMap[nm].length > 1) {
        addIssue(res, { level: 'info', nodeId: nameMap[nm][0].id, msg: '有 ' + nameMap[nm].length + ' 个节点同名：“' + nm + '”，建议改名便于区分。' });
      }
    });

    /* --- 节点自身配置校验 --- */
    for (i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.kind === 'machine') {
        if (!node.recipe || ((node.recipe.inputs || []).length === 0 && (node.recipe.outputs || []).length === 0)) {
          addIssue(res, { level: 'warn', nodeId: node.id, msg: '机器“' + node.name + '”的配方为空，请至少添加一条输入或输出。' });
        }
        if (M.num(node.power, 0) <= 0) {
          addIssue(res, { level: 'info', nodeId: node.id, msg: '机器“' + node.name + '”耗电量为 0 EU/t。' });
        }
        var ins = (node.recipe && node.recipe.inputs) || [];
        var outs = (node.recipe && node.recipe.outputs) || [];
        var k;
        for (k = 0; k < ins.length; k++) {
          if (!ins[k].itemId) {
            addIssue(res, { level: 'error', nodeId: node.id, portKey: M.inPortKey(node.id, k), expected: ins[k], msg: '机器“' + node.name + '”的第 ' + (k + 1) + ' 个输入口（配方）未设置物品。' });
          }
        }
        for (k = 0; k < outs.length; k++) {
          if (!outs[k].itemId) {
            addIssue(res, { level: 'error', nodeId: node.id, portKey: M.outPortKey(node.id, k), msg: '机器“' + node.name + '”的第 ' + (k + 1) + ' 个输出口（配方）未设置物品。' });
          }
        }
        var dupIn = {};
        for (k = 0; k < ins.length; k++) {
          if (!ins[k].itemId) continue;
          dupIn[ins[k].itemId] = (dupIn[ins[k].itemId] || 0) + 1;
        }
        Object.keys(dupIn).forEach(function (id) {
          if (dupIn[id] > 1) {
            addIssue(res, { level: 'info', nodeId: node.id, msg: '配方输入中有 ' + dupIn[id] + ' 条“' + itemNameOf(flow, id) + '”，它们会变成 ' + dupIn[id] + ' 个独立输入口，建议合并为一条并提高数量。' });
          }
        });
      } else if (node.kind === 'diamond' && node.mode === 'source') {
        if (!node.emit || !node.emit.itemId) {
          addIssue(res, { level: 'error', nodeId: node.id, portKey: M.outPortKey(node.id, 0), msg: '输入端“' + node.name + '”未设置要供应的物品。' });
        }
      } else if (node.kind === 'buffer') {
        var bIn = (node.recipe && node.recipe.inputs) || [];
        if (!bIn.length) {
          addIssue(res, { level: 'warn', nodeId: node.id, msg: '缓存器“' + node.name + '”还没有配置输入：输出会强制与输入一致，请至少添加一条输入。' });
        }
        var bdup = {};
        for (var bk = 0; bk < bIn.length; bk++) {
          if (!bIn[bk].itemId) {
            addIssue(res, { level: 'error', nodeId: node.id, portKey: M.inPortKey(node.id, bk), msg: '缓存器“' + node.name + '”的第 ' + (bk + 1) + ' 个输入口未设置物品。' });
          } else {
            bdup[bIn[bk].itemId] = (bdup[bIn[bk].itemId] || 0) + 1;
          }
        }
        Object.keys(bdup).forEach(function (id) {
          if (bdup[id] > 1) {
            addIssue(res, { level: 'info', nodeId: node.id, msg: '缓存器“' + node.name + '”有 ' + bdup[id] + ' 个输入口都是“' + itemNameOf(flow, id) + '”，会形成 ' + bdup[id] + ' 组独立的中转通道。' });
          }
        });
      }
    }

    /* --- 连线结构校验 --- */
    var outFanout = {}, inFanin = {};
    var adj = {}, inAdj = {};
    for (i = 0; i < links.length; i++) {
      var l = links[i];
      var fn = nodeById[l.from.nodeId];
      var tn = nodeById[l.to.nodeId];
      l.__valid = true;
      if (!fn || !tn) {
        addIssue(res, { level: 'error', linkId: l.id, msg: '连线的一端指向不存在的节点。' });
        l.__valid = false;
        continue;
      }
      if (fn.id === tn.id) {
        addIssue(res, { level: 'error', linkId: l.id, msg: '连线不能从节点连到它自己。' });
        l.__valid = false;
        continue;
      }
      var fnOut = M.nodePorts(fn).outputs;
      var tnIn = M.nodePorts(tn).inputs;
      if ((l.from.index | 0) >= fnOut.length) {
        addIssue(res, { level: 'error', linkId: l.id, nodeId: fn.id, msg: '“' + fn.name + '”的输出口 ' + ((l.from.index | 0) + 1) + ' 已不存在（配方被修改），请重新连线。' });
        l.__valid = false;
        continue;
      }
      if ((l.to.index | 0) >= tnIn.length) {
        addIssue(res, { level: 'error', linkId: l.id, nodeId: tn.id, msg: '“' + tn.name + '”的输入口 ' + ((l.to.index | 0) + 1) + ' 已不存在（配方被修改），请重新连线。' });
        l.__valid = false;
        continue;
      }
      var ok = M.outPortKey(fn.id, l.from.index);
      var ik = M.inPortKey(tn.id, l.to.index);
      outFanout[ok] = (outFanout[ok] || 0) + 1;
      inFanin[ik] = (inFanin[ik] || 0) + 1;
      adj[fn.id] = adj[fn.id] || [];
      adj[fn.id].push(tn.id);
      inAdj[tn.id] = inAdj[tn.id] || [];
      inAdj[tn.id].push(fn.id);
    }

    /* --- 输出口理论最大速率（缓存器按输入汇入速率递归计算） --- */
    res.outCaps = computeOutCaps(flow, nodeById, outFanout);

    /* --- 环路检测（SCC）---
     * 缓存器提供缓冲，可以“打破”闭环：只有「去掉缓存器后仍然成环」才算错误。
     * 原来的两台机器直连成环的报错保留，并提示需要接入缓存器。 */
    var ids = nodes.map(function (n) { return n.id; });
    var comps = tarjanSCC(ids, adj);
    var sccOf = {};
    comps.forEach(function (comp, ci) {
      comp.forEach(function (id) { sccOf[id] = ci; });
      if (comp.length > 1) res.cycles.push(comp.slice());
    });
    // 只用「非缓存器节点」以及「两端都不含缓存器」的连线构成子图再检测一次：
    // 这里检出的才是真正违规的闭环（凡是必须经过缓存器的环路都不算违规）。
    var nonBufferIds = nodes.filter(function (n) { return n.kind !== 'buffer'; }).map(function (n) { return n.id; });
    var nonBufAdj = {};
    for (i = 0; i < links.length; i++) {
      var nl = links[i];
      if (!nl.__valid) continue;
      var nf = nodeById[nl.from.nodeId], nt = nodeById[nl.to.nodeId];
      if (!nf || !nt) continue;
      if (nf.kind === 'buffer' || nt.kind === 'buffer') continue;
      (nonBufAdj[nf.id] = nonBufAdj[nf.id] || []).push(nt.id);
    }
    var badComps = tarjanSCC(nonBufferIds, nonBufAdj);
    var badSccOf = {};
    var badCompById = {};
    badComps.forEach(function (comp, ci) {
      if (comp.length > 1) {
        badCompById[ci] = comp;
        comp.forEach(function (id) { badSccOf[id] = ci; });
      }
    });
    for (i = 0; i < links.length; i++) {
      var lk = links[i];
      if (!lk.__valid) continue;
      var sameBadScc = badSccOf[lk.from.nodeId] !== undefined && badSccOf[lk.from.nodeId] === badSccOf[lk.to.nodeId];
      if (sameBadScc) {
        // 只列出真正违规的那个环（不含缓存器）上的节点，避免把旁路缓存器也写进报错
        var badComp = badCompById[badSccOf[lk.from.nodeId]] || [];
        var names = badComp.map(function (id) { return nodeById[id] ? nodeById[id].name : '?'; }).join(' → ');
        addIssue(res, {
          level: 'error', linkId: lk.id, nodeId: lk.from.nodeId,
          msg: '检测到物料环路：' + names + '。格雷科技中的循环需要缓冲/缓存，纯闭环无法成立：请断开其中一条连线，' +
            '或者在这个环路中接入一个「缓存器」（缓存器可以打破闭环，实现循环连接）。'
        });
      }
    }
    // 被缓存器打破的环路：给出信息提示（不算错误）
    var bufferLoopReported = {};
    for (i = 0; i < links.length; i++) {
      var bl = links[i];
      if (!bl.__valid) continue;
      if (sccOf[bl.from.nodeId] === undefined || sccOf[bl.from.nodeId] !== sccOf[bl.to.nodeId]) continue;
      var loopComp = res.cycles.filter(function (c) { return c.indexOf(bl.from.nodeId) >= 0; })[0];
      if (!loopComp) continue;
      var hasBuffer = loopComp.some(function (id) { return nodeById[id] && nodeById[id].kind === 'buffer'; });
      var stillBad = badSccOf[bl.from.nodeId] !== undefined && badSccOf[bl.from.nodeId] === badSccOf[bl.to.nodeId];
      if (hasBuffer && !stillBad && !bufferLoopReported[loopComp.join('|')]) {
        bufferLoopReported[loopComp.join('|')] = true;
        res.bufferLoops.push(loopComp.slice());
        var bufNode = loopComp.map(function (id) { return nodeById[id]; }).filter(function (n) { return n && n.kind === 'buffer'; })[0];
        var loopNames = loopComp.map(function (id) { return nodeById[id] ? nodeById[id].name : '?'; }).join(' → ');
        addIssue(res, {
          level: 'info', nodeId: bufNode ? bufNode.id : bl.from.nodeId,
          msg: '循环连接成立：环路 ' + loopNames + ' 中已接入缓存器“' + (bufNode ? bufNode.name : '') + '”，缓存器提供缓冲且进出速率恒等，环内按稳态计算。'
        });
      }
    }

    /* --- 无消耗的纯缓存器闭环：会装满堵塞，整环流量按 0 处理 --- */
    var stalled = findStalledLoops(flow);
    res.stalledBuffers = stalled.nodes;
    res.stalled = stalled;
    if (stalled.has) {
      Object.keys(stalled.nodes).forEach(function (id) {
        var sn = nodeById[id];
        addIssue(res, {
          level: 'warn', nodeId: id,
          msg: '缓存器“' + (sn ? sn.name : '') + '”处在一个没有出料端/消耗端的缓存器闭环中：缓存器会装满并堵塞，' +
            '整环流量为 0（游戏里同样会堵住），上游物料也进不去。请接入出料端或断开环路。'
        });
      });
    }

    /* --- 输入端（source）输出口供给校验 --- */
    for (i = 0; i < nodes.length; i++) {
      var sn = nodes[i];
      if (sn.kind !== 'diamond' || sn.mode !== 'source') continue;
      var key = M.outPortKey(sn.id, 0);
      if (!outFanout[key]) {
        addIssue(res, { level: 'warn', nodeId: sn.id, portKey: key, msg: '输入端“' + sn.name + '”的输出口没有连接任何机器输入口。' });
      }
    }

    /* --- 缓存器：输入必须接上且内容匹配，输出镜像输入也必须有去处 --- */
    for (i = 0; i < nodes.length; i++) {
      var bnode = nodes[i];
      if (bnode.kind !== 'buffer') continue;
      var bInputs = (bnode.recipe && bnode.recipe.inputs) || [];
      for (var bi = 0; bi < bInputs.length; bi++) {
        var bInKey = M.inPortKey(bnode.id, bi);
        var bOutKey = M.outPortKey(bnode.id, bi);
        var bItem = bInputs[bi].itemId;
        var bHasIn = M.linksOfPort(flow, bnode.id, 'in', bi).length > 0;
        if (!bHasIn) {
          addIssue(res, {
            level: 'error', nodeId: bnode.id, portKey: bInKey,
            msg: '缓存器“' + bnode.name + '”的第 ' + (bi + 1) + ' 个输入口（' + itemNameOf(flow, bItem) + '）没有接入任何连线。'
          });
        } else if (bItem) {
          // 与机器同规则：接进来的内容必须与这个输入口要求的物品一致
          checkInputContents(flow, res, nodeById, {
            node: bnode, index: bi, expectItemId: bItem, portKey: bInKey, expected: bInputs[bi],
            ownerLabel: '缓存器“' + bnode.name + '”'
          });
        }
        if (!outFanout[bOutKey]) {
          addIssue(res, {
            level: 'warn', nodeId: bnode.id, portKey: bOutKey,
            msg: '缓存器“' + bnode.name + '”的第 ' + (bi + 1) + ' 个输出口（镜像输出 ' + itemNameOf(flow, bItem) + '）没有连接，中转出来的物料无处可去。'
          });
        }
      }
    }

    /* --- 机器输入口 / 输出口 --- */
    for (i = 0; i < nodes.length; i++) {
      var mn = nodes[i];
      if (mn.kind !== 'machine') continue;
      var mIns = (mn.recipe && mn.recipe.inputs) || [];
      var mOuts = (mn.recipe && mn.recipe.outputs) || [];
      var mTicks = M.num(mn.ticks, M.TICKS_PER_SECOND, 1);
      var needRate = mTicks > 0 ? M.TICKS_PER_SECOND / mTicks : 0; // crafts/s（满速）

      for (var pi = 0; pi < mIns.length; pi++) {
        var expLine = mIns[pi];
        var pkey = M.inPortKey(mn.id, pi);
        var inc = M.linksOfPort(flow, mn.id, 'in', pi);
        if (!inc.length) {
          addIssue(res, {
            level: 'error', nodeId: mn.id, portKey: pkey, expected: expLine,
            msg: '机器“' + mn.name + '”的输入口 ' + (pi + 1) + '（需要 ' + itemNameOf(flow, expLine.itemId) + ' ×' + expLine.count + '）没有接入任何连线。'
          });
          continue;
        }
        var check = checkInputContents(flow, res, nodeById, {
          node: mn, index: pi, expectItemId: expLine.itemId, portKey: pkey, expected: expLine,
          ownerLabel: '机器“' + mn.name + '”'
        });
        var mismatch = check.mismatch;
        var sumRate = 0;
        for (var ci = 0; ci < check.entries.length; ci++) {
          var entry = check.entries[ci];
          if (!entry.matched) continue;
          // 与模拟保持一致：一个输出口的下游连线均分该输出口的流量；
          // 若上游是缓存器，则用「它实际能收到的物料」作为可提供速率
          var upKey = M.outPortKey(entry.link.from.nodeId, entry.link.from.index);
          var fanout = outFanout[upKey] || 1;
          var upTotal = res.outCaps[upKey] || 0;
          var r = upTotal / fanout;
          sumRate += r;
          var isBufferUp = !!(entry.fromNode && entry.fromNode.kind === 'buffer');
          if (fanout > 1 || isBufferUp) {
            res.shareNote[entry.link.id] = '上游“' + entry.fromLabel + '”可提供 ' + M.fmtNum(upTotal) + '/s' +
              (fanout > 1 ? '，由 ' + fanout + ' 条连线均分，本线分得 ' + M.fmtNum(r) + '/s' : '') +
              (isBufferUp ? '（缓存器只中转它收到的物料，进出速率恒等）' : '');
          }
        }
        if (!mismatch && expLine.itemId) {
          var want = M.ratePerSecond(expLine.count, mTicks);
          var shared = inc.some(function (l) {
            return (outFanout[M.outPortKey(l.from.nodeId, l.from.index)] || 1) > 1;
          });
          var throughBuffer = inc.some(function (l) {
            var up = nodeById[l.from.nodeId];
            return !!(up && up.kind === 'buffer');
          });
          var shareHint = (shared ? '（上游输出口需在 ' + inc.length + ' 条支线间均分）' : '') +
            (throughBuffer ? '（经缓存器中转的物料量取决于缓存器实际收到的输入）' : '');
          if (sumRate < want - 1e-9) {
            addIssue(res, {
              level: 'error', linkId: inc[0].id, nodeId: mn.id, portKey: pkey, expected: expLine,
              msg: '供料不足：机器“' + mn.name + '”输入口 ' + (pi + 1) + ' 满速需要 ' + M.fmtNum(want) + '/s 的“' + itemNameOf(flow, expLine.itemId) + '”，当前接入的连线只能提供 ' + M.fmtNum(sumRate) + '/s' + shareHint + '。'
            });
          } else if (sumRate > want + 1e-9) {
            addIssue(res, {
              level: 'warn', linkId: inc[0].id, nodeId: mn.id, portKey: pkey, expected: expLine,
              msg: '供料过量：机器“' + mn.name + '”输入口 ' + (pi + 1) + ' 只消耗 ' + M.fmtNum(want) + '/s，当前接入 ' + M.fmtNum(sumRate) + '/s，多余物料会堆积。'
            });
          }
        }
      }

      for (var po = 0; po < mOuts.length; po++) {
        var okey = M.outPortKey(mn.id, po);
        if (!outFanout[okey]) {
          addIssue(res, { level: 'warn', nodeId: mn.id, portKey: okey, msg: '机器“' + mn.name + '”的输出口 ' + (po + 1) + '（' + itemNameOf(flow, mOuts[po].itemId) + '）没有连接，产物无处输出。' });
        }
      }
      if (!mIns.length && mOuts.length) {
        addIssue(res, { level: 'info', nodeId: mn.id, msg: '机器“' + mn.name + '”没有输入，将按 ' + M.fmtNum(maxCraftRate(mn)) + ' 次/s 连续产出。' });
      }
    }

    /* --- 输出端（sink）接收校验 --- */
    for (i = 0; i < nodes.length; i++) {
      var dn = nodes[i];
      if (dn.kind !== 'diamond' || dn.mode !== 'sink') continue;
      var dkey = M.inPortKey(dn.id, 0);
      var din = M.linksOfPort(flow, dn.id, 'in', 0);
      var filterId = dn.filter && dn.filter.itemId;
      if (!din.length) {
        addIssue(res, { level: 'warn', nodeId: dn.id, portKey: dkey, msg: '输出端“' + dn.name + '”没有接入任何连线。' });
        continue;
      }
      for (var di = 0; di < din.length; di++) {
        var dl = din[di];
        var dcontent = M.resolveOutPort(flow, dl.from.nodeId, dl.from.index);
        if (!dcontent || !dcontent.itemId) {
          addIssue(res, { level: 'error', linkId: dl.id, nodeId: dn.id, portKey: dkey, msg: '连接到输出端“' + dn.name + '”的上游没有输出物品。' });
          continue;
        }
        if (filterId && dcontent.itemId !== filterId) {
          addIssue(res, {
            level: 'error', linkId: dl.id, nodeId: dn.id, portKey: dkey,
            msg: '输出端“' + dn.name + '”只接受“' + itemNameOf(flow, filterId) + '”，但接入的是“' + itemNameOf(flow, dcontent.itemId) + '”。'
          });
        }
      }
    }

    /* --- 可达性：输出端是否真的能从某个输入端拿到物料 --- */
    var reach = {};
    var queue = [];
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].kind === 'diamond' && nodes[i].mode === 'source') { reach[nodes[i].id] = true; queue.push(nodes[i].id); }
    }
    while (queue.length) {
      var cur = queue.shift();
      var nxt = adj[cur] || [];
      for (var q = 0; q < nxt.length; q++) {
        if (!reach[nxt[q]]) { reach[nxt[q]] = true; queue.push(nxt[q]); }
      }
    }
    for (i = 0; i < nodes.length; i++) {
      var rn = nodes[i];
      if (rn.kind === 'diamond' && rn.mode === 'sink' && M.linksOfPort(flow, rn.id, 'in', 0).length && !reach[rn.id]) {
        addIssue(res, { level: 'warn', nodeId: rn.id, msg: '输出端“' + rn.name + '”虽然接了线，但从任何输入端都无法到达（上游没有物料来源）。' });
      }
    }

    res.issueList.sort(function (a, b) { return LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]; });
    return res;
  }

  /* ---------------------------------------------------------------- 模拟 */

  /**
   * 固定点吞吐模拟：
   *  - 输入端按 数量/tick 间隔 供料；
   *  - 机器受限于「最紧缺的输入口」，同时不超过自身 1 次/耗时tick 的产能；
   *  - 一个输出口的下游均分该输出口的流量（格雷科技中管道/总线会就近分配，这里取均分作为理论值）；
   *  - 迭代收敛（单调下降），得到每条连线的实际流量。
   */
  function simulate(flow, analysis) {
    var res = {
      ok: true, linkRate: {}, portRateIn: {}, portRateOut: {},
      machine: {}, source: {}, sink: {}, buffer: {},
      totals: { itemPerSec: 0, linkPerSec: 0, craftsPerSec: 0, bufferPerSec: 0 },
      notes: []
    };
    if (!flow) return res;
    var an = analysis || analyze(flow);
    var nodes = flow.nodes || [];
    var links = (flow.links || []).filter(function (l) { return l.__valid !== false; });
    var i, j;

    var nodeById = {};
    for (i = 0; i < nodes.length; i++) nodeById[nodes[i].id] = nodes[i];

    // 输入 / 输出端口聚合
    var linksFrom = {}, linksTo = {};
    for (i = 0; i < links.length; i++) {
      var l = links[i];
      var ok = M.outPortKey(l.from.nodeId, l.from.index);
      var ik = M.inPortKey(l.to.nodeId, l.to.index);
      (linksFrom[ok] = linksFrom[ok] || []).push(l);
      (linksTo[ik] = linksTo[ik] || []).push(l);
      res.linkRate[l.id] = 0;
    }

    // 机器产能上限
    var craft = {}, maxCraft = {};
    var bufferIds = [];
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].kind === 'machine') {
        maxCraft[nodes[i].id] = maxCraftRate(nodes[i]);
        craft[nodes[i].id] = maxCraft[nodes[i].id];
      } else if (nodes[i].kind === 'buffer') {
        bufferIds.push(nodes[i].id);
      }
    }

    // 输入端速率固定
    var outRate = {};
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.kind === 'diamond' && n.mode === 'source') {
        var r = (n.emit && n.emit.itemId) ? M.ratePerSecond(n.emit.count, n.emit.ticks) : 0;
        outRate[M.outPortKey(n.id, 0)] = r;
        res.source[n.id] = { rate: r, used: 0, itemId: (n.emit && n.emit.itemId) || '' };
      }
    }

    // 缓存器输出初值 = 分析阶段算出的「理论最大可中转量」（可信上界）
    for (i = 0; i < bufferIds.length; i++) {
      var bNode = nodeById[bufferIds[i]];
      var bPorts = M.nodePorts(bNode).outputs;
      for (j = 0; j < bPorts.length; j++) {
        var bkey = M.outPortKey(bNode.id, j);
        outRate[bkey] = (an && an.outCaps && an.outCaps[bkey] !== undefined) ? an.outCaps[bkey] : 0;
      }
    }

    // 无消耗的纯缓存器闭环：会装满堵塞，相关端口与连线一律 0 流量
    // （这里按当前 flow 重新检测，避免用到可能过期的 analysis）
    var stalled = findStalledLoops(flow);
    var stalledOutPorts = stalled.outPorts;
    var stalledInPorts = stalled.inPorts;

    /** 按当前端口输出速率算一遍全部连线流量（同时刷新 res.linkRate / portRateOut） */
    function computeFlow() {
      var inflow = {};
      res.portRateOut = {};
      for (var q = 0; q < links.length; q++) {
        var lk = links[q];
        var okey = M.outPortKey(lk.from.nodeId, lk.from.index);
        var ikey = M.inPortKey(lk.to.nodeId, lk.to.index);
        var rate;
        if (stalledOutPorts[okey] || stalledInPorts[ikey]) {
          rate = 0;                                  // 堵塞的环路：物料进不去也出不来
        } else {
          var fan = (linksFrom[okey] || []).length || 1;
          rate = (outRate[okey] || 0) / fan;
        }
        res.linkRate[lk.id] = rate;
        res.portRateOut[okey] = (res.portRateOut[okey] || 0) + rate;
        inflow[ikey] = (inflow[ikey] || 0) + rate;
      }
      return inflow;
    }

    /** 某个输入口当前的汇入速率（堵塞环路按 0） */
    function inflowOf(ikey) {
      var list = linksTo[ikey] || [];
      var sum = 0;
      for (var q = 0; q < list.length; q++) {
        var lk = list[q];
        var okey = M.outPortKey(lk.from.nodeId, lk.from.index);
        var kk = M.inPortKey(lk.to.nodeId, lk.to.index);
        if (stalledOutPorts[okey] || stalledInPorts[kk]) continue;
        var fan = (linksFrom[okey] || []).length || 1;
        sum += (outRate[okey] || 0) / fan;
      }
      return sum;
    }

    /**
     * 把缓存器「输出 = 对应输入口的汇入速率」迭代到自洽（进 = 出）。
     * 用 Gauss-Seidel（就地更新，信息当趟就能沿环传播）而不是 Jacobi：
     * 非堵塞的缓存器环每圈增益 ≤ 1/2，因此几十趟内即可收敛到 1e-9。
     * 收敛后 out == 该口的汇入速率，展示出来的「进 = 出」是严格成立的。
     */
    function settleBuffers(maxPasses) {
      var passes = Math.max(64, maxPasses || (4 * bufferIds.length + 64));
      var converged = false;
      for (var pass = 0; pass < passes; pass++) {
        var innerChanged = false;
        for (var bx = 0; bx < bufferIds.length; bx++) {
          var bId = bufferIds[bx];
          var bIns = M.nodePorts(nodeById[bId]).inputs;
          for (var bj = 0; bj < bIns.length; bj++) {
            var okey2 = M.outPortKey(bId, bj);
            if (stalledOutPorts[okey2]) {
              if ((outRate[okey2] || 0) !== 0) { outRate[okey2] = 0; innerChanged = true; }
              continue;
            }
            var nv = inflowOf(M.inPortKey(bId, bj));
            if (Math.abs((outRate[okey2] || 0) - nv) > 1e-9) innerChanged = true;
            outRate[okey2] = nv;
          }
        }
        if (!innerChanged) { converged = true; break; }
      }
      return { inflow: computeFlow(), converged: converged };
    }

    // 迭代直到收敛：每轮沿 1 条边的量传播，最长链需要 nodeCount 轮；再多留余量。
    var ITER = Math.max(64, nodes.length + 32 + bufferIds.length * 4);
    var settleRes = { inflow: computeFlow(), converged: true };
    var anyUnconverged = false;
    for (var it = 0; it < ITER; it++) {
      // 1) 端口输出速率（机器按当前产能；缓存器由内循环自洽决定）
      for (i = 0; i < nodes.length; i++) {
        var m = nodes[i];
        if (m.kind !== 'machine') continue;
        var ports = M.nodePorts(m).outputs;
        for (j = 0; j < ports.length; j++) {
          outRate[M.outPortKey(m.id, j)] = craft[m.id] * ports[j].count;
        }
      }
      // 2) 缓存器自洽（进出恒等），并得到本轮流量
      settleRes = settleBuffers();
      if (!settleRes.converged) anyUnconverged = true;
      var inflow = settleRes.inflow;
      // 3) 机器产能受输入限制
      var next = {};
      for (i = 0; i < nodes.length; i++) {
        var mc = nodes[i];
        if (mc.kind !== 'machine') continue;
        var ins = M.nodePorts(mc).inputs;
        var cap = maxCraft[mc.id];
        if (!ins.length) { next[mc.id] = cap; continue; }
        var limit = cap, why = null;
        for (j = 0; j < ins.length; j++) {
          if (!ins[j].itemId) continue;               // 未设置物品的输入口不构成限制
          if (!(ins[j].count > 0)) continue;
          var have = inflow[M.inPortKey(mc.id, j)] || 0;
          var possible = have / ins[j].count;
          if (possible < limit) { limit = possible; why = j; }
        }
        next[mc.id] = limit < 0 ? 0 : limit;
      }
      var changed = false;
      for (i = 0; i < nodes.length; i++) {
        if (nodes[i].kind !== 'machine') continue;
        if (Math.abs(next[nodes[i].id] - craft[nodes[i].id]) > 1e-7) changed = true;
        craft[nodes[i].id] = next[nodes[i].id];
      }
      if (!changed) break;
    }
    // 收尾：用最终产能再让缓存器自洽一次，保证展示出来的「进 = 出」是同一个固定点
    for (i = 0; i < nodes.length; i++) {
      var mf = nodes[i];
      if (mf.kind !== 'machine') continue;
      var fports = M.nodePorts(mf).outputs;
      for (j = 0; j < fports.length; j++) outRate[M.outPortKey(mf.id, j)] = craft[mf.id] * fports[j].count;
    }
    settleRes = settleBuffers();
    res.converged = settleRes.converged && !anyUnconverged;
    if (!res.converged) {
      res.notes.push('缓存器闭环内可能出现无法稳定的循环（弛豫未收敛），显示的速率仅供参考。');
    }

    // 汇总机器信息
    for (i = 0; i < nodes.length; i++) {
      var mm = nodes[i];
      if (mm.kind !== 'machine') continue;
      var mports = M.nodePorts(mm);
      var needR = maxCraft[mm.id];
      var limitedBy = null;
      var inRates = [];
      for (j = 0; j < mports.inputs.length; j++) {
        var h = 0;
        var inc = linksTo[M.inPortKey(mm.id, j)] || [];
        for (var c = 0; c < inc.length; c++) h += res.linkRate[inc[c].id] || 0;
        inRates.push({ index: j, itemId: mports.inputs[j].itemId, have: h, need: M.ratePerSecond(mports.inputs[j].count, mm.ticks) });
        if (mports.inputs[j].itemId) {
          if (!limitedBy || h < limitedBy.have - 1e-9) limitedBy = { index: j, have: h, need: M.ratePerSecond(mports.inputs[j].count, mm.ticks) };
        }
      }
      var eff = needR > 0 ? craft[mm.id] / needR : 0;
      var state = '待机';
      if (!mports.inputs.length) state = craft[mm.id] > 0 ? '运行（无输入配方）' : '待机';
      else if (craft[mm.id] <= 1e-9) state = '缺料';
      else if (eff >= 0.999) state = '满速运行';
      else state = '受限运行';
      var bottleneckMsg = null;
      if (limitedBy && limitedBy.have < limitedBy.need - 1e-9) {
        bottleneckMsg = '输入口 ' + (limitedBy.index + 1) + '（' + itemNameOf(flow, limitedBy.itemId) + '）：需要 ' +
          M.fmtNum(limitedBy.need) + '/s，实际 ' + M.fmtNum(limitedBy.have) + '/s';
      }
      res.machine[mm.id] = {
        craftRate: craft[mm.id], maxCraftRate: needR, efficiency: eff, state: state,
        inputs: inRates, bottleneck: bottleneckMsg,
        power: M.num(mm.power, 0), ticks: M.num(mm.ticks, 0)
      };
      res.totals.craftsPerSec += craft[mm.id];
    }

    // 输出端/输入端汇总
    for (i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      if (nd.kind !== 'diamond') continue;
      if (nd.mode === 'sink') {
        var ik2 = M.inPortKey(nd.id, 0);
        var din = linksTo[ik2] || [];
        var sum = 0, byItem = {};
        for (j = 0; j < din.length; j++) {
          var rt = res.linkRate[din[j].id] || 0;
          sum += rt;
          var ct = M.resolveOutPort(flow, din[j].from.nodeId, din[j].from.index);
          if (ct && ct.itemId) byItem[ct.itemId] = (byItem[ct.itemId] || 0) + rt;
        }
        res.sink[nd.id] = { intake: sum, byItem: byItem };
        res.portRateIn[ik2] = sum;
      } else {
        var ok2 = M.outPortKey(nd.id, 0);
        var used = res.portRateOut[ok2] || 0;
        if (res.source[nd.id]) res.source[nd.id].used = used;
        res.portRateOut[ok2] = used;
      }
    }

    // 缓存器中转统计：进出速率恒等（relay = 该输入口的汇入速率）
    for (i = 0; i < nodes.length; i++) {
      var bnode = nodes[i];
      if (bnode.kind !== 'buffer') continue;
      var bPorts = M.nodePorts(bnode);
      var portsInfo = [];
      var totalIn = 0, totalOut = 0, totalRelay = 0, unconnected = 0;
      for (j = 0; j < bPorts.inputs.length; j++) {
        var inKey = M.inPortKey(bnode.id, j);
        var outKey = M.outPortKey(bnode.id, j);
        var inc = linksTo[inKey] || [];
        var inRate = 0;
        for (var c2 = 0; c2 < inc.length; c2++) inRate += res.linkRate[inc[c2].id] || 0;
        var outLinks = linksFrom[outKey] || [];
        var outRateSum = 0;
        for (var c3 = 0; c3 < outLinks.length; c3++) outRateSum += res.linkRate[outLinks[c3].id] || 0;
        // 中转量 = 该输入口收到的速率（进出恒等）；实际输出 = 下游连线之和
        var relay = outRate[outKey] || 0;
        if (!outLinks.length) unconnected++;
        totalIn += inRate;
        totalOut += outRateSum;
        totalRelay += relay;
        portsInfo.push({
          index: j, itemId: bPorts.inputs[j].itemId,
          inRate: inRate, outRate: outRateSum, relay: relay, outFanout: outLinks.length,
          connected: outLinks.length > 0
        });
      }
      res.buffer[bnode.id] = {
        ports: portsInfo, totalIn: totalIn, totalOut: totalOut, totalRelay: totalRelay,
        unconnectedOuts: unconnected, itemCount: portsInfo.length
      };
      res.totals.bufferPerSec = (res.totals.bufferPerSec || 0) + totalIn;
    }

    for (i = 0; i < links.length; i++) res.totals.linkPerSec += res.linkRate[links[i].id] || 0;
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].kind === 'diamond' && nodes[i].mode === 'sink') {
        res.totals.itemPerSec += (res.sink[nodes[i].id] && res.sink[nodes[i].id].intake) || 0;
      }
    }

    // 提示
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].kind === 'diamond' && nodes[i].mode === 'source' && res.source[nodes[i].id]) {
        var src = res.source[nodes[i].id];
        if (src.rate > 0 && src.used < src.rate - 1e-9) {
          res.notes.push('输入端“' + nodes[i].name + '”产出 ' + M.fmtNum(src.rate) + '/s，下游只消耗 ' + M.fmtNum(src.used) + '/s，多余物料会堵塞输入端。');
        }
      }
      if (nodes[i].kind === 'machine' && res.machine[nodes[i].id]) {
        var mi = res.machine[nodes[i].id];
        if (mi.efficiency < 0.999 && M.nodePorts(nodes[i]).inputs.length && mi.craftRate > 0) {
          res.notes.push('机器“' + nodes[i].name + '”效率 ' + Math.round(mi.efficiency * 100) + '%，瓶颈：' + (mi.bottleneck || '未知'));
        }
      }
    }

    res.ok = an.counts.error === 0;
    return res;
  }

  /* ------------------------------------------------------------ 自动排版 */

  function uniq(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      if (seen[arr[i]]) continue;
      seen[arr[i]] = true;
      out.push(arr[i]);
    }
    return out;
  }

  /**
   * 计算「第 N 步」：对每个节点取它到任意输入口（物料源）的最短连线长度。
   *  - 种子（第 0 步）：所有「输入端（物料源）」以及**没有任何上游连线**的节点
   *    （例如没有输入配方的自发产出机器，它们本身就是物料起点）；
   *  - 其余节点 = BFS 最短距离（与需求一致：按最短链接长度分步，而不是最长路径）；
   *  - 无法从任何起点到达的节点（例如没有上游来源的纯环路）单独归为最后一列。
   * 返回 { stepOf, layers, maxStep, unreachable, seeds }，不修改 flow。
   */
  function computeLayers(flow) {
    var nodes = (flow && flow.nodes) || [];
    var links = (flow && flow.links) || [];
    var byId = {};
    for (var i = 0; i < nodes.length; i++) byId[nodes[i].id] = nodes[i];

    var out = {}, inc = {};
    for (var l = 0; l < links.length; l++) {
      var link = links[l];
      if (!byId[link.from.nodeId] || !byId[link.to.nodeId]) continue;
      (out[link.from.nodeId] = out[link.from.nodeId] || []).push(link.to.nodeId);
      (inc[link.to.nodeId] = inc[link.to.nodeId] || []).push(link.from.nodeId);
    }

    var stepOf = {};
    var seeds = [];
    var queue = [];
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      var isSource = node.kind === 'diamond' && node.mode === 'source';
      var noUpstream = !(inc[node.id] && inc[node.id].length);
      if (isSource || noUpstream) {
        stepOf[node.id] = 0;
        seeds.push(node.id);
        queue.push(node.id);
      }
    }
    // 单位权 BFS：首次到达即最短距离
    var qi = 0;
    while (qi < queue.length) {
      var cur = queue[qi++];
      var next = out[cur] || [];
      for (var k = 0; k < next.length; k++) {
        if (stepOf[next[k]] === undefined) {
          stepOf[next[k]] = stepOf[cur] + 1;
          queue.push(next[k]);
        }
      }
    }

    var unreachable = [];
    var maxStep = 0;
    for (var m = 0; m < nodes.length; m++) {
      if (stepOf[nodes[m].id] === undefined) {
        unreachable.push(nodes[m].id);
      } else if (stepOf[nodes[m].id] > maxStep) {
        maxStep = stepOf[nodes[m].id];
      }
    }
    if (unreachable.length) {
      var lastStep = maxStep + 1;
      for (var u = 0; u < unreachable.length; u++) stepOf[unreachable[u]] = lastStep;
      maxStep = lastStep;
    }

    var layers = [];
    for (var s = 0; s <= maxStep; s++) layers.push([]);
    for (var p = 0; p < nodes.length; p++) layers[stepOf[nodes[p].id]].push(nodes[p].id);

    return {
      stepOf: stepOf, layers: layers, maxStep: maxStep,
      unreachable: unreachable, seeds: seeds, byId: byId
    };
  }

  /**
   * 按「第 N 步」自动排版：第 N 步的节点排在第 N 列，列内再用「相邻列重心」
   * 做几轮排序以减少连线交叉，最后整列垂直居中、整体居中于原点并按网格吸附。
   * 直接修改 node.x / node.y，返回统计信息供界面提示。
   */
  function autoLayout(flow, opts) {
    opts = opts || {};
    var nodes = (flow && flow.nodes) || [];
    var links = (flow && flow.links) || [];
    if (!nodes.length) return { moved: 0, columns: 0, maxStep: 0, seeds: 0, unreachable: 0, layers: [] };

    var info = computeLayers(flow);
    var byId = info.byId;
    var orderIdx = {};
    nodes.forEach(function (n, i) { orderIdx[n.id] = i; });

    var preds = {}, succs = {};
    links.forEach(function (l) {
      if (!byId[l.from.nodeId] || !byId[l.to.nodeId]) return;
      (succs[l.from.nodeId] = succs[l.from.nodeId] || []).push(l.to.nodeId);
      (preds[l.to.nodeId] = preds[l.to.nodeId] || []).push(l.from.nodeId);
    });
    Object.keys(preds).forEach(function (k) { preds[k] = uniq(preds[k]); });
    Object.keys(succs).forEach(function (k) { succs[k] = uniq(succs[k]); });

    var layers = info.layers.map(function (c) { return c.slice(); });
    var pos = {};
    layers.forEach(function (col) { col.forEach(function (id, i) { pos[id] = i; }); });

    var rowGap = M.num(opts.rowGap, 60, 10, 5000);
    var colGap = M.num(opts.columnGap, 150, 20, 5000);
    var sweeps = M.num(opts.sweeps, 4, 0, 40);

    function bary(id, map) {
      var arr = map[id];
      var cur = pos[id] === undefined ? 0 : pos[id];
      if (!arr || !arr.length) return cur;
      var s = 0, c = 0;
      for (var i = 0; i < arr.length; i++) {
        if (pos[arr[i]] === undefined) continue;
        s += pos[arr[i]];
        c++;
      }
      return c ? s / c : cur;
    }
    function sortCol(col, map) {
      var base = {};
      col.forEach(function (id) { base[id] = pos[id] === undefined ? 0 : pos[id]; });
      col.sort(function (a, b) {
        var ba = bary(a, map), bb = bary(b, map);
        if (Math.abs(ba - bb) > 1e-6) return ba - bb;
        if (Math.abs(base[a] - base[b]) > 1e-6) return base[a] - base[b];
        return orderIdx[a] - orderIdx[b];
      });
      col.forEach(function (id, i) { pos[id] = i; });
    }
    for (var it = 0; it < sweeps; it++) {
      for (var f = 1; f <= info.maxStep; f++) sortCol(layers[f], preds);
      for (var b = info.maxStep - 1; b >= 0; b--) sortCol(layers[b], succs);
    }

    // x：列内按最宽节点计算列宽，依次排开
    var colWidth = layers.map(function (col) {
      var w = 0;
      col.forEach(function (id) { w = Math.max(w, M.nodeBounds(byId[id]).w); });
      return w;
    });
    var colCenter = [];
    var x = M.num(opts.originX, 0);
    layers.forEach(function (col, s) {
      colCenter[s] = x + colWidth[s] / 2;
      x += colWidth[s] + colGap;
    });

    // y：每列内部按顺序堆叠，并以同一水平中线垂直居中
    var centerY = M.num(opts.originY, 0);
    layers.forEach(function (col, s) {
      var total = 0;
      col.forEach(function (id, i) {
        total += M.nodeBounds(byId[id]).h;
        if (i) total += rowGap;
      });
      var y = centerY - total / 2;
      col.forEach(function (id) {
        var b = M.nodeBounds(byId[id]);
        byId[id].x = colCenter[s];
        byId[id].y = y + b.h / 2;
        y += b.h + rowGap;
      });
    });

    // 整体居中到世界原点，便于「适应视图」
    if (opts.center !== false) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(function (n) {
        var b = M.nodeBounds(n);
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
      });
      var dx = -(minX + maxX) / 2, dy = -(minY + maxY) / 2;
      nodes.forEach(function (n) { n.x += dx; n.y += dy; });
    }

    // 网格吸附（默认开启），便于手工继续微调
    if (opts.snap !== false) {
      nodes.forEach(function (n) {
        n.x = Math.round(n.x / M.GRID) * M.GRID;
        n.y = Math.round(n.y / M.GRID) * M.GRID;
      });
    }

    return {
      moved: nodes.length,
      columns: layers.length,
      maxStep: info.maxStep,
      seeds: info.seeds.length,
      unreachable: info.unreachable.length,
      layers: layers
    };
  }

  return {
    LEVEL_ORDER: LEVEL_ORDER,
    emptyAnalysis: emptyAnalysis,
    analyze: analyze,
    simulate: simulate,
    maxCraftRate: maxCraftRate,
    tarjanSCC: tarjanSCC,
    computeLayers: computeLayers,
    autoLayout: autoLayout
  };
});
