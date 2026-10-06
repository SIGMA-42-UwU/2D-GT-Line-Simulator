@echo off
chcp 65001 >nul
rem ============================================================
rem  GT 产线模拟器 — 可选的本地服务器启动器
rem  为什么需要它：个别浏览器在 file:// 下会禁用 localStorage
rem  （自动保存 / 本地存档会失效，但导入导出仍然可用）。
rem  用本地服务器打开就能获得完整的本地存储体验。
rem  会依次尝试 python / py / node，都没有就用记事本打开说明。
rem ============================================================
setlocal
cd /d "%~dp0"
set PORT=8777

where python >nul 2>nul && (
  echo 使用 Python 启动本地服务器：http://127.0.0.1:%PORT%/
  start "" "http://127.0.0.1:%PORT%/"
  python -m http.server %PORT% --bind 127.0.0.1
  goto :eof
)

where py >nul 2>nul && (
  echo 使用 Python 启动本地服务器：http://127.0.0.1:%PORT%/
  start "" "http://127.0.0.1:%PORT%/"
  py -m http.server %PORT% --bind 127.0.0.1
  goto :eof
)

where node >nul 2>nul && (
  echo 使用 Node.js 启动本地服务器：http://127.0.0.1:%PORT%/
  start "" "http://127.0.0.1:%PORT%/"
  node "%~dp0tools\serve.js" %PORT%
  goto :eof
)

echo.
echo 没有检测到 python 或 node。
echo 直接用浏览器打开 index.html 也能使用本模拟器，
echo 只是个别浏览器会禁用本地自动保存，请多用“导出”保存流程文件。
echo.
start "" "%~dp0index.html"
pause
