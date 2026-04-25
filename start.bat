@echo off
setlocal
cd /d E:\codex
set "PORT=8788"
set "CHATGPT_CDP_URL=http://127.0.0.1:9222"
set "LOG_DIR=E:\codex\output"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

start "QYL Server 8788" /min cmd /c "cd /d E:\codex&& set PORT=8788&& set CHATGPT_CDP_URL=http://127.0.0.1:9222&& node scripts\gemini_lan_server.js 1>> E:\codex\output\qyl_8788_stdout.log 2>> E:\codex\output\qyl_8788_stderr.log"

echo QYL server is starting.
echo Web URL: http://127.0.0.1:8788
echo LAN URL: use the IP shown in the web page or server log.
echo ChatGPT browser bridge: http://127.0.0.1:9222
echo If you use ChatGPT image generation, open start_chatgpt_real_chrome_debug.bat first.
timeout /t 3 >nul
