# QYL Image Workbench (Gemini + ChatGPT)

This project runs local browser automation for product image generation and exposes a LAN portal for teammates.

Main workers:
- `scripts/gemini_web_rpa_worker.js`
- `scripts/chatgpt_web_image_worker.js`

Server:
- `scripts/gemini_lan_server.js`
- UI: `web/lan_portal/index.html`

Local URL:
- `http://127.0.0.1:8788`

## Quick start (recommended)

Run in PowerShell from project root:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

This script will:
- check Node.js / npm / npx
- install dependencies
- install Playwright Chromium
- create runtime folders
- start the local server on port `8788`
- open the portal page

## Manual start

Foreground:

```bat
start_server.bat
```

Background:

```bat
start.bat
```

## LAN access for teammates

1. Start the server on your machine.
2. Open `http://127.0.0.1:8788/api/config` and copy one URL from `lan_urls`.
3. Teammates on the same Wi-Fi open that LAN URL.

## First-time login

- Log in once in the automation browser for Gemini and ChatGPT.
- This flow is web automation based; no Gemini API key or ChatGPT API key is required.

## Key folders

- `prompts/fixed_prompt_for_gemini_web_rpa.txt`
- `prompts/fixed_prompt_for_chatgpt_web_rpa.txt`
- `output/lan_portal_jobs`
- `output/lan_portal_uploads`

