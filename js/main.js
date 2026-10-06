/* ============================================================================
 * GT 产线模拟器 — main.js
 * 启动顺序：store（本地数据）→ canvas（2D 画布）→ ui（面板与交互）
 * ==========================================================================*/
(function () {
  'use strict';

  function fatal(err) {
    console.error(err);
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0b0f13;color:#e5484d;' +
      'font:14px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;padding:40px;overflow:auto';
    box.innerHTML = '<h2 style="color:#f0a020;margin:0 0 12px">启动失败</h2>' +
      '<p>模拟器初始化时出现异常，请把下面的信息反馈给开发者：</p>' +
      '<pre style="white-space:pre-wrap;color:#dde5ee;background:#12171d;padding:14px;border-radius:8px">' +
      String(err && err.stack ? err.stack : err).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }) +
      '</pre>';
    document.body.appendChild(box);
  }

  function boot() {
    try {
      var GT = window.GT;
      if (!GT || !GT.model || !GT.store || !GT.canvas || !GT.ui) {
        throw new Error('脚本加载不完整：请确认 js/ 目录下的 6 个 js 文件都存在，且 index.html 未被修改。');
      }
      GT.store.init();
      GT.canvas.init(document.getElementById('board'));
      GT.ui.init();

      if (!GT.store.isStorageOk()) {
        GT.ui.toast('error', '浏览器本地存储（localStorage）不可用：本次修改不会自动保存，请随时用“导出”保存流程文件。');
      }

      var flow = GT.store.state.flow;
      if (!flow.nodes.length && !flow.items.length) {
        setTimeout(function () {
          GT.ui.toast('info', '首次使用：从左侧栏把「输入端 / 输出端 / 机器」拖到画布上开始搭建；需要示例可导入 samples/ 目录下的示例流程。');
        }, 600);
      } else {
        setTimeout(function () {
          GT.ui.toast('info', '已恢复上次的工作进度：' + flow.meta.name);
        }, 400);
      }

      window.addEventListener('beforeunload', function (e) {
        try { GT.store.writeWorking(); } catch (err) { /* ignore */ }
      });

      // 调试 / 自动化测试入口
      window.__GT = GT;
    } catch (err) {
      fatal(err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
