#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const iconv = require('iconv-lite');
const { chromium } = require('playwright');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      if (out[key] === undefined) out[key] = 'true';
      else if (Array.isArray(out[key])) out[key].push('true');
      else out[key] = [out[key], 'true'];
    } else {
      if (out[key] === undefined) out[key] = next;
      else if (Array.isArray(out[key])) out[key].push(next);
      else out[key] = [out[key], next];
      i += 1;
    }
  }
  return out;
}

function toInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.floor(num) : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(value));
}

function nowTag() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function resolveChromeExecutable() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const one of candidates) {
    if (fileExists(one)) return one;
  }
  return '';
}

function readTextFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function removeProfileLockFiles(profileDir) {
  const names = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
  for (const name of names) {
    const file = path.join(profileDir, name);
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

function isLaunchRecoverableError(error) {
  const msg = String(error && error.message ? error.message : error);
  return (
    /Browser\.getWindowForTarget/i.test(msg) ||
    /Browser window not found/i.test(msg) ||
    /\bspawn\s+EPERM\b/i.test(msg) ||
    /\bspawn\s+EACCES\b/i.test(msg)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCdpPortFromUrl(value, fallbackPort) {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return Number.isFinite(port) && port > 0 ? port : fallbackPort;
  } catch {
    return fallbackPort;
  }
}

async function startChromeForCdp({
  executablePath,
  sessionDir,
  viewportWidth,
  viewportHeight,
  cdpPort,
  startUrl,
}) {
  const args = [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${sessionDir}`,
    '--lang=en-US',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-search-engine-choice-screen',
    `--window-size=${viewportWidth},${viewportHeight}`,
    startUrl || 'https://chatgpt.com/?openaicom_referred=true',
  ];

  const proc = spawn(executablePath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  proc.unref();

  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  let lastErr = null;
  for (let i = 0; i < 30; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`CDP fallback Chrome exited before connect. exitCode=${proc.exitCode}`);
    }
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      return { browser, proc, cdpUrl };
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }

  try {
    process.kill(proc.pid, 'SIGTERM');
  } catch {
    // ignore
  }
  throw new Error(`CDP fallback connect failed: ${String(lastErr && lastErr.message ? lastErr.message : lastErr)}`);
}

const DOWNLOAD_BUTTON_SELECTORS = [
  'button[aria-label*="Download" i]',
  'button[aria-label*="Save" i]',
  'button[aria-label*="下载"]',
  'button[aria-label*="保存"]',
  'button[title*="Download" i]',
  'button[title*="Save" i]',
  'button[title*="下载"]',
  'button[title*="保存"]',
  '[role="button"][aria-label*="Download" i]',
  '[role="button"][aria-label*="Save" i]',
  '[role="button"][aria-label*="下载"]',
  '[role="button"][aria-label*="保存"]',
  'button[data-testid*="download" i]',
  'button[data-testid*="save" i]',
  'button:has-text("下载")',
  'button:has-text("保存")',
  '[role="button"]:has-text("下载")',
  '[role="button"]:has-text("保存")',
  'a[download]',
];

let activeTraceFile = '';

function log(event, payload = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload });
  console.log(line);
  if (!activeTraceFile) return;
  try {
    fs.appendFileSync(activeTraceFile, `${line}\n`, 'utf8');
  } catch {
    // ignore
  }
}

function writeSummary(summaryPath, payload) {
  fs.writeFileSync(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`SUMMARY_PATH=${summaryPath}`);
}

async function safeShot(page, debugDir, name) {
  try {
    await page.screenshot({
      path: path.join(debugDir, name),
      fullPage: true,
    });
  } catch {
    // ignore
  }
}

async function applyPageZoom(page, zoomValue) {
  const zoom = Number(zoomValue);
  if (!Number.isFinite(zoom) || zoom >= 0.999) return;
  try {
    await page.evaluate((z) => {
      const v = String(z);
      document.documentElement.style.zoom = v;
      if (document.body) document.body.style.zoom = v;
    }, zoom);
  } catch {
    // ignore
  }
}

async function anyVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count() > 0 && await loc.isVisible()) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count() > 0 && await loc.isVisible()) {
        return { locator: loc, selector: sel };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function isGuestMode(page) {
  return anyVisible(page, [
    'button:has-text("Log in")',
    'a:has-text("Log in")',
    'button:has-text("Sign up for free")',
    'a:has-text("Sign up for free")',
    'text=/get responses tailored to you/i',
  ]);
}

async function clickFirstVisible(page, selectors, timeoutMs = 2400) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count() > 0 && await loc.isVisible()) {
        await loc.click({ timeout: timeoutMs });
        return sel;
      }
    } catch {
      // try next selector
    }
  }
  return '';
}

async function ensureImageCreationMode(page) {
  await dismissBlockingDialogs(page);

  const createSelected = await anyVisible(page, [
    'button[aria-pressed="true"]:has-text("Create image")',
    '[role="button"][aria-pressed="true"]:has-text("Create image")',
    'button[aria-pressed="true"]:has-text("创建图片")',
    '[role="button"][aria-pressed="true"]:has-text("创建图片")',
    'button[aria-label*="图片"]',
    '[role="button"][aria-label*="图片"]',
    'button:has-text("图片")',
    '[role="button"]:has-text("图片")',
    'text=/create image/i',
    'text=/创建图片/',
  ]);

  let createPicked = createSelected;
  if (!createSelected) {
    await clickFirstVisible(page, [
      'button[data-testid*="composer-plus" i]',
      'button[aria-label*="Add" i]',
      'button[aria-label*="Plus" i]',
      'button[title*="Add" i]',
      'button[aria-haspopup="menu"]',
      '[role="button"]:has-text("+")',
    ], 1800);
    await page.waitForTimeout(250);

    const picked = await clickFirstVisible(page, [
      '[role="menuitem"]:has-text("Create image")',
      '[role="option"]:has-text("Create image")',
      '[role="menuitem"]:has-text("创建图片")',
      '[role="option"]:has-text("创建图片")',
      '[data-testid*="create-image" i]',
      'button:has-text("Create image")',
      'button:has-text("创建图片")',
      'button:has-text("图片")',
      '[role="button"]:has-text("图片")',
      'text=/create image/i',
      'text=/创建图片/',
      'text=/图片/',
    ], 2200);
    createPicked = Boolean(picked);
  }
  if (!createPicked) {
    throw new Error('ChatGPT image mode was not selected. Click + and choose Create image / 创建图片, then retry.');
  }

  const advancedSelected = await anyVisible(page, [
    'button[aria-pressed="true"]:has-text("Advanced")',
    '[role="button"][aria-pressed="true"]:has-text("Advanced")',
    'button[aria-pressed="true"]:has-text("Extended")',
    '[role="button"][aria-pressed="true"]:has-text("Extended")',
    'button[aria-pressed="true"]:has-text("进阶")',
    '[role="button"][aria-pressed="true"]:has-text("进阶")',
    'button[aria-pressed="true"]:has-text("思考")',
    '[role="button"][aria-pressed="true"]:has-text("思考")',
    'text=/extended/i',
    'text=/进阶/',
    'text=/思考/',
  ]);

  let advancedPicked = advancedSelected;
  if (!advancedSelected) {
    const picked = await clickFirstVisible(page, [
      'button:has-text("Advanced")',
      '[role="button"]:has-text("Advanced")',
      'button:has-text("Extended")',
      '[role="button"]:has-text("Extended")',
      'button:has-text("进阶")',
      '[role="button"]:has-text("进阶")',
      'button:has-text("思考")',
      '[role="button"]:has-text("思考")',
      'text=/extended/i',
      'text=/进阶/',
      'text=/思考/',
    ], 1800);
    if (picked) {
      advancedPicked = true;
      await page.waitForTimeout(180);
    }
  }
  if (!advancedPicked) {
    throw new Error('ChatGPT advanced mode was not selected. Select Advanced / 进阶, then retry.');
  }

  log('image_mode_ensured', {
    create_image_selected: Boolean(createPicked),
    advanced_selected: Boolean(advancedPicked),
  });
}

async function isComposerBusy(page) {
  return anyVisible(page, [
    '[role="progressbar"]',
    'svg.animate-spin',
    'svg[class*="spin" i]',
    '[class*="spinner" i]',
    '[class*="loading" i]',
    '[aria-label*="uploading" i]',
    '[data-testid*="uploading" i]',
    'text=/uploading/i',
    'text=/processing/i',
    'text=/creating image/i',
    '[aria-busy="true"]',
  ]);
}

async function waitForAttachmentSettled(page, timeoutMs = 60000) {
  const start = Date.now();
  let sawBusy = false;
  let stableSince = 0;
  while (Date.now() - start < timeoutMs) {
    const busy = await isComposerBusy(page);
    if (busy) {
      sawBusy = true;
      stableSince = 0;
      await page.waitForTimeout(800);
      continue;
    }

    const composer = await findComposer(page);
    if (composer) {
      const text = await readComposerText(page);
      if (text !== undefined) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 3000) {
          log('attachment_settled', { sawBusy });
          return true;
        }
      }
    }
    await page.waitForTimeout(600);
  }
  log('attachment_settle_timeout');
  return false;
}

async function maybeClickRetry(page) {
  const retry = await firstVisible(page, [
    'button:has-text("Retry")',
    '[role="button"]:has-text("Retry")',
    'a:has-text("Retry")',
  ]);
  if (!retry) return false;
  try {
    await retry.locator.click({ timeout: 2500, force: true });
    log('retry_clicked');
    return true;
  } catch {
    try {
      await retry.locator.evaluate((el) => el.click());
      log('retry_clicked');
      return true;
    } catch {
      return false;
    }
  }
}

async function hasRequestErrorBanner(page) {
  return anyVisible(page, [
    'text=/something went wrong while processing your request/i',
    'text=/something went wrong/i',
    'text=/please try again/i',
  ]);
}

async function dismissBlockingDialogs(page) {
  try {
    const survey = page.locator('text=/Would you use ChatGPT again/i').first();
    if (await survey.count() > 0 && await survey.isVisible()) {
      const noBtn = page.locator('button:has-text("No")').first();
      if (await noBtn.count() > 0 && await noBtn.isVisible()) {
        await noBtn.click({ timeout: 1200 });
        await page.waitForTimeout(120);
      }
    }
  } catch {
    // ignore survey close failures
  }

  const selectors = [
    'button[aria-label*="close" i]',
    'button[title*="close" i]',
    'button:has-text("Close")',
    'button:has-text("Not now")',
    'button:has-text("Maybe later")',
    'button:has-text("Skip")',
    'button:has-text("Cancel")',
    'button:has-text("Dismiss")',
    '[role="dialog"] button[aria-label*="close" i]',
    '[aria-modal="true"] button[aria-label*="close" i]',
  ];

  for (let round = 0; round < 4; round++) {
    let acted = false;
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.count() > 0 && await loc.isVisible()) {
          await loc.click({ timeout: 1200 });
          acted = true;
          await page.waitForTimeout(200);
        }
      } catch {
        // next
      }
    }
    if (!acted) break;
  }
}

async function closeMediaViewerIfOpen(page) {
  try {
    const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
    const count = await dialogs.count();
    for (let i = count - 1; i >= 0; i--) {
      const dialog = dialogs.nth(i);
      let shouldClose = false;
      try {
        if (!(await dialog.isVisible())) continue;
        shouldClose = await dialog.evaluate((el) => {
          const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.toLowerCase();
          const hasImage = Boolean(el.querySelector('img, canvas, video'));
          const looksLikeViewer = /media|viewer|preview|image|photo|edit|download|图片|图像|预览|媒体|查看/.test(label);
          return hasImage || looksLikeViewer;
        });
      } catch {
        // keep default false
      }
      if (shouldClose) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(450);
        log('media_viewer_closed', { index: i });
        return true;
      }
    }
  } catch {
    // ignore overlay cleanup failures
  }
  return false;
}

async function findComposer(page) {
  const selectors = [
    '#prompt-textarea',
    'textarea#prompt-textarea',
    'textarea[placeholder*="Message" i]',
    'textarea[aria-label*="message" i]',
    'textarea[data-testid="prompt-textarea"]',
    'div#prompt-textarea[contenteditable="true"]',
    '[contenteditable="true"][data-testid*="prompt" i]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
  ];

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count() > 0 && await loc.isVisible()) {
        return { locator: loc, selector: sel };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function detectManualGate(page) {
  const url = String(page.url() || '');

  if (/__cf_chl_rt_tk=/i.test(url) || /cdn-cgi\/challenge-platform/i.test(url)) {
    return {
      state: 'cloudflare',
      detail: url,
    };
  }

  if (await anyVisible(page, [
    'text=/verify you are human/i',
    'text=/just a moment/i',
    'iframe[title*="Cloudflare" i]',
    'iframe[src*="cloudflare" i]',
    'div:has-text("Cloudflare")',
    'label:has-text("Verify you are human")',
  ])) {
    return {
      state: 'cloudflare',
      detail: url || 'cloudflare_challenge',
    };
  }

  if (await anyVisible(page, [
    'button:has-text("Log in")',
    'a:has-text("Log in")',
    'button:has-text("Sign in")',
    'a:has-text("Sign in")',
    'input[type="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
    'button:has-text("Continue with Google")',
    'button:has-text("Continue with Apple")',
    'button:has-text("Continue with Microsoft")',
    'text=/welcome back/i',
    'text=/continue with google/i',
    'text=/continue with apple/i',
    'text=/continue with microsoft/i',
  ])) {
    return {
      state: 'login',
      detail: url || 'login_gate',
    };
  }

  if (/auth\.openai\.com/i.test(url) || /chatgpt\.com\/auth/i.test(url) || /\/login/i.test(url)) {
    return {
      state: 'login',
      detail: url,
    };
  }

  try {
    const booting = await page.evaluate(() => {
      const hasComposer = Boolean(
        document.querySelector(
          '#prompt-textarea, textarea#prompt-textarea, textarea[placeholder*="Message" i], textarea[aria-label*="message" i], [contenteditable="true"][role="textbox"]',
        ),
      );
      if (hasComposer) return false;
      const text = (document.body?.innerText || '').trim();
      const interactive = document.querySelectorAll(
        'button, a, input, textarea, [role="button"], [role="textbox"]',
      ).length;
      const hasLogoLike = Boolean(
        document.querySelector(
          '[class*="logo" i], [class*="logomark" i], [data-testid*="logo" i], svg',
        ),
      );
      return hasLogoLike && interactive <= 1 && text.length <= 12;
    });
    if (booting) {
      return {
        state: 'booting',
        detail: url || 'chatgpt_booting',
      };
    }
  } catch {
    // ignore evaluate failures and continue as unknown
  }

  return {
    state: 'unknown',
    detail: url,
  };
}

async function maybeOpenLogin(page) {
  const login = await firstVisible(page, [
    'button:has-text("Log in")',
    'a:has-text("Log in")',
    'button:has-text("Sign in")',
    'a:has-text("Sign in")',
  ]);
  if (!login) return false;
  try {
    await login.locator.click({ timeout: 2500, force: true });
    return true;
  } catch {
    try {
      await login.locator.evaluate((el) => el.click());
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForComposer(page, timeoutMs, opts = {}) {
  const debugDir = String(opts.debugDir || '').trim();
  const baseUrl = String(opts.baseUrl || 'https://chatgpt.com/?openaicom_referred=true').trim();
  const start = Date.now();
  let lastGateState = '';
  let lastBlockingGateState = '';
  let loginClicked = false;
  let cloudflareSince = 0;
  let unknownSince = 0;
  let bootingSince = 0;
  let lastReloadAt = 0;
  let unknownReloadCount = 0;
  let unknownRecoverTried = false;
  while (Date.now() - start < timeoutMs) {
    await dismissBlockingDialogs(page);
    const composer = await findComposer(page);
    const guestMode = await isGuestMode(page);
    if (composer && !guestMode) return composer;

    const gate = await detectManualGate(page);
    if (guestMode && gate.state === 'unknown') {
      gate.state = 'login';
      gate.detail = gate.detail || page.url();
    }

    const now = Date.now();
    if (gate.state === 'cloudflare') {
      if (!cloudflareSince) cloudflareSince = now;
    } else {
      cloudflareSince = 0;
    }
    if (gate.state === 'unknown') {
      if (!unknownSince) unknownSince = now;
    } else {
      unknownSince = 0;
    }
    if (gate.state === 'booting') {
      if (!bootingSince) bootingSince = now;
    } else {
      bootingSince = 0;
    }

    if (gate.state === 'cloudflare' || gate.state === 'login') {
      lastBlockingGateState = gate.state;
    }
    if (gate.state !== lastGateState) {
      lastGateState = gate.state;
      log('manual_gate_state', { state: gate.state, detail: gate.detail });
      if (debugDir) {
        await safeShot(page, debugDir, `gate_${gate.state}_${nowTag()}.png`);
      }
    }

    if (!loginClicked && gate.state === 'login') {
      const clicked = await maybeOpenLogin(page);
      if (clicked) {
        loginClicked = true;
        log('manual_gate_login_open_clicked');
        await page.waitForTimeout(1200);
        continue;
      }
    }

    const stuckCloudflare = cloudflareSince && (now - cloudflareSince >= 45000);
    const stuckUnknown = unknownSince && (now - unknownSince >= 60000);
    const canReload = (now - lastReloadAt >= 35000);
    if (canReload && (stuckCloudflare || stuckUnknown)) {
      if (stuckUnknown && unknownReloadCount >= 3) {
        throw new Error('ChatGPT page is stuck before composer appears. Please refresh/login and retry.');
      }
      lastReloadAt = now;
      const reason = stuckCloudflare ? 'cloudflare_stuck' : 'unknown_stuck';
      log('manual_gate_reload', { reason, url: page.url() });
      try {
        if (stuckUnknown) {
          unknownReloadCount += 1;
          // First unknown-stuck recovery: hard navigate to base URL.
          if (!unknownRecoverTried) {
            unknownRecoverTried = true;
            await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          } else {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          }
          // If still unknown after multiple recoveries, fail fast instead of endless waiting.
          if (unknownReloadCount >= 3) {
            throw new Error('ChatGPT page is stuck before composer appears. Please refresh/login and retry.');
          }
        } else {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        }
        await page.waitForTimeout(1200);
        continue;
      } catch (err) {
        if (stuckUnknown && unknownReloadCount >= 3) {
          throw err;
        }
        // keep polling until timeout
      }
    }

    const stuckBooting = bootingSince && (now - bootingSince >= 120000);
    if (stuckBooting && (now - lastReloadAt >= 45000)) {
      lastReloadAt = now;
      log('manual_gate_reload', { reason: 'booting_stuck', url: page.url() });
      try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch {
        // keep polling
      }
    }

    await page.waitForTimeout(1000);
  }

  if (lastBlockingGateState === 'cloudflare') {
    throw new Error('Cloudflare verification not completed. Please verify you are human in the ChatGPT browser window and try again.');
  }
  if (lastBlockingGateState === 'login') {
    throw new Error('ChatGPT login not completed. Please log in in the ChatGPT browser window and try again.');
  }
  throw new Error('ChatGPT composer not found. Please refresh/login and keep the chat page open.');
}

async function fillComposer(page, text) {
  await dismissBlockingDialogs(page);
  await closeMediaViewerIfOpen(page);
  const composer = await findComposer(page);
  if (!composer) throw new Error('composer not found while typing');

  const loc = composer.locator;
  const tag = await loc.evaluate((el) => (el.tagName || '').toLowerCase()).catch(() => '');
  const safeText = String(text || '').replace(/\r\n/g, '\n').trim();
  log('composer_fill', { length: safeText.length, preview: safeText.slice(0, 180) });

  if (tag === 'textarea' || tag === 'input') {
    await loc.fill(safeText);
    return;
  }

  try {
    await loc.click({ timeout: 5000 });
  } catch {
    await closeMediaViewerIfOpen(page);
    await loc.click({ timeout: 5000 });
  }
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText(safeText);
}

async function readComposerText(page) {
  const composer = await findComposer(page);
  if (!composer) return '';
  try {
    return await composer.locator.evaluate((el) => {
      const v = (el.value ?? '').toString();
      const t = (el.textContent ?? '').toString();
      return (v || t).replace(/\s+/g, ' ').trim();
    });
  } catch {
    return '';
  }
}

async function clickNewChat(page) {
  const selectors = [
    'a[aria-label*="New chat" i]',
    'button[aria-label*="New chat" i]',
    'button[data-testid*="new-chat" i]',
    'a[data-testid*="new-chat" i]',
    'button:has-text("New chat")',
    'a:has-text("New chat")',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count() > 0 && await loc.isVisible()) {
        await loc.click({ timeout: 2500 });
        await page.waitForTimeout(1200);
        return true;
      }
    } catch {
      // next
    }
  }
  return false;
}

async function attachImage(page, imagePath) {
  await dismissBlockingDialogs(page);
  log('attach_image_start', { image: path.basename(String(imagePath || '')) });

  const directInputs = page.locator('input[type="file"]');
  const count = await directInputs.count();
  for (let i = 0; i < count; i++) {
    const loc = directInputs.nth(i);
    try {
      await loc.setInputFiles(imagePath, { timeout: 4500 });
      await page.waitForTimeout(800);
      await waitForAttachmentSettled(page);
      log('attach_image_done', { image: path.basename(String(imagePath || '')), method: 'direct_input' });
      return true;
    } catch {
      // next
    }
  }

  const openers = [
    'button[aria-label*="Attach" i]',
    'button[aria-label*="Upload" i]',
    'button[data-testid*="composer-plus" i]',
    'button[data-testid*="upload" i]',
    'button:has-text("Attach")',
    'button:has-text("Upload")',
    'button:has-text("Add photos")',
  ];

  for (const sel of openers) {
    const opener = page.locator(sel).first();
    try {
      if (!(await opener.count()) || !(await opener.isVisible())) continue;
      await opener.click({ timeout: 2500 });
      await page.waitForTimeout(400);

      const again = page.locator('input[type="file"]');
      const inputCount = await again.count();
      for (let i = 0; i < inputCount; i++) {
        const input = again.nth(i);
        try {
          await input.setInputFiles(imagePath, { timeout: 4500 });
          await page.waitForTimeout(800);
          await waitForAttachmentSettled(page);
          log('attach_image_done', { image: path.basename(String(imagePath || '')), method: `menu_input:${sel}` });
          return true;
        } catch {
          // next
        }
      }
    } catch {
      // next
    }
  }

  log('attach_image_failed', { image: path.basename(String(imagePath || '')) });
  return false;
}

function getSendSelectors() {
  return [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-submit-button"]',
    'form button[type="submit"]',
    '[data-testid*="composer"] button[type="submit"]',
    'button[aria-label*="Send prompt" i]',
    'button[aria-label*="Send message" i]',
    'button[aria-label*="Send" i]',
    'button:has-text("Send")',
  ];
}

function getBusySelectors() {
  return [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop" i]',
    'button:has-text("Stop")',
    'text=/thinking/i',
    'text=/analyzing/i',
    'text=/searching/i',
    'svg.animate-spin',
  ];
}

async function waitForSendReady(page, timeoutMs = 12000) {
  const started = Date.now();
  const selectors = [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-submit-button"]',
    'form button[type="submit"]',
    '[data-testid*="composer"] button[type="submit"]',
  ];
  while (Date.now() - started < timeoutMs) {
    for (const sel of selectors) {
      const btn = page.locator(sel).last();
      try {
        if (await btn.count() > 0 && await btn.isVisible()) {
          if (await btn.isEnabled()) {
            return true;
          }
        }
      } catch {
        // try next
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function clickSend(page, options = {}) {
  const allowEnterFallback = options.allowEnterFallback !== false;
  try {
    const composer = await findComposer(page);
    if (composer) {
      try {
        await composer.locator.click({ timeout: 1200 });
      } catch {
        // ignore focus click failure
      }
    }

    const sendSelectors = [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-submit-button"]',
      'form button[type="submit"]',
      '[data-testid*="composer"] button[type="submit"]',
    ];
    for (const sel of sendSelectors) {
      const btn = page.locator(sel).last();
      try {
        if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
          await btn.click({ timeout: 1200 });
          log('send_clicked', { method: `button:${sel}` });
          return true;
        }
      } catch {
        // try next selector
      }
    }

    // Fallback: force click visible send button even when enabled-state detection is stale.
    for (const sel of sendSelectors) {
      const btn = page.locator(sel).last();
      try {
        if (await btn.count() > 0 && await btn.isVisible()) {
          await btn.click({ timeout: 1200, force: true });
          log('send_clicked', { method: `button_force:${sel}` });
          return true;
        }
      } catch {
        // try next selector
      }
    }

    if (allowEnterFallback) {
      await page.keyboard.press('Enter');
      log('send_clicked', { method: 'enter_key' });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function getAssistantMessages(page) {
  try {
    const messages = await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const roots = Array.from(document.querySelectorAll(
        'div[data-message-author-role="assistant"], article[data-testid^="conversation-turn-"], [data-testid*="conversation-turn"]'
      )).filter(visible);
      const out = [];
      for (const root of roots) {
        const role = (root.getAttribute('data-message-author-role') || '').toLowerCase();
        if (role && role !== 'assistant') continue;
        const text = (root.innerText || root.textContent || '').replace(/\s+\n/g, '\n').trim();
        out.push(text || '');
      }
      return out;
    });
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

async function waitForAssistantReply(page, opts) {
  const timeoutMs = opts.timeoutMs;
  const idleNoBusyMs = opts.idleNoBusyMs;
  const baselineCount = opts.baselineCount;
  const baselineLast = opts.baselineLast;
  const postIdlePollSec = opts.postIdlePollSec || 0;
  const returnOnNeedsInputs = Boolean(opts.returnOnNeedsInputs);

  const start = Date.now();
  let seenBusy = false;
  let idleStart = 0;
  let lastObserved = baselineLast || '';
  let retriedError = false;

  while (Date.now() - start < timeoutMs) {
    await dismissBlockingDialogs(page);
    if (await hasRequestErrorBanner(page)) {
      if (!retriedError) {
        const clicked = await maybeClickRetry(page);
        if (clicked) {
          retriedError = true;
          idleStart = 0;
          seenBusy = false;
          await page.waitForTimeout(1500);
          continue;
        }
      }
      throw new Error('ChatGPT returned "Something went wrong".');
    }
    const busy = await anyVisible(page, getBusySelectors());
    const messages = await getAssistantMessages(page);
    const latest = messages.length ? messages[messages.length - 1] : '';
    if (latest) lastObserved = latest;
    const changed = messages.length > baselineCount || latest !== baselineLast;

    if (!busy) {
      const readyButtons = await collectVisibleDownloadButtons(page.locator('body').first()).catch(() => []);
      if (readyButtons.length > 0 && (changed || seenBusy)) {
        await page.waitForTimeout(1200);
        log('assistant_ready_by_download_button', { count: readyButtons.length, changed, seenBusy });
        return {
          replyText: latest || lastObserved,
          seenBusy,
          assistantCount: messages.length,
          timedOut: false,
        };
      }
    }

    if (changed && returnOnNeedsInputs && detectNeedsInputsText(latest || lastObserved)) {
      return {
        replyText: latest || lastObserved,
        seenBusy,
        assistantCount: messages.length,
        timedOut: false,
      };
    }

    if (busy) {
      seenBusy = true;
      idleStart = 0;
    } else if (changed) {
      if (!idleStart) idleStart = Date.now();
      if (Date.now() - idleStart >= idleNoBusyMs) {
        if (postIdlePollSec > 0) await page.waitForTimeout(postIdlePollSec * 1000);
        return {
          replyText: latest || lastObserved,
          seenBusy,
          assistantCount: messages.length,
          timedOut: false,
        };
      }
    }

    await page.waitForTimeout(900);
  }

  if (lastObserved && lastObserved !== baselineLast) {
    return {
      replyText: lastObserved,
      seenBusy,
      assistantCount: baselineCount + 1,
      timedOut: true,
    };
  }
  throw new Error('Timed out while waiting for ChatGPT reply.');
}

function buildTasks() {
  return [
    { id: 'main_01', phase: 'main', idx: 1, width: 1600, height: 1600 },
    { id: 'main_02', phase: 'main', idx: 2, width: 1600, height: 1600 },
    { id: 'main_03', phase: 'main', idx: 3, width: 1600, height: 1600 },
    { id: 'main_04', phase: 'main', idx: 4, width: 1600, height: 1600 },
    { id: 'main_05', phase: 'main', idx: 5, width: 1600, height: 1600 },
    { id: 'main_06', phase: 'main', idx: 6, width: 1600, height: 1600 },
    { id: 'main_07', phase: 'main', idx: 7, width: 1600, height: 1600 },
    { id: 'aplus_01', phase: 'a_plus', idx: 8, width: 970, height: 600 },
    { id: 'aplus_02', phase: 'a_plus', idx: 9, width: 970, height: 600 },
    { id: 'aplus_03', phase: 'a_plus', idx: 10, width: 970, height: 600 },
    { id: 'aplus_04', phase: 'a_plus', idx: 11, width: 970, height: 600 },
  ];
}

function repairMojibakeText(value) {
  let fixed = String(value || '');
  try {
    const hasReplacement = /\uFFFD/.test(fixed);
    const looksLikeLatin1Utf8 = /(?:\u00C3.|\u00C2.|\u00D0.|\u00D1.)/.test(fixed);
    if (hasReplacement || looksLikeLatin1Utf8) {
      const utf8FromLatin1 = Buffer.from(fixed, 'latin1').toString('utf8');
      if (utf8FromLatin1 && !/\uFFFD/.test(utf8FromLatin1)) {
        fixed = utf8FromLatin1;
      }
    }
  } catch {
    // ignore
  }
  try {
    if (/[\uE000-\uF8FF]/.test(fixed)) {
      const utf8FromGbk = iconv.decode(iconv.encode(fixed, 'gbk'), 'utf8');
      if (utf8FromGbk && !/[\uE000-\uF8FF]/.test(utf8FromGbk)) fixed = utf8FromGbk;
    }
  } catch {
    // ignore
  }
  return fixed;
}

function normalizeKeywordsForPrompt(value) {
  return repairMojibakeText(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((one) => one.trim())
    .filter(Boolean)
    .join('\n');
}

function renderPromptTemplate(template, keywordsText) {
  const tpl = String(template || '').trim();
  const keywords = normalizeKeywordsForPrompt(keywordsText);
  if (!tpl) return '';

  if (/\{\{\s*KEYWORDS\s*\}\}/i.test(tpl)) {
    return tpl.replace(/\{\{\s*KEYWORDS\s*\}\}/gi, keywords).trim();
  }
  if (/product keywords[:\s]/i.test(tpl)) {
    return tpl.trim();
  }
  return `${tpl}\n\n产品关键词：\n${keywords}`.trim();
}

function getRemainingTasks(tasks, doneCount) {
  return tasks.slice(Math.max(0, doneCount));
}

function buildMissingSummary(tasks, doneCount) {
  const remaining = getRemainingTasks(tasks, doneCount);
  const main = remaining.filter((t) => t.phase === 'main');
  const aplus = remaining.filter((t) => t.phase === 'a_plus');
  const labels = remaining.map((task) => {
    if (task.phase === 'main') return `Main #${task.idx}`;
    return `A+ #${task.idx - 7}`;
  });
  return {
    remaining,
    mainCount: main.length,
    aplusCount: aplus.length,
    labels,
  };
}

function buildContinuationPrompt(tasks, doneCount, keywordsText, reason = '') {
  const missing = buildMissingSummary(tasks, doneCount);
  const reasonLine = reason ? `补充说明：${reason}` : '';
  return [
    '请继续完成尚未生成的图片，只生成缺少的图片。',
    '必须遵守以下要求：',
    '1. 不要改变产品结构、颜色、材质和比例。',
    '2. 已经完成的图片不要重复生成。',
    '3. 只生成缺少的图片。',
    `4. 还缺少：主图 ${missing.mainCount} 张，A+ 图 ${missing.aplusCount} 张。`,
    `5. 缺少清单：${missing.labels.join(', ') || '无'}。`,
    '6. 主图尺寸必须是 1600x1600，A+ 图尺寸必须是 970x600。',
    '7. 第 1 张主图必须是纯白背景且只能有产品。',
    '8. 保持日本亚马逊风格，图片要高质量清晰。',
    '9. 使用当前对话里已经上传的产品图片和当前关键词，不要要求我重新上传。',
    '产品关键词：',
    normalizeKeywordsForPrompt(keywordsText),
    reasonLine,
  ].filter(Boolean).join('\n');
}

function buildTaskPrompt(task, attempt) {
  const n = Number(task && task.idx) || 1;
  const retry = Number(attempt) > 1;
  if (task && task.phase === 'a_plus') {
    const aplusNo = Math.max(1, n - 7);
    if (retry) {
      return `我没有看到可下载的图片。请重新生成第 ${aplusNo} 张 A+ 页面图（970x600）。`;
    }
    return `请继续生成第 ${aplusNo} 张 A+ 页面图（970x600）。`;
  }
  if (retry) {
    return `我没有看到可下载的图片。请重新生成第 ${n} 张主图（1600x1600）。`;
  }
  return `请继续生成第 ${n} 张主图（1600x1600）。`;
}

function detectNeedsInputsText(text) {
  const s = String(text || '').replace(/\s+/g, ' ').toLowerCase();
  if (!s) return false;
  return (
    /please send .*product images/i.test(s) ||
    /please upload .*product images/i.test(s) ||
    /please send .*keywords/i.test(s) ||
    /please provide .*keywords/i.test(s) ||
    /please provide .*product images/i.test(s) ||
    /i need .*product images/i.test(s) ||
    /i need .*keywords/i.test(s) ||
    /send .*product images/i.test(s) ||
    /upload .*product images/i.test(s) ||
    /send .*keywords/i.test(s) ||
    /provide .*keywords/i.test(s) ||
    /发送.*产品图片/.test(s) ||
    /上传.*产品图片/.test(s) ||
    /发送.*关键词/.test(s) ||
    /提供.*关键词/.test(s) ||
    /等待.*产品图片/.test(s) ||
    /等待.*关键词/.test(s)
  );
}
function getDefaultDownloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

function snapshotDownloadDir(dir) {
  const map = new Map();
  if (!fileExists(dir)) return map;
  for (const one of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!one.isFile()) continue;
    const full = path.join(dir, one.name);
    try {
      const st = fs.statSync(full);
      map.set(one.name, { size: st.size, mtimeMs: st.mtimeMs, full });
    } catch {
      // ignore
    }
  }
  return map;
}

async function waitForFreshDownloadedFile(dir, before, startedAtMs, timeoutMs) {
  const started = Number(startedAtMs) || Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fileExists(dir)) {
      const rows = fs.readdirSync(dir, { withFileTypes: true })
        .filter((one) => one.isFile())
        .map((one) => {
          const full = path.join(dir, one.name);
          try {
            const st = fs.statSync(full);
            return { name: one.name, full, size: st.size, mtimeMs: st.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((one) => one.mtimeMs >= started - 1000)
        .filter((one) => !/\.crdownload$/i.test(one.name))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const one of rows) {
        const prev = before.get(one.name);
        const changed = !prev || prev.size !== one.size || prev.mtimeMs !== one.mtimeMs;
        if (changed && one.size > 0) return one;
      }
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return null;
}

function detectImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return { format: '', width: 0, height: 0 };

  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (size < 2) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { format: 'jpeg', width, height };
      }
      offset += 2 + size;
    }
  }

  if (
    buffer.length >= 30 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunk = buffer.slice(12, 16).toString('ascii');
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { format: 'webp', width, height };
    }
  }

  return { format: '', width: 0, height: 0 };
}

function normalizeExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.jpeg') return '.jpg';
  if (['.png', '.jpg', '.webp'].includes(e)) return e;
  return '';
}

function pickImageExt(fileName, format) {
  const fromName = normalizeExt(path.extname(String(fileName || '')));
  if (fromName) return fromName;
  if (format === 'png') return '.png';
  if (format === 'jpeg') return '.jpg';
  if (format === 'webp') return '.webp';
  return '.png';
}

async function collectVisibleDownloadButtons(root) {
  const locator = root.locator(DOWNLOAD_BUTTON_SELECTORS.join(', '));
  const count = await locator.count();
  const visible = [];
  for (let i = 0; i < count; i++) {
    const one = locator.nth(i);
    try {
      if (await one.isVisible()) visible.push(one);
    } catch {
      // ignore
    }
  }
  return visible;
}

async function collectThumbnailButtons(root) {
  const locator = root.locator('button:has(img), [role="button"]:has(img)');
  const count = await locator.count();
  const thumbs = [];
  for (let i = 0; i < count; i++) {
    const one = locator.nth(i);
    try {
      if (!(await one.isVisible())) continue;
      const box = await one.boundingBox();
      if (!box) continue;
      if (box.width < 24 || box.height < 24) continue;
      if (box.width > 260 || box.height > 260) continue;
      thumbs.push(one);
    } catch {
      // ignore
    }
  }
  return thumbs;
}

async function collectLatestAssistantDownloadButtons(page) {
  const roots = page.locator('div[data-message-author-role], article[data-testid^="conversation-turn-"], [data-testid*="conversation-turn"]');
  const rootCount = await roots.count();
  for (let r = rootCount - 1; r >= 0; r--) {
    const root = roots.nth(r);
    let maybeAssistant = true;
    try {
      maybeAssistant = await root.evaluate((el) => {
        const role = (el.getAttribute('data-message-author-role') || '').toLowerCase();
        if (role) return role === 'assistant';
        return true;
      });
    } catch {
      maybeAssistant = true;
    }
    if (!maybeAssistant) continue;
    const visible = await collectVisibleDownloadButtons(root);
    if (visible.length) {
      return { rootIndex: r, root, buttons: visible };
    }
    try {
      const imageCount = await root.locator('img').count();
      if (imageCount > 0) {
        return { rootIndex: r, root, buttons: [] };
      }
    } catch {
      // keep scanning older turns
    }
  }
  return { rootIndex: -1, root: null, buttons: [] };
}

async function tryOpenLargestImageInRoot(root) {
  try {
    const imgs = root.locator('img');
    const count = await imgs.count();
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < count; i++) {
      const one = imgs.nth(i);
      if (!(await one.isVisible())) continue;
      const box = await one.boundingBox();
      if (!box) continue;
      const area = box.width * box.height;
      if (area > bestArea && box.width >= 180 && box.height >= 180) {
        best = one;
        bestArea = area;
      }
    }
    if (!best) return false;
    await best.click({ timeout: 3000 });
    await root.page().waitForTimeout(500);
    return true;
  } catch {
    return false;
  }
}

async function collectGeneratedImageSources(root) {
  try {
    return await root.locator('img').evaluateAll((imgs) => {
      const rows = [];
      const seen = new Set();
      for (const img of imgs) {
        const alt = String(img.getAttribute('alt') || '');
        const src = String(img.currentSrc || img.src || '');
        if (!src || seen.has(src)) continue;
        if (/uploaded|已上传|上传的图片/i.test(alt)) continue;
        const rect = img.getBoundingClientRect();
        const isGeneratedAlt = /generated|已生成/i.test(alt);
        const looksLarge = rect.width >= 240 && rect.height >= 240;
        if (!isGeneratedAlt && !looksLarge) continue;
        seen.add(src);
        rows.push({ src, alt, width: Math.round(rect.width), height: Math.round(rect.height) });
      }
      return rows;
    });
  } catch {
    return [];
  }
}

async function fetchImageBytesFromPage(page, src) {
  try {
    const data = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type') || '';
      const buffer = await response.arrayBuffer();
      return {
        contentType,
        bytes: Array.from(new Uint8Array(buffer)),
      };
    }, src);
    if (!data || !Array.isArray(data.bytes) || !data.bytes.length) return null;
    return {
      bytes: Buffer.from(data.bytes),
      contentType: data.contentType || '',
    };
  } catch {
    return null;
  }
}

function makeTaskFileBase(outputDir, task) {
  return path.join(outputDir, `${String(task.idx).padStart(2, '0')}_${task.id}_${task.width}x${task.height}`);
}

async function clickAndCaptureDownload(page, locator, debugDir, label) {
  const downloadsDir = getDefaultDownloadsDir();
  const before = snapshotDownloadDir(downloadsDir);
  const started = Date.now();
  const tmpBase = path.join(debugDir, `_dl_${Date.now()}_${Math.random().toString(36).slice(2)}_${label}`);

  let dl = null;
  const waitPromise = page.waitForEvent('download', { timeout: 12000 }).catch(() => null);
  try {
    await locator.click({ timeout: 4000 });
  } catch {
    try {
      await locator.click({ timeout: 4000, force: true });
    } catch {
      return { ok: false, error: 'click failed' };
    }
  }
  dl = await waitPromise;

  let bytes = null;
  let sourceName = '';
  let method = '';

  if (dl) {
    sourceName = dl.suggestedFilename() || '';
    const tempPath = `${tmpBase}${normalizeExt(path.extname(sourceName)) || '.bin'}`;
    try {
      await dl.saveAs(tempPath);
      bytes = fs.readFileSync(tempPath);
      method = 'playwright_download_event';
    } catch {
      // fallback below
    }
  }

  if (!bytes) {
    const fresh = await waitForFreshDownloadedFile(downloadsDir, before, started, 12000);
    if (fresh && fileExists(fresh.full)) {
      sourceName = fresh.name;
      bytes = fs.readFileSync(fresh.full);
      method = 'downloads_dir_fallback';
    }
  }

  if (!bytes || !bytes.length) {
    return { ok: false, error: 'download bytes not found' };
  }

  const dim = detectImageDimensions(bytes);
  const ext = pickImageExt(sourceName, dim.format);
  const tempPath = `${tmpBase}${ext}`;
  fs.writeFileSync(tempPath, bytes);

  return {
    ok: true,
    tempPath,
    bytes,
    hash: crypto.createHash('sha1').update(bytes).digest('hex'),
    ext,
    width: dim.width || 0,
    height: dim.height || 0,
    method,
  };
}

async function harvestLatestTurnImages(page, outputDir, debugDir, tasks, taskStartIndex, seenHashes, options = {}) {
  if (taskStartIndex >= tasks.length) return [];
  const latest = await collectLatestAssistantDownloadButtons(page);
  const openOverlayFallback = options.openOverlayFallback !== false;

  const saved = [];
  let workingButtons = latest.buttons || [];

  // Fallback: if no direct download button is visible in the assistant turn,
  // click the largest image in the turn, then search download controls globally (viewer overlay).
  if (!workingButtons.length && openOverlayFallback) {
    const rootForImageOpen = latest.root || page.locator('body').first();
    const opened = await tryOpenLargestImageInRoot(rootForImageOpen);
    if (opened) {
      await page.waitForTimeout(600);
      workingButtons = await collectVisibleDownloadButtons(page.locator('body').first());
      if (workingButtons.length) {
        log('download_buttons_found_in_overlay', { rootIndex: latest.rootIndex, count: workingButtons.length });
      }
    }
  }
  if (!workingButtons.length) return [];

  const trySaveByButton = async (btn, label) => {
    const targetIndex = taskStartIndex + saved.length;
    if (targetIndex >= tasks.length) return false;
    const task = tasks[targetIndex];
    const one = await clickAndCaptureDownload(page, btn, debugDir, `${task.id}_${label}`);
    if (!one.ok) return false;

    if (seenHashes.has(one.hash)) {
      try {
        fs.unlinkSync(one.tempPath);
      } catch {
        // ignore
      }
      return false;
    }

    const base = makeTaskFileBase(outputDir, task);
    const finalPath = `${base}${one.ext}`;
    fs.copyFileSync(one.tempPath, finalPath);
    try {
      fs.unlinkSync(one.tempPath);
    } catch {
      // ignore
    }

    seenHashes.add(one.hash);
    saved.push({
      task_id: task.id,
      file: path.basename(finalPath),
      width: one.width,
      height: one.height,
      method: one.method,
      hash: one.hash,
    });
    log('image_saved', {
      task: task.id,
      file: path.basename(finalPath),
      size: `${one.width}x${one.height}`,
      method: one.method,
    });
    await page.waitForTimeout(300);
    return true;
  };

  const trySaveBySource = async (srcInfo, label) => {
    const targetIndex = taskStartIndex + saved.length;
    if (targetIndex >= tasks.length) return false;
    const task = tasks[targetIndex];
    const fetched = await fetchImageBytesFromPage(page, srcInfo.src);
    if (!fetched || !fetched.bytes || !fetched.bytes.length) return false;
    const dim = detectImageDimensions(fetched.bytes);
    const ext = fetched.contentType.includes('jpeg') ? '.jpg'
      : fetched.contentType.includes('webp') ? '.webp'
        : fetched.contentType.includes('png') ? '.png'
          : pickImageExt('', dim.format);
    const hash = crypto.createHash('sha1').update(fetched.bytes).digest('hex');
    if (seenHashes.has(hash)) return false;
    const finalPath = `${makeTaskFileBase(outputDir, task)}${ext}`;
    fs.writeFileSync(finalPath, fetched.bytes);
    seenHashes.add(hash);
    saved.push({
      task_id: task.id,
      file: path.basename(finalPath),
      width: dim.width || 0,
      height: dim.height || 0,
      method: 'page_image_src',
      hash,
      source_alt: srcInfo.alt || '',
    });
    log('image_saved', {
      task: task.id,
      file: path.basename(finalPath),
      size: `${dim.width || 0}x${dim.height || 0}`,
      method: 'page_image_src',
      label,
    });
    return true;
  };

  if (!workingButtons.length) {
    const sources = await collectGeneratedImageSources(latest.root || page.locator('body').first());
    for (let i = 0; i < sources.length; i++) {
      if (taskStartIndex + saved.length >= tasks.length) break;
      await trySaveBySource(sources[i], `src_${i}`);
    }
  }

  const thumbs = latest.root ? await collectThumbnailButtons(latest.root) : [];
  if (thumbs.length > 1) {
    for (let i = 0; i < thumbs.length; i++) {
      if (taskStartIndex + saved.length >= tasks.length) break;
      try {
        await thumbs[i].click({ timeout: 2800 });
        await page.waitForTimeout(320);
      } catch {
        // next thumbnail
      }
      const buttonsAfterThumb = await collectVisibleDownloadButtons(latest.root);
      if (!buttonsAfterThumb.length) continue;
      await trySaveByButton(buttonsAfterThumb[0], `thumb_${i}`);
    }
  }

  for (let i = 0; i < workingButtons.length; i++) {
    if (taskStartIndex + saved.length >= tasks.length) break;
    await trySaveByButton(workingButtons[i], `direct_${i}`);
  }

  if (saved.length) {
    log('harvest_done', { rootIndex: latest.rootIndex, saved: saved.length, fromTask: taskStartIndex + 1 });
  }
  await closeMediaViewerIfOpen(page);
  return saved;
}

async function sendPromptAndWait(page, prompt, genTimeoutSec, idleNoBusyMs, postIdlePollSec, options = {}) {
  await closeMediaViewerIfOpen(page);
  await ensureImageCreationMode(page);
  const baselineMessages = await getAssistantMessages(page);
  const baselineCount = baselineMessages.length;
  const baselineLast = baselineCount ? baselineMessages[baselineCount - 1] : '';
  await fillComposer(page, prompt);
  const composerText = await readComposerText(page);
  if (!composerText) {
    throw new Error('Composer text is empty before send.');
  }
  await waitForSendReady(page, 12000);

  let accepted = false;
  const allowEnterFallback = options.allowEnterFallback !== false;
  for (let i = 0; i < 3; i++) {
    const sent = await clickSend(page, { allowEnterFallback });
    if (!sent) {
      await page.waitForTimeout(450);
      continue;
    }
    await page.waitForTimeout(850);
    const afterSendComposer = await readComposerText(page);
    const busy = await anyVisible(page, getBusySelectors());
    const messages = await getAssistantMessages(page);
    const latest = messages.length ? messages[messages.length - 1] : '';
    const changed = messages.length > baselineCount || latest !== baselineLast;

    if (!afterSendComposer || afterSendComposer !== composerText || busy || changed) {
      accepted = true;
      break;
    }

    // Keyboard-only fallback (no click): some states require Ctrl+Enter.
    try {
      if (allowEnterFallback) {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
        log('send_clicked', { method: 'ctrl_enter_fallback' });
      }
    } catch {
      // ignore
    }

    await page.waitForTimeout(450);
  }

  if (!accepted) {
    throw new Error('Send button had no effect; composer text unchanged.');
  }

  return waitForAssistantReply(page, {
    timeoutMs: genTimeoutSec * 1000,
    idleNoBusyMs,
    baselineCount,
    baselineLast,
    postIdlePollSec,
    returnOnNeedsInputs: Boolean(options.returnOnNeedsInputs),
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const fixedPromptFile = String(args['fixed-prompt-file'] || '').trim();
  const fixedPromptInline = String(args['fixed-prompt'] || '').trim();
  const fixedPrompt = fixedPromptInline || readTextFileSafe(fixedPromptFile).trim();
  const keywords = String(args.keywords || '').trim();
  const outputDir = path.resolve(String(args['output-dir'] || ''));
  const sessionDir = path.resolve(String(args['session-dir'] || path.join(process.cwd(), '.chatgpt_profile_live')));
  const imagePaths = ([]).concat(args['image-path'] || []).map((one) => path.resolve(String(one)));
  const baseUrl = String(args['base-url'] || 'https://chatgpt.com/?openaicom_referred=true');
  const loginWaitSec = toInt(args['login-wait-sec'], 600);
  const genTimeoutSec = toInt(args['gen-timeout-sec'], 260);
  const idleNoBusyMs = toInt(args['idle-no-busy-ms'], 12000);
  const postIdlePollSec = toInt(args['post-idle-poll-sec'], 16);
  const viewportWidth = toInt(args['viewport-width'], 1700);
  const viewportHeight = toInt(args['viewport-height'], 1050);
  const pageZoom = Number(args['page-zoom'] || 1.0);
  const maxRetry = Math.max(1, toInt(args['max-retry'], 3));
  const retryWaitSec = Math.max(1, toInt(args['retry-wait-sec'], 12));
  const taskGapSec = Math.max(0, toInt(args['task-gap-sec'], 3));
  const keepOpenAfterRunSec = Math.max(0, toInt(args['keep-open-after-run-sec'], 0));
  const keepOpenOnFailureSec = Math.max(0, toInt(args['keep-open-on-failure-sec'], 180));
  const headless = toBool(args.headless, false);
  const openNewChat = toBool(args['open-new-chat'], true);
  const cdpUrl = String(args['cdp-url'] || '').trim();
  const cdpPort = Math.max(9222, toInt(args['cdp-port'], 9222));
  const browserExecutablePath = args['browser-executable-path'] || resolveChromeExecutable();

  if (!outputDir) throw new Error('--output-dir is required');
  if (!keywords) throw new Error('--keywords is required');
  if (!fixedPrompt) throw new Error('Fixed prompt is empty.');
  if (!imagePaths.length) throw new Error('At least one --image-path is required.');
  if (!cdpUrl && (!browserExecutablePath || !fileExists(browserExecutablePath))) {
    throw new Error('System Chrome executable not found. Please install Google Chrome or pass --browser-executable-path.');
  }

  ensureDir(outputDir);
  ensureDir(sessionDir);
  const debugDir = path.join(outputDir, 'debug');
  ensureDir(debugDir);

  const runId = nowTag();
  const summaryPath = path.join(outputDir, `summary_${runId}.json`);
  activeTraceFile = path.join(debugDir, 'trace.jsonl');
  const normalizedKeywords = normalizeKeywordsForPrompt(keywords);

  const tasks = buildTasks();
  const summary = {
    result: 'failed',
    provider: 'gpt',
    output_dir: outputDir,
    debug_dir: debugDir,
    fixed_prompt_file: fixedPromptFile || '',
    keywords: normalizedKeywords,
    image_count: imagePaths.length,
    tasks_total: tasks.length,
    tasks_done: [],
    failed_tasks: [],
    created_at: new Date().toISOString(),
  };

  let context = null;
  let page = null;
  let browser = null;
  let ownedCdpProcess = null;
  let cdpAttached = false;
  const seenHashes = new Set();

  try {
    if (cdpUrl) {
      try {
        browser = await chromium.connectOverCDP(cdpUrl);
      } catch (connectErr) {
        if (!browserExecutablePath || !fileExists(browserExecutablePath)) throw connectErr;
        const requestedPort = parseCdpPortFromUrl(cdpUrl, cdpPort);
        log('cdp_connect_failed_starting_chrome', {
          cdp_url: cdpUrl,
          cdpPort: requestedPort,
          error: String(connectErr && connectErr.message ? connectErr.message : connectErr),
        });
        const fallback = await startChromeForCdp({
          executablePath: browserExecutablePath,
          sessionDir,
          viewportWidth,
          viewportHeight,
          cdpPort: requestedPort,
          startUrl: baseUrl,
        });
        browser = fallback.browser;
        // Keep the visible ChatGPT browser open for review and for the next job.
        log('cdp_auto_started', { cdp_url: fallback.cdpUrl });
      }
      cdpAttached = true;
      const contexts = browser.contexts();
      context = contexts[0] || await browser.newContext();
      page = context.pages()[0] || await context.newPage();
      await page.bringToFront().catch(() => {});
      log('cdp_connected', { cdp_url: cdpUrl, contexts: contexts.length });
    } else {
      const launchOpts = {
        headless,
        acceptDownloads: true,
        viewport: { width: viewportWidth, height: viewportHeight },
        locale: 'en-US',
        args: [
          '--lang=en-US',
          `--window-size=${viewportWidth},${viewportHeight}`,
        ],
      };
      launchOpts.executablePath = browserExecutablePath;
      try {
        context = await chromium.launchPersistentContext(sessionDir, launchOpts);
      } catch (firstErr) {
        if (!isLaunchRecoverableError(firstErr)) throw firstErr;
        log('launch_retry_after_lock_cleanup', { sessionDir });
        removeProfileLockFiles(sessionDir);
        await sleep(1200);
        try {
          context = await chromium.launchPersistentContext(sessionDir, launchOpts);
        } catch (secondErr) {
          if (!isLaunchRecoverableError(secondErr)) throw secondErr;
          log('launch_fallback_to_cdp', { cdpPort, sessionDir });
          const fallback = await startChromeForCdp({
            executablePath: browserExecutablePath,
            sessionDir,
            viewportWidth,
            viewportHeight,
            cdpPort,
            startUrl: baseUrl,
          });
          browser = fallback.browser;
          ownedCdpProcess = fallback.proc;
          cdpAttached = true;
          const contexts = browser.contexts();
          context = contexts[0] || await browser.newContext();
          page = context.pages()[0] || await context.newPage();
          await page.bringToFront().catch(() => {});
          log('cdp_connected_fallback', { cdp_url: fallback.cdpUrl, contexts: contexts.length });
        }
      }
      page = context.pages()[0] || await context.newPage();
      await page.bringToFront().catch(() => {});
    }

    log('goto_base', { baseUrl });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitForComposer(page, loginWaitSec * 1000, { debugDir });
    await applyPageZoom(page, pageZoom);
    await dismissBlockingDialogs(page);
    await safeShot(page, debugDir, '01_ready.png');

    if (openNewChat) {
      await clickNewChat(page);
      await page.waitForTimeout(900);
      await waitForComposer(page, 30000, { debugDir });
      await applyPageZoom(page, pageZoom);
      await safeShot(page, debugDir, '02_new_chat.png');
    }

    await sendPromptAndWait(page, fixedPrompt, genTimeoutSec, idleNoBusyMs, postIdlePollSec, {
      returnOnNeedsInputs: true,
      allowEnterFallback: false,
    });
    await safeShot(page, debugDir, '03_after_fixed_prompt.png');

    for (const imagePath of imagePaths) {
      if (!fileExists(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
      }
      const ok = await attachImage(page, imagePath);
      if (!ok) throw new Error(`Failed to attach image: ${path.basename(imagePath)}`);
    }
    await safeShot(page, debugDir, '04_after_uploads.png');

    const keywordPrompt = `产品关键词：${normalizedKeywords}`;
    try {
      await sendPromptAndWait(page, keywordPrompt, genTimeoutSec, idleNoBusyMs, postIdlePollSec, {
        allowEnterFallback: false,
      });
    } catch (error) {
      log('keywords_wait_failed_continue', {
        error: String(error && error.message ? error.message : error),
      });
    }
    await safeShot(page, debugDir, '05_after_keywords.png');

    const afterKeyword = await harvestLatestTurnImages(page, outputDir, debugDir, tasks, summary.tasks_done.length, seenHashes);
    summary.tasks_done.push(...afterKeyword);

    for (let i = summary.tasks_done.length; i < tasks.length; i++) {
      const task = tasks[i];
      let done = false;

      const preGrab = await harvestLatestTurnImages(page, outputDir, debugDir, tasks, summary.tasks_done.length, seenHashes, {
        openOverlayFallback: false,
      });
      if (preGrab.length) {
        summary.tasks_done.push(...preGrab);
        if (summary.tasks_done.length > i) {
          done = true;
          i = summary.tasks_done.length - 1;
        }
      }
      if (done) {
        if (taskGapSec > 0) await page.waitForTimeout(taskGapSec * 1000);
        continue;
      }

      for (let attempt = 1; attempt <= maxRetry; attempt++) {
        const prompt = buildTaskPrompt(task, attempt);
        log('task_attempt', { task: task.id, attempt, prompt });
        try {
          await sendPromptAndWait(page, prompt, genTimeoutSec, idleNoBusyMs, postIdlePollSec, {
            allowEnterFallback: false,
          });
        } catch (error) {
          log('task_wait_failed_continue', {
            task: task.id,
            attempt,
            error: String(error && error.message ? error.message : error),
          });
        }
        await safeShot(page, debugDir, `task_${task.id}_a${attempt}.png`);

        const got = await harvestLatestTurnImages(page, outputDir, debugDir, tasks, summary.tasks_done.length, seenHashes);
        if (got.length) {
          summary.tasks_done.push(...got);
          if (summary.tasks_done.length > i) {
            done = true;
            i = summary.tasks_done.length - 1;
            break;
          }
        }

        if (attempt < maxRetry) {
          await page.waitForTimeout(retryWaitSec * 1000);
        }
      }

      if (!done) {
        summary.failed_tasks.push(task.id);
      }
      if (taskGapSec > 0) await page.waitForTimeout(taskGapSec * 1000);
    }

    summary.result_images = fs.readdirSync(outputDir, { withFileTypes: true })
      .filter((one) => one.isFile())
      .map((one) => one.name)
      .filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name))
      .sort();

    if (!summary.result_images.length) {
      summary.result = 'failed';
      summary.fatal_error = 'No generated images were downloaded from ChatGPT.';
      writeSummary(summaryPath, summary);
      process.exitCode = 1;
      return;
    }

    if (summary.failed_tasks.length) {
      summary.result = 'partial';
      writeSummary(summaryPath, summary);
      process.exitCode = 2;
      return;
    }

    summary.result = 'ok';
    writeSummary(summaryPath, summary);
  } catch (error) {
    if (page) {
      await safeShot(page, debugDir, `fatal_${runId}.png`);
    }
    summary.result = 'failed';
    summary.fatal_error = String(error && error.message ? error.message : error);
    writeSummary(summaryPath, summary);
    process.exitCode = 1;
  } finally {
    if (context) {
      const keepSec = !headless
        ? (keepOpenAfterRunSec > 0 ? keepOpenAfterRunSec : ((process.exitCode === 1 && keepOpenOnFailureSec > 0) ? keepOpenOnFailureSec : 0))
        : 0;
      if (keepSec > 0) {
        log('keep_browser_open_before_close', { seconds: keepSec, exitCode: process.exitCode || 0 });
        try {
          await page.waitForTimeout(keepSec * 1000);
        } catch {
          // ignore
        }
      }
      if (!cdpAttached) {
        try {
          await context.close();
        } catch {
          // ignore
        }
      }
    }
    if (cdpAttached && ownedCdpProcess) {
      try {
        if (browser) await browser.close();
      } catch {
        // ignore
      }
      try {
        process.kill(ownedCdpProcess.pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    // In external CDP mode (provided by user), keep the user browser session untouched.
    process.exit(process.exitCode || 0);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

