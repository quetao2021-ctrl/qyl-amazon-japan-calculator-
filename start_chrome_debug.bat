@echo off
REM 启动 Chrome 并开启远程调试
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\30588\AppData\Local\Google\Chrome\User Data\DebugProfile" --disable-blink-features=AutomationControlled
echo Chrome 已启动
