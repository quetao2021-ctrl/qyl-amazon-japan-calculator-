@echo off
setlocal
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Google Chrome not found.
  pause
  exit /b 1
)

start "" "%CHROME%" ^
  --remote-debugging-address=127.0.0.1 ^
  --remote-debugging-port=9222 ^
  --user-data-dir="E:\codex\.chatgpt_profile_live" ^
  --lang=en-US ^
  --no-first-run ^
  --no-default-browser-check ^
  --window-size=1700,1050 ^
  "https://chatgpt.com/?openaicom_referred=true"

echo ChatGPT Chrome started on CDP: http://127.0.0.1:9222
echo Keep this browser open while using ChatGPT image generation.
pause
