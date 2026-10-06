'use strict';
/* ============================================================================
 * GT 产线模拟器 — 可选的本地静态服务器（零依赖）
 *   node tools/serve.js [port]
 * 用途：部分浏览器在 file:// 下会禁用 localStorage，用本地服务器可以获得
 *       完整的“自动保存 + 本地存档”体验。直接双击 index.html 也能用。
 * ==========================================================================*/

var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');

var ROOT = path.join(__dirname, '..');
var PORT = parseInt(process.argv[2], 10) || 8777;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

var server = http.createServer(function (req, res) {
  var pathname = decodeURIComponent(url.parse(req.url).pathname);
  if (pathname === '/') pathname = '/index.html';
  var file = path.join(ROOT, path.normalize(pathname).replace(/^([/\\])+/, ''));
  if (file.indexOf(ROOT) !== 0) {
    res.writeHead(403); res.end('403 Forbidden'); return;
  }
  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.on('error', function (e) {
  console.error('启动失败：' + e.message);
  if (e.code === 'EADDRINUSE') console.error('端口 ' + PORT + ' 已被占用，可换一个：node tools/serve.js 8899');
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('GT 产线模拟器已启动：http://127.0.0.1:' + PORT + '/');
  console.log('（按 Ctrl+C 停止）');
});
