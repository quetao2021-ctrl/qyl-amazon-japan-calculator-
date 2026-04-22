#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
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

let activeTraceFile = '';

function log(event, payload = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload });
  console.log(line);
  if (activeTraceFile) {
    try {
      fs.appendFileSync(activeTraceFile, `${line}\n`, 'utf8');
    } catch {
      // ignore
    }
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

async function dismissBlockingDialogs(page) {
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

async function waitForComposer(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await dismissBlockingDialogs(page);
    const composer = await findComposer(page);
    if (composer) return composer;
    await page.waitForTimeout(1000);
  }
  throw new Error('ChatGPT composer not found. Please log in and keep the chat page open.');
}

async function fillComposer(page, text) {
  await dismissBlockingDialogs(page);
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

  await loc.click({ timeout: 5000 });
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
      await loc.setInputFiles(imagePath, { timeout: 4000 });
      await page.waitForTimeout(1000);
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
      await page.waitForTimeout(300);

      const again = page.locator('input[type="file"]');
      const inputCount = await again.count();
      for (let i = 0; i < inputCount; i++) {
        const input = again.nth(i);
        try {
          await input.setInputFiles(imagePath, { timeout: 4000 });
          await page.waitForTimeout(1000);
          log('attach_image_done', { image: path.basename(String(imagePath || '')), method: `menu_input:${sel}` });
          return true;
        } catch {
          // next input
        }
      }
    } catch {
      // next opener
    }
  }

  log('attach_image_failed', { image: path.basename(String(imagePath || '')) });
  return false;
}

function getSendSelectors() {
  return [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send message" i]',
    'button[aria-label*="Send" i]',
    'button:has-text("Send")',
  ];
}

function getStopSelectors() {
  return [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop" i]',
    'button:has-text("Stop")',
  ];
}

function getBusySelectors() {
  return [
    ...getStopSelectors(),
    'text=/thinking/i',
    'text=/analyzing/i',
    'text=/searching/i',
    'svg.animate-spin',
  ];
}

async function clickSend(page) {
  for (const sel of getSendSelectors()) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count() > 0 && await loc.isVisible() && await loc.isEnabled()) {
        await loc.click({ timeout: 3000 });
        log('send_clicked', { method: sel });
        return true;
      }
    } catch {
      // next
    }
  }

  try {
    await page.keyboard.press('Enter');
    log('send_clicked', { method: 'enter_key' });
    return true;
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
        if (!text) continue;
        out.push(text);
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

  const start = Date.now();
  let seenBusy = false;
  let idleStart = 0;
  let lastObserved = baselineLast || '';

  while (Date.now() - start < timeoutMs) {
    await dismissBlockingDialogs(page);
    const busy = await anyVisible(page, getBusySelectors());
    const messages = await getAssistantMessages(page);
    const latest = messages.length ? messages[messages.length - 1] : '';
    if (latest) lastObserved = latest;

    const changed = messages.length > baselineCount || (latest && latest !== baselineLast);
    if (busy) {
      seenBusy = true;
      idleStart = 0;
    } else if (changed) {
      if (!idleStart) idleStart = Date.now();
      if (Date.now() - idleStart >= idleNoBusyMs) {
        return {
          replyText: latest || lastObserved,
          seenBusy,
          assistantCount: messages.length,
        };
      }
    }

    await page.waitForTimeout(1000);
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

async function main() {
  const args = parseArgs(process.argv);
  const prompt = String(args.prompt || '').trim();
  const outputDir = path.resolve(String(args['output-dir'] || ''));
  const sessionDir = path.resolve(String(args['session-dir'] || path.join(process.cwd(), '.chatgpt_profile_live')));
  const imagePaths = ([]).concat(args['image-path'] || []).map((one) => path.resolve(String(one)));
  const baseUrl = String(args['base-url'] || 'https://chatgpt.com/');
  const loginWaitSec = toInt(args['login-wait-sec'], 600);
  const genTimeoutSec = toInt(args['gen-timeout-sec'], 240);
  const idleNoBusyMs = toInt(args['idle-no-busy-ms'], 12000);
  const viewportWidth = toInt(args['viewport-width'], 1700);
  const viewportHeight = toInt(args['viewport-height'], 1050);
  const pageZoom = Number(args['page-zoom'] || 1.0);
  const headless = toBool(args.headless, false);
  const openNewChat = toBool(args['open-new-chat'], true);
  const browserExecutablePath = args['browser-executable-path'] || resolveChromeExecutable();

  if (!prompt) {
    throw new Error('--prompt is required');
  }
  if (!outputDir) {
    throw new Error('--output-dir is required');
  }

  ensureDir(outputDir);
  ensureDir(sessionDir);
  const debugDir = path.join(outputDir, 'debug');
  ensureDir(debugDir);

  const runId = nowTag();
  const summaryPath = path.join(outputDir, `summary_${runId}.json`);
  activeTraceFile = path.join(debugDir, 'trace.jsonl');

  let context = null;
  let page = null;

  try {
    const launchOpts = {
      headless,
      acceptDownloads: true,
      viewport: { width: viewportWidth, height: viewportHeight },
      locale: 'en-US',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US',
        `--window-size=${viewportWidth},${viewportHeight}`,
      ],
    };

    if (browserExecutablePath) launchOpts.executablePath = browserExecutablePath;

    context = await chromium.launchPersistentContext(sessionDir, launchOpts);
    page = context.pages()[0] || await context.newPage();

    log('goto_base', { baseUrl });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitForComposer(page, loginWaitSec * 1000);
    await applyPageZoom(page, pageZoom);
    await dismissBlockingDialogs(page);
    await safeShot(page, debugDir, '01_ready.png');

    if (openNewChat) {
      await clickNewChat(page);
      await page.waitForTimeout(1000);
      await waitForComposer(page, 30000);
      await applyPageZoom(page, pageZoom);
      await safeShot(page, debugDir, '02_new_chat.png');
    }

    for (const imagePath of imagePaths) {
      if (!fileExists(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
      }
      const ok = await attachImage(page, imagePath);
      if (!ok) {
        throw new Error(`Failed to attach image: ${path.basename(imagePath)}`);
      }
    }
    await safeShot(page, debugDir, '03_after_uploads.png');

    const baselineMessages = await getAssistantMessages(page);
    const baselineCount = baselineMessages.length;
    const baselineLast = baselineCount ? baselineMessages[baselineCount - 1] : '';

    await fillComposer(page, prompt);
    const composerText = await readComposerText(page);
    if (!composerText || !composerText.includes(prompt.slice(0, Math.min(prompt.length, 20)).trim())) {
      log('composer_verify_soft_fail', { composerText: composerText.slice(0, 160) });
    }
    await safeShot(page, debugDir, '04_before_send.png');

    const sent = await clickSend(page);
    if (!sent) {
      throw new Error('Failed to send prompt to ChatGPT.');
    }

    const reply = await waitForAssistantReply(page, {
      timeoutMs: genTimeoutSec * 1000,
      idleNoBusyMs,
      baselineCount,
      baselineLast,
    });

    await safeShot(page, debugDir, '05_after_reply.png');

    writeSummary(summaryPath, {
      result: 'ok',
      provider: 'gpt',
      reply_text: String(reply.replyText || '').trim(),
      output_dir: outputDir,
      debug_dir: debugDir,
      prompt,
      image_count: imagePaths.length,
      assistant_count: reply.assistantCount || 0,
      seen_busy: Boolean(reply.seenBusy),
      timed_out_but_recovered: Boolean(reply.timedOut),
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    if (page) {
      await safeShot(page, debugDir, `fatal_${runId}.png`);
    }
    writeSummary(summaryPath, {
      result: 'failed',
      provider: 'gpt',
      fatal_error: String(error && error.message ? error.message : error),
      output_dir: outputDir,
      debug_dir: debugDir,
      prompt,
      image_count: imagePaths.length,
      created_at: new Date().toISOString(),
    });
    process.exitCode = 1;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
