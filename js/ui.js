/* ============================================================================
 * GT 产线模拟器 — ui.js
 * 左侧栏 / 属性面板 / 配方编辑器 / 弹窗 / 工具栏 / 快捷键 / 状态提示
 * ==========================================================================*/
(function (root, factory) {
  'use strict';
  var api = factory(
    root.GT && root.GT.model, root.GT && root.GT.graph, root.GT && root.GT.store,
    root.GT && root.GT.presets, root.GT && root.GT.canvas
  );
  root.GT = root.GT || {};
  root.GT.ui = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M, G, S, PS, CV) {
  'use strict';
  if (!M || !S || !PS || !CV) throw new Error('ui.js 依赖未加载完整');

  var DND_TYPE = 'application/gtline-node';
  var ctxMenuEl = null;
  var inspectorBusy = false;

  /* --------------------------------------------------------------- 小工具 */

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'style') n.setAttribute('style', v);
        else if (k === 'dataset') { Object.keys(v).forEach(function (d) { n.dataset[d] = v[d]; }); }
        else if (k.indexOf('on') === 0 && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v === true) n.setAttribute(k, '');
        else n.setAttribute(k, v);
      });
    }
    appendChildren(n, children);
    return n;
  }

  function appendChildren(n, children) {
    if (children === null || children === undefined) return;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }

  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function icon(name) {
    var map = {
      new: '✚', open: '📂', save: '💾', saveas: '🗋', import: '⬇', export: '⬆',
      undo: '↶', redo: '↷', play: '▶', pause: '⏸', reset: '⟲', fit: '⤢',
      zin: '＋', zout: '－', items: '📦', presets: '🔖', help: '？', panel: '☰',
      grid: '▦', snap: '⊞', machine: '🏭', source: '▷', sink: '◁', close: '✕',
      trash: '🗑', dup: '⧉', edit: '✎', up: '↑', down: '↓', link: '⇢', backup: '🗄'
    };
    return map[name] || name;
  }

  function tbtn(label, title, handler, cls) {
    return el('button', { class: 'btn ' + (cls || ''), title: title, onclick: handler }, label);
  }

  function toast(level, text) {
    var root = $('toastRoot');
    if (!root) return;
    var node = el('div', { class: 'toast toast-' + (level || 'info') }, [
      el('span', { class: 'toast-icon', text: level === 'error' ? '⚠' : (level === 'warn' ? '!' : 'i') }),
      el('span', { class: 'toast-text', text: text })
    ]);
    root.appendChild(node);
    setTimeout(function () { node.classList.add('show'); }, 10);
    var life = level === 'error' ? 8000 : (level === 'warn' ? 6000 : 3500);
    setTimeout(function () {
      node.classList.remove('show');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 300);
    }, life);
    node.addEventListener('click', function () { if (node.parentNode) node.parentNode.removeChild(node); });
  }

  /* ------------------------------------------------------------------ 弹窗 */

  function openModal(opts) {
    var root = $('modalRoot');
    var body = el('div', { class: 'modal-body' });
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) appendChildren(body, opts.body);

    var footer = null;
    if (opts.actions && opts.actions.length) {
      footer = el('div', { class: 'modal-footer' });
      opts.actions.forEach(function (a) {
        footer.appendChild(el('button', {
          class: 'btn ' + (a.cls || ''),
          onclick: function () { if (!a.onClick || a.onClick() !== false) close(); }
        }, a.label));
      });
    }

    var box = el('div', { class: 'modal' + (opts.wide ? ' modal-wide' : '') }, [
      el('div', { class: 'modal-head' }, [
        el('span', { class: 'modal-title', text: opts.title || '' }),
        el('button', { class: 'btn btn-icon modal-close', title: '关闭', onclick: function () { close(); } }, '✕')
      ]),
      body,
      footer
    ]);
    var back = el('div', { class: 'modal-back' }, [box]);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });

    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (back.parentNode) back.parentNode.removeChild(back);
    }
    document.addEventListener('keydown', onKey, true);
    root.appendChild(back);
    setTimeout(function () { back.classList.add('show'); }, 10);
    var first = box.querySelector('input,select,textarea,button');
    if (first && opts.focus !== false) first.focus();
    return { close: close, box: box, body: body };
  }

  function confirmModal(title, message, onYes, yesLabel) {
    openModal({
      title: title,
      body: el('div', { class: 'confirm-text', text: message }),
      actions: [
        { label: '取消', cls: 'btn-ghost' },
        { label: yesLabel || '确定', cls: 'btn-danger', onClick: onYes }
      ]
    });
  }

  /* --------------------------------------------------------------- 建立节点 */

  function newNode(kind, opts) {
    var world = (opts && opts.world) || CV.centerWorld();
    var node;
    if (kind === 'machine') node = M.makeMachine({ name: nextName('机器'), x: world.x, y: world.y });
    else if (kind === 'buffer') node = M.makeBuffer({ name: nextName('缓存器'), x: world.x, y: world.y });
    else if (kind === 'source') node = M.makeDiamond('source', { name: nextName('输入端'), x: world.x, y: world.y });
    else if (kind === 'sink') node = M.makeDiamond('sink', { name: nextName('输出端'), x: world.x, y: world.y });
    else return null;
    var size = M.nodeSize(node);
    var spot = CV.findFreeSpot(world, size);
    node.x = Math.round(spot.x / M.GRID) * M.GRID;
    node.y = Math.round(spot.y / M.GRID) * M.GRID;
    var label = kind === 'machine' ? '机器' : (kind === 'buffer' ? '缓存器' : '接口块');
    S.mutate('添加' + label, function () { S.state.flow.nodes.push(node); });
    S.selectNodes([node.id], false);
    toast('info', '已添加：' + node.name);
    return node;
  }

  function nextName(base) {
    var used = S.state.flow.nodes.map(function (n) { return n.name; });
    return M.uniqueName(base, used);
  }

  function addPresetInstance(preset, world) {
    if (preset.type === 'item') {
      S.mutate('添加物品', function () { M.ensureItem(S.state.flow, preset.item); });
      toast('info', '物品预设“' + preset.name + '”已加入当前流程的物品库。');
      renderAll();
      return null;
    }
    var target = world || CV.centerWorld();
    var probe = PS.instantiate(M.deepClone(S.state.flow), preset, target.x, target.y);
    if (!probe) { toast('warn', '该预设无法实例化。'); return null; }
    var size = M.nodeSize(probe);
    var spot = CV.findFreeSpot(target, size);
    probe.x = Math.round(spot.x / M.GRID) * M.GRID;
    probe.y = Math.round(spot.y / M.GRID) * M.GRID;
    var created = null;
    S.mutate('使用预设', function () {
      created = PS.instantiate(S.state.flow, preset, probe.x, probe.y);
      if (created) S.state.flow.nodes.push(created);
    });
    if (created) {
      S.selectNodes([created.id], false);
      toast('info', '已按预设创建：' + created.name);
    }
    renderAll();
    return created;
  }

  /* -------------------------------------------------------------- 左侧栏 */

  function dndChip(label, payload, cls, hint) {
    var chip = el('div', {
      class: 'chip ' + (cls || ''),
      draggable: 'true',
      title: hint || ('拖到画布放置：' + label),
      onclick: function () { handlePaletteClick(payload); }
    }, [
      el('span', { class: 'chip-label', text: label })
    ]);
    chip.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData(DND_TYPE, JSON.stringify(payload));
      e.dataTransfer.setData('text/plain', JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'copy';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', function () { chip.classList.remove('dragging'); });
    return chip;
  }

  function handlePaletteClick(payload) {
    if (payload.t === 'preset') {
      var p = PS.get(payload.id);
      if (p) addPresetInstance(p);
      return;
    }
    newNode(payload.t === 'source' ? 'source' : (payload.t === 'sink' ? 'sink' : (payload.t === 'buffer' ? 'buffer' : 'machine')));
  }

  function renderPalette() {
    var root = $('palette');
    clear(root);

    root.appendChild(el('div', { class: 'pal-section' }, [
      el('div', { class: 'pal-title' }, [
        el('span', { text: '输出 / 输入' }),
        el('span', { class: 'pal-hint', text: '菱形 · 各 1 个口' })
      ]),
      el('div', { class: 'pal-chips' }, [
        dndChip('输入端（物料源）', { t: 'source' }, 'chip-source', '菱形输出口：从产线外部输入物品'),
        dndChip('输出端（物料汇）', { t: 'sink' }, 'chip-sink', '菱形输入口：把产物送出产线')
      ])
    ]));

    root.appendChild(el('div', { class: 'pal-section' }, [
      el('div', { class: 'pal-title' }, [
        el('span', { text: '机器' }),
        el('span', { class: 'pal-hint', text: '白板矩形 / 正方形' })
      ]),
      el('div', { class: 'pal-chips' }, [
        dndChip('机器（白板）', { t: 'machine' }, 'chip-machine', '矩形：名称 + 耗电 + 耗时 + 手动配方'),
        dndChip('缓存器（正方形）', { t: 'buffer' }, 'chip-buffer', '正方形：只配输入，输出强制与输入相同；可打破循环连接')
      ])
    ]));

    // 物品库
    var items = S.state.flow.items;
    var itemList = el('div', { class: 'pal-list' });
    if (!items.length) {
      itemList.appendChild(el('div', { class: 'pal-empty', text: '还没有物品，点击下方新建。' }));
    }
    items.forEach(function (it) {
      var usage = countItemUsage(it.id);
      itemList.appendChild(el('div', { class: 'pal-item', title: it.name + ' · ' + (M.STATE_LABEL[it.state] || '') }, [
        el('span', { class: 'dot', style: 'background:' + it.color }),
        el('span', { class: 'pal-item-name', text: it.name }),
        el('span', { class: 'badge ' + (it.state === M.FLUID ? 'badge-fluid' : 'badge-solid'), text: it.state === M.FLUID ? '流体' : '固体' }),
        el('span', { class: 'pal-item-use', text: usage ? ('×' + usage) : '' })
      ]));
    });
    root.appendChild(el('div', { class: 'pal-section' }, [
      el('div', { class: 'pal-title' }, [
        el('span', { text: '物品库' }),
        el('span', { class: 'pal-hint', text: items.length + ' 个' })
      ]),
      itemList,
      el('div', { class: 'pal-actions' }, [
        el('button', { class: 'btn btn-mini', onclick: function () { openItemModal(); } }, '管理物品'),
        el('button', { class: 'btn btn-mini', onclick: function () { promptNewItem(function () { renderAll(); }); } }, '＋ 新建')
      ])
    ]));

    // 预设
    var presetSections = el('div', { class: 'pal-list' });
    var any = false;
    PS.TYPE_ORDER.forEach(function (type) {
      var list = PS.list(type);
      if (!list.length) return;
      any = true;
      presetSections.appendChild(el('div', { class: 'pal-subtitle', text: PS.TYPE_LABEL[type] + '（' + list.length + '）' }));
      list.forEach(function (p) {
        presetSections.appendChild(dndChip(p.name, { t: 'preset', id: p.id }, 'chip-preset chip-preset-' + p.type,
          '预设：' + p.name + '（' + PS.TYPE_LABEL[p.type] + '）'));
      });
    });
    if (!any) presetSections.appendChild(el('div', { class: 'pal-empty', text: '预设库为空。选中节点后点“存为预设”，或导入预设文件。所有流程共用同一份预设库。' }));

    root.appendChild(el('div', { class: 'pal-section' }, [
      el('div', { class: 'pal-title' }, [
        el('span', { text: '预设' }),
        el('span', { class: 'pal-hint', text: '独立文件' })
      ]),
      presetSections,
      el('div', { class: 'pal-actions' }, [
        el('button', { class: 'btn btn-mini', onclick: openPresetModal }, '管理预设'),
        el('button', { class: 'btn btn-mini', onclick: function () { PS.exportFile(); toast('info', '预设库已导出为独立文件。'); } }, '导出'),
        el('button', { class: 'btn btn-mini', onclick: function () { pickFile('.json', function (text) { importPresetText(text); }); } }, '导入')
      ])
    ]));
  }

  function countItemUsage(itemId) {
    var n = 0;
    S.state.flow.nodes.forEach(function (node) {
      if (node.kind === 'diamond') {
        if (node.emit && node.emit.itemId === itemId) n++;
        if (node.filter && node.filter.itemId === itemId) n++;
      } else if (node.kind === 'machine' && node.recipe) {
        (node.recipe.inputs || []).forEach(function (r) { if (r.itemId === itemId) n++; });
        (node.recipe.outputs || []).forEach(function (r) { if (r.itemId === itemId) n++; });
      } else if (node.kind === 'buffer' && node.recipe) {
        (node.recipe.inputs || []).forEach(function (r) { if (r.itemId === itemId) n++; });
      }
    });
    return n;
  }

  /* ------------------------------------------------------------ 属性面板 */

  function inspectorHasFocus() {
    var box = $('inspector');
    var a = document.activeElement;
    if (!box || !a) return false;
    if (!box.contains(a)) return false;
    var t = (a.tagName || '').toLowerCase();
    return t === 'input' || t === 'textarea' || t === 'select' || a.isContentEditable;
  }

  /** 绑定一个“可撤销的文本/数字编辑”控件 */
  function bindEdit(input, apply, label, opts) {
    opts = opts || {};
    var before = null;
    input.addEventListener('focus', function () { before = S.beginDrag(); });
    input.addEventListener('input', function () {
      var v = input.value;
      apply(opts.number ? M.num(v, opts.def || 0, opts.min, opts.max) : v, true);
      S.refresh();
      S.emit('change', { label: label + '(输入中)' });
      if (opts.number && opts.echo) opts.echo(input);
    });
    var commit = function () {
      if (opts.number) {
        var nv = M.num(input.value, opts.def || 0, opts.min, opts.max);
        apply(nv, true);
        input.value = String(nv);
      }
      if (before) { S.commitDrag(before, label); before = null; }
      else { S.refresh(); S.emit('change', { label: label }); }
      renderAll();
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { input.blur(); }
      e.stopPropagation();
    });
    return input;
  }

  function field(label, control, hint) {
    return el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: label }),
      control,
      hint ? el('div', { class: 'field-hint', text: hint }) : null
    ]);
  }

  function itemSelect(value, onChange, allowEmpty) {
    var sel = el('select', { class: 'input' });
    sel.appendChild(el('option', { value: '', text: allowEmpty ? '— 未设置（任意） —' : '— 请选择物品 —' }));
    var groups = { solid: el('optgroup', { label: '固体' }), fluid: el('optgroup', { label: '流体' }) };
    S.state.flow.items.forEach(function (it) {
      var o = el('option', { value: it.id, text: it.name + (it.note ? (' · ' + it.note) : '') });
      (it.state === M.FLUID ? groups.fluid : groups.solid).appendChild(o);
    });
    if (groups.solid.childNodes.length) sel.appendChild(groups.solid);
    if (groups.fluid.childNodes.length) sel.appendChild(groups.fluid);
    sel.appendChild(el('option', { value: '__new__', text: '＋ 新建物品…' }));
    sel.value = value || '';
    sel.addEventListener('change', function () {
      if (sel.value === '__new__') {
        promptNewItem(function (item) {
          onChange(item ? item.id : value);
          renderAll();
        });
        sel.value = value || '';
        return;
      }
      onChange(sel.value);
    });
    return sel;
  }

  function renderInspector() {
    var box = $('inspector');
    if (!box) return;
    if (inspectorBusy) return;
    inspectorBusy = true;
    try {
      buildInspector(box);
    } finally {
      inspectorBusy = false;
    }
  }

  function buildInspector(box) {
    clear(box);
    var sel = S.state.selection;
    var nodes = S.selectedNodes();
    var links = S.selectedLinks();

    if (nodes.length === 1 && links.length === 0) {
      box.classList.remove('hidden');
      if (nodes[0].kind === 'machine') buildMachineForm(box, nodes[0]);
      else if (nodes[0].kind === 'buffer') buildBufferForm(box, nodes[0]);
      else buildDiamondForm(box, nodes[0]);
      return;
    }
    if (links.length === 1 && nodes.length === 0) {
      box.classList.remove('hidden');
      buildLinkForm(box, links[0]);
      return;
    }
    if (nodes.length > 1 || links.length > 1 || (nodes.length && links.length)) {
      box.classList.remove('hidden');
      buildMultiForm(box, nodes, links);
      return;
    }
    box.classList.add('hidden');
  }

  function inspectorHead(box, title, subtitle, node) {
    var sub = subtitle || '';
    if (node) {
      var st = stepOfNode(node.id);
      if (st !== undefined) sub += (sub ? ' · ' : '') + '距输入端第 ' + st + ' 步';
    }
    box.appendChild(el('div', { class: 'insp-head' }, [
      el('div', {}, [
        el('div', { class: 'insp-title', text: title }),
        sub ? el('div', { class: 'insp-sub', text: sub }) : null
      ]),
      el('button', { class: 'btn btn-icon', title: '取消选中', onclick: function () { S.clearSelection(); } }, '✕')
    ]));
    if (node) {
      var ni = S.state.analysis.nodeIssues[node.id];
      if (ni && ni.msgs.length) {
        box.appendChild(el('div', { class: 'insp-issues ' + (ni.level === 'error' ? 'is-error' : 'is-warn') },
          ni.msgs.map(function (m) { return el('div', { class: 'insp-issue', text: m }); })));
      }
    }
  }

  function buildMachineForm(box, node) {
    inspectorHead(box, node.name || '机器', '机器 · 白板矩形 · 输入口 ' + node.recipe.inputs.length + ' / 输出口 ' + node.recipe.outputs.length, node);

    var nameInput = el('input', { class: 'input', value: node.name, maxlength: '40' });
    bindEdit(nameInput, function (v) { node.name = v; }, '机器名称');
    box.appendChild(field('名称', nameInput));

    var powerInput = el('input', { class: 'input', type: 'number', min: '0', step: '1', value: node.power });
    bindEdit(powerInput, function (v) { node.power = v; }, '耗电量', { number: true, def: 0, min: 0 });
    box.appendChild(field('耗电量（EU/t）', powerInput, '1 tick 消耗的能量；工作栏右上角会累加所有机器。'));

    var tickInput = el('input', { class: 'input', type: 'number', min: '1', step: '1', value: node.ticks });
    var secHint = el('div', { class: 'field-hint', text: '= ' + M.fmtNum(node.ticks / M.TICKS_PER_SECOND) + ' 秒（20 tick = 1 s）' });
    var ti = bindEdit(tickInput, function (v) {
      node.ticks = v;
      secHint.textContent = '= ' + M.fmtNum(v / M.TICKS_PER_SECOND) + ' 秒（20 tick = 1 s）';
    }, '耗时', { number: true, def: M.TICKS_PER_SECOND, min: 1 });
    box.appendChild(el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '耗时（tick）' }), ti, secHint]));

    box.appendChild(el('div', { class: 'field-row' }, [
      el('button', { class: 'btn', onclick: function () { saveNodeAsPreset(node); } }, '存为预设'),
      el('button', { class: 'btn btn-ghost', onclick: function () { duplicateNode(node); } }, '复制节点'),
      el('button', { class: 'btn btn-danger', onclick: function () { S.removeNodes([node.id]); renderAll(); } }, '删除')
    ]));

    // 配方编辑器
    box.appendChild(el('div', { class: 'section-title' }, [
      el('span', { text: '配方（顺序 = 端口顺序）' }),
      el('span', { class: 'hint', text: '手动添加' })
    ]));
    box.appendChild(recipeEditor(node, 'inputs', '输入口', '每条配方输入对应机器左侧 1 个输入口'));
    box.appendChild(recipeEditor(node, 'outputs', '输出口', '每条配方输出对应机器右侧 1 个输出口'));

    box.appendChild(el('div', { class: 'section-title' }, [el('span', { text: '位置' })]));
    box.appendChild(coordsRow(node));
  }

  function coordsRow(node) {
    var xi = el('input', { class: 'input input-sm', type: 'number', step: '1', value: Math.round(node.x) });
    var yi = el('input', { class: 'input input-sm', type: 'number', step: '1', value: Math.round(node.y) });
    bindEdit(xi, function (v) { node.x = v; }, '位置X', { number: true, def: 0 });
    bindEdit(yi, function (v) { node.y = v; }, '位置Y', { number: true, def: 0 });
    return el('div', { class: 'field-row' }, [
      el('div', { class: 'inline-field' }, [el('span', { class: 'inline-label', text: 'X' }), xi]),
      el('div', { class: 'inline-field' }, [el('span', { class: 'inline-label', text: 'Y' }), yi])
    ]);
  }

  function recipeEditor(node, side, title, hint) {
    var list = node.recipe[side];
    var wrap = el('div', { class: 'recipe-editor' });
    wrap.appendChild(el('div', { class: 'recipe-head' }, [
      el('span', { class: 'recipe-title', text: title + '（' + list.length + '）' }),
      el('span', { class: 'recipe-hint', text: hint })
    ]));

    if (!list.length) {
      wrap.appendChild(el('div', { class: 'pal-empty', text: '暂无' + title + '，点击下方按钮添加。' }));
    }

    list.forEach(function (line, idx) {
      var row = el('div', { class: 'recipe-row' });
      row.appendChild(el('span', { class: 'recipe-idx', text: String(idx + 1) }));
      row.appendChild(itemSelect(line.itemId, function (v) {
        S.mutate('配方物品', function () { line.itemId = v; });
        renderInspector();
      }, false));
      var cnt = el('input', { class: 'input input-count', type: 'number', min: '1', step: '1', value: line.count, title: '每个配方周期的数量' });
      bindEdit(cnt, function (v) { line.count = v; }, '配方数量', { number: true, def: 1, min: 1 });
      row.appendChild(cnt);
      row.appendChild(el('div', { class: 'recipe-btns' }, [
        el('button', { class: 'btn btn-icon', title: '上移', disabled: idx === 0, onclick: function () { moveRecipe(node, side, idx, -1); } }, '↑'),
        el('button', { class: 'btn btn-icon', title: '下移', disabled: idx === list.length - 1, onclick: function () { moveRecipe(node, side, idx, 1); } }, '↓'),
        el('button', { class: 'btn btn-icon btn-danger', title: '删除该条', onclick: function () { removeRecipe(node, side, idx); } }, '✕')
      ]));
      wrap.appendChild(row);
    });

    wrap.appendChild(el('div', { class: 'recipe-add' }, [
      el('button', {
        class: 'btn btn-mini', onclick: function () {
          S.mutate('添加配方行', function () { list.push(M.makeRecipeLine('', 1)); });
          renderAll();
        }
      }, '＋ 添加' + title),
      el('button', {
        class: 'btn btn-mini', title: '清空该侧配方（该侧端口上的连线会一并移除）', onclick: function () {
          var links = 0;
          for (var k = 0; k < list.length; k++) links += M.recipeRowLinks(S.state.flow, node, side, k).length;
          var doIt = function () {
            var removed = 0;
            S.mutate('清空' + title, function () { removed = M.clearRecipeSide(S.state.flow, node, side); });
            toast('info', '已清空' + title + (removed ? '，同时移除 ' + removed + ' 条相关连线。' : '。'));
            renderAll();
          };
          if (links) confirmModal('清空' + title, '该侧端口上有 ' + links + ' 条连线，清空配方后这些连线也会被移除。确定继续？', doIt);
          else if (list.length) confirmModal('清空' + title, '确定清空全部 ' + list.length + ' 条' + title + '配方行？', doIt);
        }
      }, '清空')
    ]));
    return wrap;
  }

  function moveRecipe(node, side, idx, delta) {
    var moved = false;
    S.mutate('调整配方顺序', function () {
      moved = M.moveRecipeRow(S.state.flow, node, side, idx, delta);
    });
    if (moved) renderAll();
  }

  function removeRecipe(node, side, idx) {
    var affected = M.recipeRowLinks(S.state.flow, node, side, idx).length;
    var doIt = function () {
      var dropped = 0;
      S.mutate('删除配方行', function () {
        var r = M.removeRecipeRow(S.state.flow, node, side, idx);
        dropped = r.dropped.length;
      });
      if (dropped) toast('info', '已删除配方行，同时移除 ' + dropped + ' 条连线。');
      renderAll();
    };
    if (affected) confirmModal('删除配方行', '该端口上有 ' + affected + ' 条连线，删除后这些连线也会被移除。确定继续？', doIt);
    else doIt();
  }

  /** 缓存器：只配输入；输出强制镜像输入（界面只读展示） */
  function buildBufferForm(box, node) {
    var nIn = node.recipe.inputs.length;
    inspectorHead(box, node.name || '缓存器', '缓存器 · 白板正方形 · ' + nIn + ' 进 / ' + nIn + ' 出（输出强制与输入一致）', node);

    var nameInput = el('input', { class: 'input', value: node.name, maxlength: '40' });
    bindEdit(nameInput, function (v) { node.name = v; }, '缓存器名称');
    box.appendChild(field('名称', nameInput));

    box.appendChild(el('div', { class: 'hint-block' }, [
      el('div', { text: '· 输出口数量与输入口一一对应：第 i 个输出口输出的物品强制等于第 i 个输入口。' }),
      el('div', { text: '· 进出速率恒等：每条通道的总输入速率恰好等于它的总输出速率（缓存器只做中转，不改变数量）。' }),
      el('div', { text: '· 缓存器可以提供缓冲，因此把它接进环路就能实现循环连接；两台机器直接互连成环仍会报错。' })
    ]));

    box.appendChild(el('div', { class: 'field-row' }, [
      el('button', { class: 'btn', onclick: function () { saveNodeAsPreset(node); } }, '存为预设'),
      el('button', { class: 'btn btn-ghost', onclick: function () { duplicateNode(node); } }, '复制节点'),
      el('button', { class: 'btn btn-danger', onclick: function () { S.removeNodes([node.id]); renderAll(); } }, '删除')
    ]));

    box.appendChild(el('div', { class: 'section-title' }, [
      el('span', { text: '输入（顺序 = 输入口顺序）' }),
      el('span', { class: 'hint', text: '输出自动镜像' })
    ]));
    var wrap = el('div', { class: 'recipe-editor' });
    var list = node.recipe.inputs;
    if (!list.length) {
      wrap.appendChild(el('div', { class: 'pal-empty', text: '暂无输入：点下面的按钮添加一条，输出会立刻同步出对应的输出口。' }));
    }
    list.forEach(function (line, idx) {
      var row = el('div', { class: 'recipe-row' });
      row.appendChild(el('span', { class: 'recipe-idx', text: String(idx + 1) }));
      row.appendChild(itemSelect(line.itemId, function (v) {
        S.mutate('缓存器输入物品', function () { line.itemId = v; });
        renderInspector();
      }, false));
      var cnt = el('input', { class: 'input input-count', type: 'number', min: '1', step: '1', value: line.count, title: '每批中转数量（仅用于标识与显示，缓存器不限制速率）' });
      bindEdit(cnt, function (v) { line.count = v; }, '缓存器数量', { number: true, def: 1, min: 1 });
      row.appendChild(cnt);
      row.appendChild(el('div', { class: 'recipe-btns' }, [
        el('button', { class: 'btn btn-icon', title: '上移', disabled: idx === 0, onclick: function () { moveRecipe(node, 'inputs', idx, -1); } }, '↑'),
        el('button', { class: 'btn btn-icon', title: '下移', disabled: idx === list.length - 1, onclick: function () { moveRecipe(node, 'inputs', idx, 1); } }, '↓'),
        el('button', { class: 'btn btn-icon btn-danger', title: '删除该条（对应的输出口连线也会移除）', onclick: function () { removeRecipe(node, 'inputs', idx); } }, '✕')
      ]));
      wrap.appendChild(row);
    });
    wrap.appendChild(el('div', { class: 'recipe-add' }, [
      el('button', {
        class: 'btn btn-mini', onclick: function () {
          S.mutate('添加缓存器输入', function () { list.push(M.makeRecipeLine('', 1)); });
          renderAll();
        }
      }, '＋ 添加输入'),
      el('button', {
        class: 'btn btn-mini', title: '清空输入（对应输出口的连线会一并移除）', onclick: function () {
          var links = 0;
          for (var k = 0; k < list.length; k++) links += M.recipeRowLinks(S.state.flow, node, 'inputs', k).length;
          var doIt = function () {
            var removed = 0;
            S.mutate('清空缓存器输入', function () { removed = M.clearRecipeSide(S.state.flow, node, 'inputs'); });
            toast('info', '已清空缓存器输入' + (removed ? '，同时移除 ' + removed + ' 条相关连线。' : '。'));
            renderAll();
          };
          if (links) confirmModal('清空缓存器输入', '输入口上有 ' + links + ' 条连线，清空后这些连线也会被移除。确定继续？', doIt);
          else if (list.length) confirmModal('清空缓存器输入', '确定清空全部 ' + list.length + ' 条输入？对应的输出口也会消失。', doIt);
        }
      }, '清空')
    ]));
    box.appendChild(wrap);

    // 只读展示：输出口由输入强制镜像，不可编辑
    var ports = M.nodePorts(node);
    box.appendChild(el('div', { class: 'section-title' }, [
      el('span', { text: '输出（强制镜像输入，不可编辑）' }),
      el('span', { class: 'hint', text: ports.outputs.length + ' 个' })
    ]));
    var mirror = el('div', { class: 'mirror-list' });
    if (!ports.outputs.length) {
      mirror.appendChild(el('div', { class: 'pal-empty', text: '还没有输入，因此也没有输出口。' }));
    }
    ports.outputs.forEach(function (p, idx) {
      mirror.appendChild(el('div', { class: 'mirror-row' }, [
        el('span', { class: 'mirror-lock', text: '🔒' }),
        el('span', { class: 'mirror-name', text: '输出口 ' + (idx + 1) }),
        p.itemId ? el('span', { class: 'dot', style: 'background:' + (M.findItem(S.state.flow, p.itemId) || {}).color }) : null,
        el('span', { class: 'mirror-item', text: p.itemId ? (M.itemLabel(S.state.flow, p.itemId) + ' ×' + p.count) : '未设置物品' }),
        el('span', { class: 'mirror-src', text: '= 输入口 ' + (idx + 1) })
      ]));
    });
    box.appendChild(mirror);

    // 模拟：进出速率恒等
    var sb = S.state.sim && S.state.sim.buffer ? S.state.sim.buffer[node.id] : null;
    box.appendChild(el('div', { class: 'section-title' }, [el('span', { text: '中转速率（进出恒等）' })]));
    var kv = el('div', { class: 'kv' });
    if (sb) {
      var eqTxt = M.fmtNum(sb.totalIn) + ' /s  =  ' + M.fmtNum(sb.totalOut) + ' /s';
      if (sb.unconnectedOuts) {
        eqTxt = M.fmtNum(sb.totalIn) + ' /s  →  ' + M.fmtNum(sb.totalOut) + ' /s（' + sb.unconnectedOuts + ' 个输出口未连接）';
      }
      kv.appendChild(el('div', { class: 'kv-row' }, [
        el('span', { text: '总输入 / 总输出' }),
        el('b', { text: eqTxt })
      ]));
      if (sb.unconnectedOuts) {
        kv.appendChild(el('div', { class: 'kv-row' }, [
          el('span', { text: '恒定中转量（= 总输入）' }),
          el('b', { text: M.fmtNum(sb.totalRelay) + ' /s' })
        ]));
      }
      sb.ports.forEach(function (p) {
        kv.appendChild(el('div', { class: 'kv-row' }, [
          el('span', { text: '通道 ' + (p.index + 1) + '（' + (p.itemId ? M.itemLabel(S.state.flow, p.itemId) : '未设置') + '）' }),
          el('b', { text: M.fmtNum(p.inRate) + ' → ' + M.fmtNum(p.outRate) + ' /s' + (p.connected ? '' : '（输出口未连接）') })
        ]));
      });
    } else {
      kv.appendChild(el('div', { class: 'kv-row' }, [el('span', { text: '暂无数据' }), el('b', { text: '—' })]));
    }
    box.appendChild(kv);
    box.appendChild(el('div', { class: 'field-hint', text: '运行模拟后这里会显示每条通道的实际进出速率；把输出口都接上时，总输入 = 总输出。' }));

    box.appendChild(el('div', { class: 'section-title' }, [el('span', { text: '位置' })]));
    box.appendChild(coordsRow(node));
  }

  function buildDiamondForm(box, node) {    var isSource = node.mode === 'source';
    inspectorHead(box, node.name || (isSource ? '输入端' : '输出端'),
      (isSource ? '输入端（物料源）· 仅 1 个输出口' : '输出端（物料汇）· 仅 1 个输入口'), node);

    var nameInput = el('input', { class: 'input', value: node.name, maxlength: '30' });
    bindEdit(nameInput, function (v) { node.name = v; }, '接口名称');
    box.appendChild(field('名称', nameInput));

    var modeSel = el('select', { class: 'input' }, [
      el('option', { value: 'source', text: '输入端（从外部供料 → 1 个输出口）' }),
      el('option', { value: 'sink', text: '输出端（把产物送出 → 1 个输入口）' })
    ]);
    modeSel.value = node.mode;
    modeSel.addEventListener('change', function () {
      var newMode = modeSel.value;
      var hasLinks = M.linksOfPort(S.state.flow, node.id, isSource ? 'out' : 'in', 0).length;
      var doIt = function () {
        S.mutate('切换接口类型', function () {
          S.state.flow.links = S.state.flow.links.filter(function (l) {
            return !(l.from.nodeId === node.id || l.to.nodeId === node.id);
          });
          node.mode = newMode;
        });
        renderAll();
      };
      if (hasLinks) confirmModal('切换接口类型', '切换后该接口上的 ' + hasLinks + ' 条连线会被清除。继续？', doIt);
      else doIt();
    });
    box.appendChild(field('类型', modeSel, '菱形块只有 1 个端口：输出口或输入口。'));

    if (isSource) {
      box.appendChild(field('供料物品', itemSelect(node.emit.itemId, function (v) {
        S.mutate('设置供料物品', function () { node.emit.itemId = v; });
        renderInspector();
      }, false)));
      var ci = el('input', { class: 'input input-sm', type: 'number', min: '1', step: '1', value: node.emit.count });
      var ti = el('input', { class: 'input input-sm', type: 'number', min: '1', step: '1', value: node.emit.ticks });
      var rateHint = el('div', { class: 'field-hint' }, []);
      function refreshRate() {
        clear(rateHint);
        rateHint.appendChild(document.createTextNode('产出速率 ' + M.fmtRate(node.emit.count, node.emit.ticks) +
          '（每 ' + node.emit.ticks + ' t 一批，' + M.fmtNum(node.emit.ticks / M.TICKS_PER_SECOND) + ' s）'));
      }
      bindEdit(ci, function (v) { node.emit.count = v; refreshRate(); }, '单次数量', { number: true, def: 1, min: 1 });
      bindEdit(ti, function (v) { node.emit.ticks = v; refreshRate(); }, '供料间隔', { number: true, def: M.TICKS_PER_SECOND, min: 1 });
      refreshRate();
      box.appendChild(el('div', { class: 'field-row' }, [
        el('div', { class: 'inline-field' }, [el('span', { class: 'inline-label', text: '每批数量' }), ci]),
        el('div', { class: 'inline-field' }, [el('span', { class: 'inline-label', text: '间隔 t' }), ti])
      ]));
      box.appendChild(rateHint);
    } else {
      box.appendChild(field('只接受（可留空 = 接受任意）', itemSelect(node.filter.itemId, function (v) {
        S.mutate('设置输出端过滤', function () { node.filter.itemId = v; });
        renderInspector();
      }, true)));
      var fc = el('input', { class: 'input input-sm', type: 'number', min: '0', step: '1', value: node.filter.count });
      bindEdit(fc, function (v) { node.filter.count = v; }, '最小数量', { number: true, def: 0, min: 0 });
      box.appendChild(el('div', { class: 'field-row' }, [
        el('div', { class: 'inline-field' }, [el('span', { class: 'inline-label', text: '最小数量' }), fc])
      ]));
      box.appendChild(el('div', { class: 'field-hint', text: '留空表示接受任意物品；填写后接入不匹配的物品会标红报错。' }));
    }

    box.appendChild(el('div', { class: 'field-row' }, [
      el('button', { class: 'btn', onclick: function () { saveNodeAsPreset(node); } }, '存为预设'),
      el('button', { class: 'btn btn-ghost', onclick: function () { duplicateNode(node); } }, '复制节点'),
      el('button', { class: 'btn btn-danger', onclick: function () { S.removeNodes([node.id]); renderAll(); } }, '删除')
    ]));
    box.appendChild(el('div', { class: 'section-title' }, [el('span', { text: '位置' })]));
    box.appendChild(coordsRow(node));
  }

  function buildLinkForm(box, link) {
    var fn = M.findNode(S.state.flow, link.from.nodeId);
    var tn = M.findNode(S.state.flow, link.to.nodeId);
    var content = M.resolveOutPort(S.state.flow, link.from.nodeId, link.from.index);
    var iss = S.state.analysis.linkIssues[link.id];
    inspectorHead(box, '连线', (fn ? fn.name : '?') + ' → ' + (tn ? tn.name : '?'));
    box.appendChild(el('div', { class: 'kv' }, [
      el('div', { class: 'kv-row' }, [el('span', { text: '上游输出口' }), el('b', { text: (fn ? fn.name : '?') + ' 输出口 ' + ((link.from.index | 0) + 1) })]),
      el('div', { class: 'kv-row' }, [el('span', { text: '下游输入口' }), el('b', { text: (tn ? tn.name : '?') + ' 输入口 ' + ((link.to.index | 0) + 1) })]),
      el('div', { class: 'kv-row' }, [el('span', { text: '输出内容' }), el('b', { text: content && content.itemId ? (M.itemLabel(S.state.flow, content.itemId) + ' ×' + content.count) : '未设置物品' })]),
      content && content.itemId ? el('div', { class: 'kv-row' }, [el('span', { text: '理论速率' }), el('b', { text: M.fmtRate(content.count, content.ticks) })]) : null,
      S.state.analysis.shareNote && S.state.analysis.shareNote[link.id]
        ? el('div', { class: 'kv-row' }, [el('span', { text: '分流（一对多）' }), el('b', { text: S.state.analysis.shareNote[link.id] })]) : null,
      S.state.sim ? el('div', { class: 'kv-row' }, [el('span', { text: '模拟流量' }), el('b', { text: M.fmtNum(S.state.sim.linkRate[link.id] || 0) + ' /s' })]) : null
    ]));
    box.appendChild(el('div', { class: 'insp-issues ' + (iss ? (iss.level === 'error' ? 'is-error' : 'is-warn') : 'is-ok') }, [
      el('div', { class: 'insp-issue', text: iss ? iss.msg : '上下游内容完全对应，连接正常。' })
    ]));
    box.appendChild(el('div', { class: 'field-row' }, [
      el('button', { class: 'btn btn-ghost', onclick: function () { S.clearSelection(); } }, '取消选中'),
      el('button', { class: 'btn btn-danger', onclick: function () { S.removeLinks([link.id]); renderAll(); } }, '删除连线')
    ]));
  }

  function buildMultiForm(box, nodes, links) {
    inspectorHead(box, '已选中 ' + nodes.length + ' 个节点 / ' + links.length + ' 条连线', '批量操作');
    var machineCount = nodes.filter(function (n) { return n.kind === 'machine'; }).length;
    var power = 0, ticks = 0;
    nodes.forEach(function (n) { if (n.kind === 'machine') { power += M.num(n.power, 0); ticks += M.num(n.ticks, 0); } });
    box.appendChild(el('div', { class: 'kv' }, [
      el('div', { class: 'kv-row' }, [el('span', { text: '机器数量' }), el('b', { text: String(machineCount) })]),
      el('div', { class: 'kv-row' }, [el('span', { text: '合计耗电' }), el('b', { text: M.fmtNum(power) + ' EU/t' })]),
      el('div', { class: 'kv-row' }, [el('span', { text: '合计耗时' }), el('b', { text: M.fmtNum(ticks) + ' t' })])
    ]));
    box.appendChild(el('div', { class: 'field-row' }, [
      el('button', {
        class: 'btn', onclick: function () {
          var cnt = 0;
          S.mutate('批量存为预设', function () {
            nodes.forEach(function (n) {
              var p = PS.fromNode(S.state.flow, n);
              if (p) { PS.upsert(p); cnt++; }
            });
          });
          toast('info', '已保存 ' + cnt + ' 个预设（预设库为独立文件，所有流程共用）。');
          renderAll();
        }
      }, '全部存为预设'),
      el('button', {
        class: 'btn btn-ghost', onclick: function () {
          var ids = nodes.map(function (n) { return n.id; });
          S.mutate('对齐', function () {
            var y = nodes[0].y;
            nodes.forEach(function (n) { n.y = y; });
          });
          toast('info', '已将 ' + ids.length + ' 个节点水平对齐。');
          renderAll();
        }
      }, '水平对齐'),
      el('button', { class: 'btn btn-danger', onclick: function () { S.deleteSelection(); renderAll(); } }, '删除所选')
    ]));
  }

  function saveNodeAsPreset(node) {
    var p = PS.fromNode(S.state.flow, node);
    if (!p) { toast('warn', '该节点无法保存为预设。'); return; }
    PS.upsert(p);
    toast('info', '已存入预设库：' + p.name + '（' + PS.TYPE_LABEL[p.type] + '，独立文件，所有流程共用）');
    renderAll();
  }

  function duplicateNode(node) {
    var copy = M.deepClone(node);
    copy.id = M.uid(node.kind === 'machine' ? 'mch' : 'dia');
    copy.x += M.GRID * 2; copy.y += M.GRID * 2;
    if (copy.kind === 'machine') {
      copy.recipe.inputs.forEach(function (l) { l.id = M.uid('rl'); });
      copy.recipe.outputs.forEach(function (l) { l.id = M.uid('rl'); });
    }
    copy.name = nextName(node.name);
    S.mutate('复制节点', function () { S.state.flow.nodes.push(copy); });
    S.selectNodes([copy.id], false);
    renderAll();
  }

  /* ------------------------------------------------------------- 物品库 */

  function promptNewItem(cb) {
    var nameI = el('input', { class: 'input', placeholder: '物品名称，例如：铁锭 / 硫酸', maxlength: '30' });
    var stateS = el('select', { class: 'input' }, [
      el('option', { value: 'solid', text: '固体（物品 / 粉 / 锭）' }),
      el('option', { value: 'fluid', text: '流体（液体 / 气体）' })
    ]);
    var noteI = el('input', { class: 'input', placeholder: '备注（可选）', maxlength: '40' });
    var created = null;
    var modal = openModal({
      title: '新建物品',
      body: [field('名称', nameI), field('属性', stateS), field('备注', noteI)],
      actions: [
        { label: '取消', cls: 'btn-ghost' },
        {
          label: '创建', cls: 'btn-primary', onClick: function () {
            var name = nameI.value.trim();
            if (!name) { toast('warn', '请填写物品名称。'); return false; }
            S.mutate('新建物品', function () {
              var item = M.makeItem({ name: name, state: stateS.value, note: noteI.value.trim() });
              S.state.flow.items.push(item);
              created = item;
            });
            toast('info', '已创建物品：' + name + '（' + (stateS.value === 'fluid' ? '流体' : '固体') + '）');
            if (cb) cb(created);
            renderAll();
          }
        }
      ]
    });
    setTimeout(function () { nameI.focus(); }, 30);
    return modal;
  }

  function openItemModal() {
    var body = el('div', { class: 'modal-section' });
    function render() {
      clear(body);
      body.appendChild(el('div', { class: 'field-row' }, [
        el('button', { class: 'btn', onclick: function () { promptNewItem(function () { render(); renderAll(); }); } }, '＋ 新建物品'),
        el('span', { class: 'hint', text: '物品只有名称与属性（固体 / 流体）；配方与输入端通过名称引用物品，改名不会断开引用。' })
      ]));

      var table = el('div', { class: 'item-table' });
      if (!S.state.flow.items.length) table.appendChild(el('div', { class: 'pal-empty', text: '物品库为空。' }));
      S.state.flow.items.forEach(function (it) {
        var nameI = el('input', { class: 'input', value: it.name });
        var before = null;
        nameI.addEventListener('focus', function () { before = S.beginDrag(); });
        nameI.addEventListener('input', function () {
          it.name = nameI.value;
          S.refresh(); S.emit('change', { label: '重命名物品' });
        });
        nameI.addEventListener('change', function () {
          if (before) S.commitDrag(before, '重命名物品');
          render();
          renderAll();
        });
        var stateS = el('select', { class: 'input input-sm' }, [
          el('option', { value: 'solid', text: '固体' }),
          el('option', { value: 'fluid', text: '流体' })
        ]);
        stateS.value = it.state;
        stateS.addEventListener('change', function () {
          S.mutate('修改物态', function () { it.state = stateS.value; });
          render(); renderAll();
        });
        var colorI = el('input', { class: 'input input-color', type: 'color', value: it.color });
        colorI.addEventListener('change', function () {
          S.mutate('修改颜色', function () { it.color = colorI.value; });
          render(); renderAll();
        });
        var noteI = el('input', { class: 'input', value: it.note || '', placeholder: '备注' });
        noteI.addEventListener('change', function () {
          S.mutate('修改备注', function () { it.note = noteI.value; });
          renderAll();
        });
        var usage = countItemUsage(it.id);
        table.appendChild(el('div', { class: 'item-row' }, [
          nameI, stateS, colorI, noteI,
          el('span', { class: 'item-use', text: usage ? ('被引用 ' + usage + ' 次') : '未被引用' }),
          el('button', {
            class: 'btn btn-icon btn-danger', title: '删除物品', onclick: function () {
              var doIt = function () {
                S.mutate('删除物品', function () {
                  S.state.flow.items = S.state.flow.items.filter(function (x) { return x.id !== it.id; });
                });
                toast('info', '已删除物品。' + (usage ? '有 ' + usage + ' 处引用会显示为“已删除物品”，请重新指定。' : ''));
                render(); renderAll();
              };
              if (usage) confirmModal('删除物品', '该物品被 ' + usage + ' 处配方/接口引用，删除后这些位置会提示“已删除物品”。继续？', doIt);
              else doIt();
            }
          }, '🗑')
        ]));
      });
      body.appendChild(table);
    }
    render();
    openModal({ title: '物品库（属于当前流程文件）', body: body, wide: true, actions: [{ label: '完成', cls: 'btn-primary' }] });
  }

  /* ------------------------------------------------------------- 预设管理 */

  function openPresetModal() {
    var body = el('div', { class: 'modal-section' });
    function render() {
      clear(body);
      body.appendChild(el('div', { class: 'field-row wrap' }, [
        el('button', { class: 'btn', onclick: function () { PS.exportFile(); toast('info', '已导出预设文件（所有流程共用）。'); } }, '导出预设文件'),
        el('button', {
          class: 'btn', onclick: function () {
            pickFile('.json', function (text) { importPresetText(text); render(); });
          }
        }, '导入预设文件'),
        el('button', {
          class: 'btn btn-danger', onclick: function () {
            confirmModal('清空预设库', '将删除全部预设（不影响流程文件）。确定？', function () {
              PS.clearAll();
              toast('warn', '预设库已清空。');
              render(); renderAll();
            });
          }
        }, '清空预设库')
      ]));
      body.appendChild(el('div', { class: 'hint', text: '预设库单独保存在本地存储的独立键中，并可导出为 .gtpresets.json 文件，所有流程文件共用。' }));

      PS.TYPE_ORDER.forEach(function (type) {
        var list = PS.list(type);
        if (!list.length) return;
        body.appendChild(el('div', { class: 'section-title' }, [el('span', { text: PS.TYPE_LABEL[type] + ' 预设（' + list.length + '）' })]));
        var box = el('div', { class: 'preset-list' });
        list.forEach(function (p) {
          var nameI = el('input', { class: 'input', value: p.name });
          nameI.addEventListener('change', function () {
            PS.rename(p.id, nameI.value.trim() || p.name);
            renderAll();
            render();
          });
          box.appendChild(el('div', { class: 'preset-row' }, [
            el('span', { class: 'dot', style: 'background:' + presetColor(p) }),
            nameI,
            el('span', { class: 'preset-desc', text: presetSummary(p) }),
            el('button', {
              class: 'btn btn-mini', onclick: function () {
                if (p.type === 'item') { addPresetInstance(p); }
                else { addPresetInstance(p); }
              }
            }, '放到画布'),
            el('button', { class: 'btn btn-icon btn-danger', title: '删除预设', onclick: function () { PS.remove(p.id); render(); renderAll(); } }, '🗑')
          ]));
        });
        body.appendChild(box);
      });
      if (!PS.list().length) body.appendChild(el('div', { class: 'pal-empty', text: '预设库为空：选中一个节点后点“存为预设”，即可把它的参数（含配方）保存下来供所有流程复用。' }));
    }
    render();
    openModal({ title: '预设管理（独立文件 · 所有流程共用）', body: body, wide: true, actions: [{ label: '完成', cls: 'btn-primary' }] });
  }

  function presetColor(p) {
    if (p.type === 'item' && p.item) return p.item.color || '#7f8ea3';
    if (p.type === 'machine') return '#f0a020';
    if (p.type === 'buffer') return '#8f7fe0';
    if (p.type === 'source') return '#4fbf7b';
    return '#4aa3d8';
  }

  function presetSummary(p) {
    if (p.type === 'item') return (p.item.state === M.FLUID ? '流体' : '固体');
    if (p.type === 'machine') {
      return M.fmtNum(p.machine.power) + ' EU/t · ' + M.fmtNum(p.machine.ticks) + ' t · 配方 ' +
        p.machine.inputs.length + '→' + p.machine.outputs.length;
    }
    if (p.type === 'buffer') {
      return '缓存器 · 输入 ' + p.buffer.inputs.length + ' 条（输出强制镜像输入）';
    }
    if (p.type === 'source') return (p.diamond.item ? p.diamond.item.name : '未设置') + ' ×' + p.diamond.count + ' / ' + p.diamond.ticks + ' t';
    return p.diamond.filterItem ? ('只收 ' + p.diamond.filterItem.name) : '接受任意';
  }

  function importPresetText(text) {
    var res = PS.importText(text, { merge: true });
    if (!res.ok) { toast('error', res.error); return; }
    toast('info', '预设导入完成：新增/覆盖 ' + res.added + ' 个，共 ' + res.total + ' 个。');
    renderAll();
  }

  /* ------------------------------------------------------------- 流程管理 */

  function openFlowModal() {
    var body = el('div', { class: 'modal-section' });
    function render() {
      clear(body);
      var nameI = el('input', { class: 'input', value: S.state.flow.meta.name, maxlength: '50' });
      nameI.addEventListener('change', function () {
        S.mutate('重命名流程', function () { S.state.flow.meta.name = nameI.value || '未命名产线'; });
        render(); renderAll();
      });
      body.appendChild(field('当前流程名称', nameI));

      body.appendChild(el('div', { class: 'field-row wrap' }, [
        el('button', {
          class: 'btn btn-primary', onclick: function () {
            var r = S.saveFlowAs(S.state.flow.meta.name, { newId: false });
            if (r.ok) toast('info', '已保存到本地存储：' + S.state.flow.meta.name);
            else toast('error', '保存失败：本地存储不可用，请使用“导出流程文件”。');
            render(); renderAll();
          }
        }, '💾 保存到本地'),
        el('button', {
          class: 'btn', onclick: function () {
            S.saveFlowAs(S.state.flow.meta.name + ' 副本', { newId: true });
            toast('info', '已另存为新流程。');
            render(); renderAll();
          }
        }, '另存为新流程'),
        el('button', { class: 'btn', onclick: function () { S.exportFlow(); } }, '导出流程文件'),
        el('button', {
          class: 'btn', onclick: function () {
            pickFile('.json', function (text) { S.importFlowText(text); render(); renderAll(); });
          }
        }, '导入流程文件'),
        el('button', { class: 'btn', onclick: function () { S.newFlow('未命名产线'); toast('info', '已新建空白产线。'); render(); renderAll(); } }, '新建空白流程'),
        el('button', { class: 'btn', onclick: function () { S.exportBackup(); toast('info', '已导出全部存档 + 预设库的备份文件。'); } }, '导出全部备份'),
        el('button', {
          class: 'btn', onclick: function () {
            pickFile('.json', function (text) { S.importBackup(text); render(); renderAll(); });
          }
        }, '导入备份')
      ]));

      var list = S.listFlows();
      body.appendChild(el('div', { class: 'section-title' }, [el('span', { text: '本地存档（浏览器 localStorage）' })]));
      if (!list.length) body.appendChild(el('div', { class: 'pal-empty', text: '还没有存档。点击“保存到本地”即可创建。' }));
      var table = el('div', { class: 'flow-table' });
      list.forEach(function (entry) {
        var isCur = entry.id === S.state.currentFlowId;
        table.appendChild(el('div', { class: 'flow-row' + (isCur ? ' is-current' : '') }, [
          el('span', { class: 'flow-name', text: entry.name }),
          el('span', { class: 'flow-meta', text: (entry.updatedAt || '').replace('T', ' ').slice(0, 16) + ' · ' + (entry.nodes || 0) + ' 节点 · ' + Math.max(1, Math.round((entry.bytes || 0) / 1024)) + ' KB' }),
          el('span', { class: 'flow-btns' }, [
            el('button', {
              class: 'btn btn-mini', onclick: function () {
                if (S.state.dirty) {
                  confirmModal('打开其他流程', '当前流程有未保存的修改（已自动暂存），仍要打开“' + entry.name + '”吗？', function () {
                    S.openFlow(entry.id); render(); renderAll();
                  });
                } else { S.openFlow(entry.id); render(); renderAll(); }
              }
            }, '打开'),
            el('button', {
              class: 'btn btn-mini', onclick: function () {
                var nn = window.prompt('新的名称：', entry.name);
                if (nn) { S.renameFlow(entry.id, nn); render(); renderAll(); }
              }
            }, '重命名'),
            el('button', { class: 'btn btn-mini', onclick: function () { S.duplicateFlow(entry.id); render(); renderAll(); } }, '复制'),
            el('button', {
              class: 'btn btn-mini', onclick: function () {
                try {
                  var text = window.localStorage.getItem('gtline.flow.v1.' + entry.id);
                  if (text) S.download(S.sanitizeFilename(entry.name) + '.gtline.json', text);
                  else toast('warn', '读取存档失败。');
                } catch (err) { toast('error', '读取存档失败：' + err.message); }
              }
            }, '导出'),
            el('button', {
              class: 'btn btn-mini btn-danger', onclick: function () {
                confirmModal('删除存档', '确定删除存档“' + entry.name + '”？此操作不可撤销。', function () {
                  S.deleteFlow(entry.id); render(); renderAll();
                });
              }
            }, '删除')
          ])
        ]));
      });
      body.appendChild(table);
    }
    render();
    openModal({ title: '流程文件', body: body, wide: true, actions: [{ label: '关闭', cls: 'btn-primary' }] });
  }

  /* ------------------------------------------------------------ 文件选择 */

  function pickFile(accept, cb) {
    var input = el('input', { type: 'file', accept: accept || '', style: 'display:none' });
    var cleanup = function () { if (input.parentNode) input.parentNode.removeChild(input); };
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) { cleanup(); return; }
      S.readFile(f, function (text) { cb(text, f); });
      setTimeout(cleanup, 500);
    });
    // 用户取消对话框时 window 会重新获得焦点，据此回收 input，避免残留
    var onFocus = function () { setTimeout(function () { if (!input.files || !input.files.length) cleanup(); window.removeEventListener('focus', onFocus); }, 600); };
    window.addEventListener('focus', onFocus);
    setTimeout(function () { cleanup(); window.removeEventListener('focus', onFocus); }, 10 * 60 * 1000);
    document.body.appendChild(input);
    input.click();
  }

  /* -------------------------------------------------------------- 帮助 */

  function openHelp() {
    openModal({
      title: '使用说明 · 格雷科技产线模拟器',
      wide: true,
      body: el('div', { class: 'help' }, [
        el('h4', { text: '基本操作' }),
        el('ul', {}, [
          el('li', { text: '左侧栏拖拽（或单击）即可放置「输入端 / 输出端 / 机器」，预设也可以直接拖到画布。' }),
          el('li', { text: '从一个端口拖到另一个端口创建连线；输入↔输出方向自动判定。支持一对多、多对一。' }),
          el('li', { text: '滚轮缩放，中键 / 右键 / 空格 + 左键拖动平移，空白处左键拖动框选，Delete 删除所选。' }),
          el('li', { text: '双击节点打开属性面板（右侧浮动面板），右键打开快捷菜单，Ctrl+Z / Ctrl+Y 撤销重做，Ctrl+S 保存到本地。' })
        ]),
        el('h4', { text: '物品与机器都是白板' }),
        el('ul', {}, [
          el('li', { text: '物品只有「名称 + 属性（固体 / 流体）」，在物品库中创建。' }),
          el('li', { text: '机器只有「名称 + 耗电量(EU/t) + 耗时(tick) + 配方」，配方手动逐条添加并保持顺序。' }),
          el('li', { text: '配方每条输入/输出对应机器上一个输入口/输出口；输入口在左侧，输出口在右侧，从上到下按配方顺序排列。' }),
          el('li', { text: '20 tick = 1 秒。' })
        ]),
        el('h4', { text: '连线与报错规则' }),
        el('ul', {}, [
          el('li', { text: '连线有方向（由输出口指向输入口，线上箭头表示方向）。' }),
          el('li', { text: '线上标签显示上游输出口输出的内容与数量（模拟开启时还会显示实际流量 /s）。' }),
          el('li', { text: '当机器某个输入口接入的内容与配方该输入口要求“非完全对应”（物品不同，或供料速率不足）时，整条连线变红并给出错误说明。' }),
          el('li', { text: '供料过量、输出口未连接等属于警告（黄色），不影响连线成立。' }),
          el('li', { text: '闭环（纯环路）会整体标红：格雷科技里的循环需要缓冲/缓存，纯闭环不成立。' })
        ]),
        el('h4', { text: '缓存器（正方形，和机器在同一栏）' }),
        el('ul', {}, [
          el('li', { text: '只能配置「输入」（顺序 = 输入口顺序，从上到下）；输出会**强制与输入相同**：第 i 个输出口的物品永远等于第 i 个输入口，不需要也不允许单独设置。' }),
          el('li', { text: '进出速率恒等：每条通道的总输入速率恰好等于它的总输出速率（缓存器只做中转，不改变数量，也不消耗/耗电）。' }),
          el('li', { text: '**循环连接**：两台机器直接互连成环仍然会报错（提示里会告诉你需要缓存器）；把缓存器接进环路即可成立，比如 A → 缓存器 → B → A。' }),
          el('li', { text: '属性面板下方会实时显示每条通道的「进 → 出」速率，运行模拟后可以看到 总输入 = 总输出。' })
        ]),
        el('h4', { text: '自动排版' }),
        el('ul', {}, [
          el('li', { text: '点工具栏「📐 自动排版」（或 Ctrl+L / 画布右键菜单）：按「距输入端的最短连线长度」给每个节点定出第 N 步，第 N 步的节点排在第 N 列。' }),
          el('li', { text: '第 0 步 = 所有输入端（物料源），以及没有任何上游连线的节点（例如没有输入配方的自发产出机器）。' }),
          el('li', { text: '列内顺序会按相邻列的「重心」自动排序以减少连线交叉；每列垂直居中、整体居中于原点，并自动适应视图。' }),
          el('li', { text: '从任何输入端都不可达的节点（例如没有来源的纯环路）会被单独放到最后一列，并在提示中告知数量。' }),
          el('li', { text: '一次排版是一步撤销（Ctrl+Z 可整体还原）；排版后仍可手动拖动微调。选中节点时属性面板会显示它的步数。' })
        ]),
        el('h4', { text: '统计与模拟' }),
        el('ul', {}, [
          el('li', { text: '工作栏右上角实时显示「理论最大耗电量 = 所有机器耗电相加」与「理论最大耗时 = 所有机器耗时相加」。' }),
          el('li', { text: '点击 ▶ 运行模拟：机器按「最紧缺输入口」决定实际加工速度，输出口下游按均分计算流量，连线上出现物料圆点，机器底部显示效率条。' })
        ]),
        el('h4', { text: '本地存储与文件' }),
        el('ul', {}, [
          el('li', { text: '流程文件：保存在浏览器 localStorage 中，可随时导出为 .gtline.json 文件、导入回来。' }),
          el('li', { text: '预设库：单独保存（独立 localStorage 键 + 独立的 .gtpresets.json 文件），所有流程文件共用，且没有任何默认预设。' }),
          el('li', { text: '“导出全部备份”会打包所有存档 + 预设库；换浏览器 / 换电脑时用它迁移。' })
        ])
      ]),
      actions: [{ label: '知道了', cls: 'btn-primary' }]
    });
  }

  /* ------------------------------------------------------------ 右键菜单 */

  function showContextMenu(target) {
    hideContextMenu();
    var items = [];
    var wx = target.world, sp = target.screen;
    if (target.type === 'node') {
      var node = M.findNode(S.state.flow, target.nodeId);
      if (!node) return;
      S.selectNodes([node.id], false);
      items.push({ label: '编辑属性', fn: function () { renderInspector(); $('inspector').classList.remove('hidden'); } });
      items.push({ label: '存为预设', fn: function () { saveNodeAsPreset(node); } });
      items.push({ label: '复制节点', fn: function () { duplicateNode(node); } });
      items.push({
        label: '断开所有连线', fn: function () {
          S.mutate('断开连线', function () {
            S.state.flow.links = S.state.flow.links.filter(function (l) { return l.from.nodeId !== node.id && l.to.nodeId !== node.id; });
          });
        }
      });
      items.push({ sep: true });
      items.push({ label: '删除节点', danger: true, fn: function () { S.removeNodes([node.id]); renderAll(); } });
    } else if (target.type === 'link') {
      var l = null;
      S.state.flow.links.forEach(function (x) { if (x.id === target.linkId) l = x; });
      if (!l) return;
      S.selectLinks([l.id], false);
      var iss = S.state.analysis.linkIssues[l.id];
      if (iss) items.push({ label: (iss.level === 'error' ? '错误：' : '警告：') + iss.msg, disabled: true });
      items.push({ label: '删除连线', danger: true, fn: function () { S.removeLinks([l.id]); renderAll(); } });
    } else {
      items.push({ label: '在此添加 机器', fn: function () { newNode('machine', { world: wx }); } });
      items.push({ label: '在此添加 缓存器（正方形）', fn: function () { newNode('buffer', { world: wx }); } });
      items.push({ label: '在此添加 输入端（源）', fn: function () { newNode('source', { world: wx }); } });
      items.push({ label: '在此添加 输出端（汇）', fn: function () { newNode('sink', { world: wx }); } });
      items.push({ sep: true });
      items.push({ label: '自动排版（按步数分列）', fn: function () { autoLayoutFlow(); } });
      items.push({ label: '适应视图', fn: function () { CV.fitToContent(); } });
      items.push({ label: '重置缩放', fn: function () { CV.resetZoom(); } });
      items.push({ label: '全选', fn: function () { S.selectNodes(S.state.flow.nodes.map(function (n) { return n.id; }), false); } });
    }

    var menu = el('div', { class: 'ctx-menu' });
    items.forEach(function (it) {
      if (it.sep) { menu.appendChild(el('div', { class: 'ctx-sep' })); return; }
      menu.appendChild(el('button', {
        class: 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''),
        disabled: it.disabled,
        onclick: function () { hideContextMenu(); if (it.fn) it.fn(); }
      }, it.label));
    });
    menu.style.left = Math.min(sp.x, window.innerWidth - 220) + 'px';
    menu.style.top = Math.min(sp.y, window.innerHeight - 40 - items.length * 30) + 'px';
    ctxMenuEl = menu;
    document.body.appendChild(menu);
    setTimeout(function () {
      document.addEventListener('mousedown', onDocDownForMenu);
      document.addEventListener('keydown', onKeyForMenu);
    }, 10);
  }

  function onDocDownForMenu(e) {
    if (ctxMenuEl && !ctxMenuEl.contains(e.target)) hideContextMenu();
  }
  function onKeyForMenu(e) { if (e.key === 'Escape') hideContextMenu(); }
  function hideContextMenu() {
    document.removeEventListener('mousedown', onDocDownForMenu);
    document.removeEventListener('keydown', onKeyForMenu);
    if (ctxMenuEl && ctxMenuEl.parentNode) ctxMenuEl.parentNode.removeChild(ctxMenuEl);
    ctxMenuEl = null;
  }

  /* --------------------------------------------------------------- HUD */

  function renderHud() {
    var st = S.state.analysis.stats;
    var powerEl = $('hudPower');
    var timeEl = $('hudTime');
    if (powerEl) powerEl.textContent = M.fmtNum(st.power) + ' EU/t';
    if (timeEl) timeEl.textContent = M.fmtNum(st.ticks) + ' t（' + M.fmtNum(st.ticks / M.TICKS_PER_SECOND) + ' s）';
    var counts = $('hudCounts');
    if (counts) {
      var c = S.state.analysis.counts;
      counts.innerHTML = '';
      counts.appendChild(el('span', { text: '机器 ' + st.machineCount + ' · 源 ' + st.sourceCount + ' · 汇 ' + st.sinkCount + ' · 连线 ' + st.linkCount }));
    }
    var issues = $('hudIssues');
    if (issues) {
      var err = S.state.analysis.counts.error, warn = S.state.analysis.counts.warn;
      issues.className = 'hud-issues ' + (err ? 'is-error' : (warn ? 'is-warn' : 'is-ok'));
      issues.textContent = err ? ('✕ ' + err + ' 个错误' + (warn ? ' · ! ' + warn + ' 个警告' : ''))
        : (warn ? ('! ' + warn + ' 个警告') : '✓ 校验通过');
    }
    var simInfo = $('hudSim');
    if (simInfo) {
      if (S.state.run.playing && S.state.sim) {
        simInfo.textContent = '实际总产出 ' + M.fmtNum(S.state.sim.totals.itemPerSec) + ' /s';
        simInfo.classList.remove('hidden');
      } else simInfo.classList.add('hidden');
    }
  }

  function renderStatus() {
    var bar = $('status');
    if (!bar) return;
    clear(bar);
    var flow = S.state.flow;
    var dot = el('span', { class: 'status-dot ' + (S.state.dirty ? 'dirty' : 'saved') });
    bar.appendChild(el('div', { class: 'status-left' }, [
      dot,
      el('span', { text: flow.meta.name + (S.state.dirty ? '（有未保存的修改，已自动暂存）' : '（已保存）') }),
      el('span', { class: 'status-sep', text: '|' }),
      el('span', { text: '物品 ' + flow.items.length + ' · 节点 ' + flow.nodes.length + ' · 连线 ' + flow.links.length }),
      el('span', { class: 'status-sep', text: '|' }),
      el('span', {
        class: S.isStorageOk() ? 'status-ok' : 'status-bad',
        text: S.isStorageOk() ? '本地存储可用' : '本地存储不可用（请使用导出功能）'
      })
    ]));
    var errs = S.state.analysis.issueList.filter(function (i) { return i.level === 'error'; }).slice(0, 1);
    bar.appendChild(el('div', { class: 'status-right' }, [
      el('span', {
        class: errs.length ? 'status-err' : 'status-ok',
        text: errs.length ? ('首个错误：' + errs[0].msg) : '连线与配方校验通过'
      })
    ]));
  }

  /* ------------------------------------------------------------ 工具栏 */

  function renderToolbarState() {
    var u = $('btnUndo'), r = $('btnRedo');
    if (u) u.disabled = !S.canUndo();
    if (r) r.disabled = !S.canRedo();
    var p = $('btnPlay');
    if (p) p.textContent = S.state.run.playing ? '⏸ 暂停模拟' : '▶ 运行模拟';
    var g = $('btnGrid'), sn = $('btnSnap');
    if (g) g.classList.toggle('active', !!S.state.prefs.grid);
    if (sn) sn.classList.toggle('active', !!S.state.prefs.snap);
  }

  function wireToolbar() {
    $('btnNew').addEventListener('click', function () {
      if (S.state.flow.nodes.length) confirmModal('新建流程', '当前流程会被清空（已自动暂存的副本仍在本地存储中）。继续？', function () {
        S.newFlow('未命名产线'); toast('info', '已新建空白产线。'); renderAll();
      });
      else { S.newFlow('未命名产线'); renderAll(); }
    });
    $('btnOpen').addEventListener('click', openFlowModal);
    $('btnSave').addEventListener('click', function () {
      var r = S.saveFlowAs(S.state.flow.meta.name, { newId: false });
      if (r.ok) { toast('info', '已保存到本地存储：' + S.state.flow.meta.name); renderAll(); }
      else toast('error', '保存失败：本地存储不可用，请导出流程文件。');
    });
    $('btnExport').addEventListener('click', function () { S.exportFlow(); });
    $('btnImport').addEventListener('click', function () { pickFile('.json', function (text) { S.importFlowText(text); renderAll(); }); });
    $('btnUndo').addEventListener('click', function () { S.undo(); renderAll(); });
    $('btnRedo').addEventListener('click', function () { S.redo(); renderAll(); });
    $('btnItems').addEventListener('click', openItemModal);
    $('btnPresets').addEventListener('click', openPresetModal);
    $('btnHelp').addEventListener('click', openHelp);
    $('btnFit').addEventListener('click', function () { CV.fitToContent(); });
    $('btnLayout').addEventListener('click', function () { autoLayoutFlow(); });
    $('btnZoomIn').addEventListener('click', function () { zoomStep(1.2); });
    $('btnZoomOut').addEventListener('click', function () { zoomStep(1 / 1.2); });
    $('btnPlay').addEventListener('click', togglePlay);
    $('btnReset').addEventListener('click', function () {
      S.state.flow.links.forEach(function (l) { l.__phase = 0; });
      CV.invalidate();
      toast('info', '模拟已重置。');
    });
    $('btnGrid').addEventListener('click', function () {
      S.state.prefs.grid = !S.state.prefs.grid;
      S.prefsSave(); CV.invalidate(); renderToolbarState();
    });
    $('btnSnap').addEventListener('click', function () {
      S.state.prefs.snap = !S.state.prefs.snap;
      S.prefsSave(); renderToolbarState();
      toast('info', '网格吸附：' + (S.state.prefs.snap ? '开启' : '关闭'));
    });
    var sel = $('simSpeed');
    if (sel) sel.addEventListener('change', function () { S.state.run.speed = parseFloat(sel.value) || 1; });

    var panelBtn = $('btnPanel');
    if (panelBtn) panelBtn.addEventListener('click', function () {
      var box = $('inspector');
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) renderInspector();
    });
  }

  function zoomStep(f) {
    var v = S.state.view;
    v.zoom = M.clamp(v.zoom * f, 0.2, 3.2);
    CV.invalidate();
    S.scheduleAutosave();
  }

  /* --------------------------------------------------------- 自动排版 */

  /**
   * 按「距输入端的最短步数」排版：
   * 第 N 步的节点排在第 N 列（列内用相邻列重心排序减少交叉），整体居中并适应视图。
   */
  function autoLayoutFlow(silent) {
    var flow = S.state.flow;
    if (!flow.nodes.length) {
      if (!silent) toast('warn', '画布上还没有节点，先把输入端 / 机器 / 输出端拖进来。');
      return null;
    }
    var res = null;
    S.mutate('自动排版', function () {
      res = G.autoLayout(flow, { snap: S.state.prefs.snap });
    });
    if (!res || !res.moved) return null;
    CV.fitToContent();
    renderAll();
    if (!silent) {
      var msg = '已按「距输入端的最短步数」排版：共 ' + res.columns + ' 列（第 0 ~ ' + res.maxStep + ' 步）、' +
        res.moved + ' 个节点，其中第 0 步起点 ' + res.seeds + ' 个';
      if (res.unreachable) msg += '；另有 ' + res.unreachable + ' 个节点从任何输入端都不可达，已单独放在最后一列';
      toast('info', msg + '。可用 Ctrl+Z 撤销。');
    }
    return res;
  }

  /** 选中节点距输入端的最短步数（用于属性面板/提示展示排版依据） */
  function stepOfNode(nodeId) {
    try {
      var info = G.computeLayers(S.state.flow);
      return info.stepOf[nodeId];
    } catch (e) { return undefined; }
  }

  function togglePlay() {
    if (S.state.run.playing) {
      CV.setPlaying(false);
      toast('info', '模拟已暂停。');
    } else {
      if (!S.state.flow.nodes.length) { toast('warn', '画布上还没有节点。'); return; }
      S.refresh();
      CV.setPlaying(true);
      var errs = S.state.analysis.counts.error;
      if (errs) toast('warn', '当前有 ' + errs + ' 个错误，模拟结果仅供参考（红色连线上的物料不会真正送达）。');
      else toast('info', '模拟运行中：圆点表示物料流动，机器底部显示效率。');
    }
    renderToolbarState();
    renderHud();
  }

  /* ------------------------------------------------------------ 快捷键 */

  function wireKeys() {
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing) return;
      if (e.ctrlKey || e.metaKey) {
        var k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); S.undo(); renderAll(); return; }
        if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); S.redo(); renderAll(); return; }
        if (k === 's') {
          e.preventDefault();
          var r = S.saveFlowAs(S.state.flow.meta.name, { newId: false });
          toast(r.ok ? 'info' : 'error', r.ok ? '已保存到本地存储。' : '本地存储不可用，请导出文件。');
          renderAll();
          return;
        }
        if (k === 'a') {
          e.preventDefault();
          S.selectNodes(S.state.flow.nodes.map(function (n) { return n.id; }), false);
          renderAll();
          return;
        }
        if (k === 'l') { e.preventDefault(); autoLayoutFlow(); return; }
        if (k === 'd') {
          e.preventDefault();
          S.selectedNodes().forEach(function (n) { duplicateNode(n); });
          return;
        }
        if (k === '0') { e.preventDefault(); CV.resetZoom(); return; }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (!S.deleteSelection()) toast('info', '没有选中任何节点或连线。');
        renderAll();
        return;
      }
      if (e.key === 'Escape') { S.clearSelection(); hideContextMenu(); renderAll(); return; }
      if (e.key === 'f' || e.key === 'F') { CV.fitToContent(); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        var nodes = S.selectedNodes();
        if (!nodes.length) return;
        e.preventDefault();
        var step = e.shiftKey ? 1 : M.GRID;
        var dx = e.key === 'ArrowLeft' ? -step : (e.key === 'ArrowRight' ? step : 0);
        var dy = e.key === 'ArrowUp' ? -step : (e.key === 'ArrowDown' ? step : 0);
        var before = S.beginDrag();
        nodes.forEach(function (n) { n.x += dx; n.y += dy; });
        S.commitDrag(before, '移动节点');
        CV.invalidate();
      }
    });
  }

  /* ------------------------------------------------------------ 拖放接收 */

  function wireDrop() {
    var cvs = $('board');
    ['dragenter', 'dragover'].forEach(function (t) {
      cvs.addEventListener(t, function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        $('workspace').classList.add('dropping');
      });
    });
    cvs.addEventListener('dragleave', function (e) {
      if (e.target === cvs) $('workspace').classList.remove('dropping');
    });
    cvs.addEventListener('drop', function (e) {
      e.preventDefault();
      $('workspace').classList.remove('dropping');
      var raw = e.dataTransfer.getData(DND_TYPE) || e.dataTransfer.getData('text/plain');
      if (!raw) return;
      var payload;
      try { payload = JSON.parse(raw); } catch (err) { return; }
      var rect = cvs.getBoundingClientRect();
      var world = CV.screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      if (payload.t === 'preset') {
        var p = PS.get(payload.id);
        if (p) addPresetInstance(p, world);
        return;
      }
      newNode(payload.t === 'source' ? 'source' : (payload.t === 'sink' ? 'sink' : (payload.t === 'buffer' ? 'buffer' : 'machine')), { world: world });
    });
  }

  /* -------------------------------------------------------------- 渲染 */

  function renderAll() {
    renderPalette();
    renderInspector();
    renderHud();
    renderStatus();
    renderToolbarState();
    CV.invalidate();
  }

  function init() {
    renderPalette();
    wireToolbar();
    wireKeys();
    wireDrop();
    renderAll();

    S.on('change', function () {
      renderPalette();
      renderHud();
      renderStatus();
      renderToolbarState();
      if (!inspectorHasFocus()) renderInspector();
    });
    S.on('analysis', function () { renderHud(); renderStatus(); });
    S.on('selection', function () { renderInspector(); });
    S.on('presets:changed', function () { renderPalette(); });
    S.on('flows:changed', function () { renderStatus(); });
    S.on('persist', function () { renderStatus(); });
    S.on('toast', function (p) { toast(p.level, p.text); });
    S.on('flow:replaced', function () { renderAll(); });
    S.on('storage:failed', function () { renderStatus(); });

    CV.on('context', showContextMenu);
    CV.on('node:dblclick', function (p) {
      S.selectNodes([p.nodeId], false);
      var box = $('inspector');
      box.classList.remove('hidden');
      renderInspector();
    });
    CV.on('canvas:dblclick', function (p) {
      showContextMenu({ type: 'canvas', world: p.world, screen: p.screen });
    });

    var insp = $('inspector');
    if (insp) {
      insp.addEventListener('focusout', function () {
        setTimeout(function () { if (!inspectorHasFocus()) renderInspector(); }, 40);
      });
    }

    renderAll();
  }

  return {
    init: init, renderAll: renderAll, toast: toast, openModal: openModal,
    showContextMenu: showContextMenu, openHelp: openHelp,
    newNode: newNode, addPresetInstance: addPresetInstance, pickFile: pickFile
  };
});
