@echo off
setlocal
cd /d E:\codex
set "LOG_DIR=E:\codex\output"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

start "QYL Server 8788" /min cmd /c "set CHATGPT_CDP_URL=http://127.0.0.1:9222&& set PORT=8788&& cd /d E:\codex&& node scripts\gemini_lan_server.js 1>> E:\codex\output\qyl_8788_cdp_stdout.log 2>> E:\codex\output\qyl_8788_cdp_stderr.log"

echo QYL server is starting in the background.
echo Web URL: http://127.0.0.1:8788
echo ChatGPT CDP URL: http://127.0.0.1:9222
echo Logs:
echo   E:\codex\output\qyl_8788_cdp_stdout.log
echo   E:\codex\output\qyl_8788_cdp_stderr.log
timeout /t 3 >nul
