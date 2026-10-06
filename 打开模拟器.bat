@echo off
chcp 65001 >nul
rem ============================================================
rem  GT 产线模拟器 — 一键打开（直接用浏览器打开 index.html）
rem  说明：本模拟器是纯 HTML/CSS/JS，无需编译、无需安装依赖。
rem ============================================================
setlocal
cd /d "%~dp0"
if not exist "index.html" (
  echo [错误] 找不到 index.html，请确认本文件位于 GT-Line-Simulator 目录下。
  pause
  exit /b 1
)
start "" "%~dp0index.html"
echo 已用默认浏览器打开 GT 产线模拟器。
echo 如果浏览器没有自动弹出，请手动双击 index.html。
timeout /t 3 >nul
