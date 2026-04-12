#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      if (out[key] === undefined) {
        out[key] = 'true';
      } else if (Array.isArray(out[key])) {
        out[key].push('true');
      } else {
        out[key] = [out[key], 'true'];
      }
    } else {
      if (out[key] === undefined) {
        out[key] = next;
      } else if (Array.isArray(out[key])) {
        out[key].push(next);
      } else {
        out[key] = [out[key], next];
      }
      i += 1;
    }
  }
  return out;
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(v));
}

function nowTag() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

let activeTraceFile = '';
let traceShotSeq = 0;
const visualHashCache = new Map();
const VISUAL_DUPLICATE_MAX_DISTANCE = 4;
const GEMINI_DOWNLOAD_SELECTORS = [
  'button[aria-label*="Download" i]',
  'button[title*="Download" i]',
  'button:has-text("Download")',
  '[role="button"][aria-label*="Download" i]',
  'button[aria-label*="\\u4e0b\\u8f7d" i]',
  'button[title*="\\u4e0b\\u8f7d" i]',
  `button:has-text("${'\u4e0b\u8f7d'}")`,
  '[role="button"][aria-label*="\\u4e0b\\u8f7d" i]',
  'button[aria-label*="\\u4fdd\\u5b58" i]',
  `button:has-text("${'\u4fdd\u5b58'}")`,
];

function log(event, payload = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload });
  console.log(line);
  if (activeTraceFile) {
    try {
      fs.appendFileSync(activeTraceFile, `${line}\n`, 'utf8');
    } catch {
      // ignore trace write failures
    }
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'x';
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function getDefaultDownloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

function listPlaywrightArtifactFiles() {
  const out = [];
  const tmpDir = os.tmpdir();
  try {
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^playwright-artifacts-/i.test(entry.name)) continue;
      const dir = path.join(tmpDir, entry.name);
      try {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const one of files) {
          if (!one.isFile()) continue;
          const full = path.join(dir, one.name);
          try {
            const st = fs.statSync(full);
            out.push({
              name: one.name,
              full,
              mtimeMs: st.mtimeMs,
              size: st.size,
            });
          } catch {
            // ignore one bad file
          }
        }
      } catch {
        // ignore one bad temp dir
      }
    }
  } catch {
    // ignore temp scan failures
  }
  return out;
}

function snapshotDownloadDir(dir) {
  const out = new Map();
  try {
    if (!fileExists(dir)) return out;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      try {
        const st = fs.statSync(full);
        out.set(entry.name, { mtimeMs: st.mtimeMs, size: st.size, full });
      } catch {
        // ignore one bad file
      }
    }
  } catch {
    // ignore snapshot failures
  }
  return out;
}

function snapshotPlaywrightArtifactDir() {
  const out = new Map();
  for (const one of listPlaywrightArtifactFiles()) {
    out.set(one.full, {
      mtimeMs: one.mtimeMs,
      size: one.size,
      full: one.full,
      name: one.name,
    });
  }
  return out;
}

async function waitForFreshDownloadedImage(dir, before, startedAtMs, timeoutMs) {
  const start = Date.now();
  const minMtime = Math.max(0, Number(startedAtMs || 0) - 1500);

  while (Date.now() - start < timeoutMs) {
    try {
      if (fileExists(dir)) {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => {
            const full = path.join(dir, entry.name);
            try {
              const st = fs.statSync(full);
              return {
                name: entry.name,
                full,
                mtimeMs: st.mtimeMs,
                size: st.size,
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .filter((one) => /\.(png|jpe?g|webp)$/i.test(one.name))
          .filter((one) => !/\.crdownload$/i.test(one.name))
          .filter((one) => one.size > 0)
          .sort((a, b) => b.mtimeMs - a.mtimeMs);

        for (const one of entries) {
          const prev = before.get(one.name);
          const isNew = !prev || one.mtimeMs > prev.mtimeMs || one.size > prev.size;
          if (!isNew) continue;
          if (one.mtimeMs < minMtime) continue;
          return one;
        }
      }
    } catch {
      // ignore transient file access issues
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  return null;
}

async function waitForFreshPlaywrightArtifact(before, startedAtMs, timeoutMs) {
  const start = Date.now();
  const minMtime = Math.max(0, Number(startedAtMs || 0) - 1500);

  while (Date.now() - start < timeoutMs) {
    try {
      const entries = listPlaywrightArtifactFiles()
        .filter((one) => !/\.crdownload$/i.test(one.name))
        .filter((one) => one.size > 0)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const one of entries) {
        const prev = before.get(one.full);
        const isNew = !prev || one.mtimeMs > prev.mtimeMs || one.size > prev.size;
        if (!isNew) continue;
        if (one.mtimeMs < minMtime) continue;
        return one;
      }
    } catch {
      // ignore transient file access issues
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  return null;
}

function resolveChromeExecutable() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    if (fileExists(p)) return p;
  }
  return '';
}

function readTextFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function detectImageDimensions(buffer, mimeHint = '') {
  try {
    const b = buffer;
    const hint = (mimeHint || '').toLowerCase();

    // PNG
    if (
      b.length >= 24 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
    ) {
      return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }

    // JPEG
    if ((hint.includes('jpeg') || hint.includes('jpg') || (b[0] === 0xff && b[1] === 0xd8)) && b.length > 4) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) { i += 1; continue; }
        const marker = b[i + 1];
        if (!marker || marker === 0xda || marker === 0xd9) break;
        const len = b.readUInt16BE(i + 2);
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
          return { format: 'jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }

    // WEBP VP8X
    if (
      b.length >= 30 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP' &&
      b.toString('ascii', 12, 16) === 'VP8X'
    ) {
      return { format: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    }
  } catch {
    // noop
  }
  return { format: 'unknown', width: null, height: null };
}

function buildDownloadedFileResult(fileInfo, saveBasePath, method) {
  const rawBuffer = fs.readFileSync(fileInfo.full);
  const dim = detectImageDimensions(rawBuffer, path.extname(fileInfo.name).replace('.', ''));
  const detectedExt = dim.format === 'jpeg'
    ? '.jpg'
    : dim.format === 'webp'
      ? '.webp'
      : dim.format === 'png'
        ? '.png'
        : '';
  if (!detectedExt) return null;

  const savePath = `${saveBasePath}${detectedExt}`;
  fs.copyFileSync(fileInfo.full, savePath);
  const buffer = fs.readFileSync(savePath);
  return {
    ok: true,
    mime: detectedExt === '.jpg' ? 'image/jpeg' : (detectedExt === '.webp' ? 'image/webp' : 'image/png'),
    buffer,
    width: dim.width,
    height: dim.height,
    method,
    suggested_filename: fileInfo.name,
    tempPath: savePath,
  };
}

function extFromMime(mime = '') {
  const m = String(mime).toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('png')) return 'png';
  return 'png';
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function normalizeUrlNoQuery(raw) {
  const src = String(raw || '').trim();
  if (!src) return '';
  if (src.startsWith('data:') || src.startsWith('blob:')) return src;
  try {
    const u = new URL(src);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return src;
  }
}

function escapePsSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

function computeVisualHashFromFile(filePath) {
  const full = path.resolve(String(filePath || ''));
  if (!full || !fileExists(full)) return '';
  if (visualHashCache.has(full)) return visualHashCache.get(full);
  if (process.platform !== 'win32') return '';

  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Drawing',
    `$path='${escapePsSingleQuoted(full)}'`,
    '$bmp=[System.Drawing.Bitmap]::FromFile($path)',
    'try {',
    '  $size=8',
    '  $thumb = New-Object System.Drawing.Bitmap ($size+1), $size',
    '  try {',
    '    $g=[System.Drawing.Graphics]::FromImage($thumb)',
    '    try { $g.DrawImage($bmp,0,0,$size+1,$size) } finally { $g.Dispose() }',
    "    $bits=''",
    '    for($y=0;$y -lt $size;$y++){',
    '      for($x=0;$x -lt $size;$x++){',
    '        $c1=$thumb.GetPixel($x,$y)',
    '        $c2=$thumb.GetPixel($x+1,$y)',
    '        $l1=[int](0.299*$c1.R + 0.587*$c1.G + 0.114*$c1.B)',
    '        $l2=[int](0.299*$c2.R + 0.587*$c2.G + 0.114*$c2.B)',
    "        $bits += [string]([int]($l1 -gt $l2))",
    '      }',
    '    }',
    '    Write-Output $bits',
    '  } finally { $thumb.Dispose() }',
    '} finally { $bmp.Dispose() }',
  ].join('; ');

  try {
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    const hash = /^[01]{64}$/.test(out) ? out : '';
    visualHashCache.set(full, hash);
    return hash;
  } catch {
    visualHashCache.set(full, '');
    return '';
  }
}

function hammingDistanceBits(a, b) {
  const aa = String(a || '');
  const bb = String(b || '');
  if (!aa || !bb || aa.length !== bb.length) return Number.POSITIVE_INFINITY;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) diff += 1;
  }
  return diff;
}

function findVisualDuplicate(visualHash, acceptedVisuals) {
  const hash = String(visualHash || '');
  if (!hash || !Array.isArray(acceptedVisuals) || !acceptedVisuals.length) return null;
  for (const one of acceptedVisuals) {
    const dist = hammingDistanceBits(hash, one.visualHash);
    if (Number.isFinite(dist) && dist <= VISUAL_DUPLICATE_MAX_DISTANCE) {
      return {
        distance: dist,
        taskId: one.taskId || '',
        file: one.file || '',
      };
    }
  }
  return null;
}

function ensureVisualHash(item, fallbackPath = '') {
  if (!item || item.visualHash) return item && item.visualHash ? item.visualHash : '';
  const tempPath = String(item.tempPath || fallbackPath || '');
  if (!tempPath) return '';
  const hash = computeVisualHashFromFile(tempPath);
  if (hash) item.visualHash = hash;
  return hash;
}

function normalizeNameToken(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

function normalizeKeywords(raw) {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeReferenceFileName(name, referenceNameTokens) {
  if (!name || !referenceNameTokens || !referenceNameTokens.size) return false;
  const base = normalizeNameToken(path.basename(String(name || '')));
  if (!base) return false;
  for (const token of referenceNameTokens) {
    if (token.length < 5) continue;
    if (base.includes(token) || token.includes(base)) return true;
  }
  return false;
}

function isAcceptableResolution(task, width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (w <= 0 || h <= 0) return false;

  const ratio = w / h;
  if (task.phase === 'main') {
    return w >= 1200 && h >= 1200 && Math.abs(ratio - 1) <= 0.15;
  }

  const targetRatio = 970 / 600;
  return w >= 900 && h >= 540 && Math.abs(ratio - targetRatio) <= 0.2;
}

async function anyVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count() > 0 && await loc.isVisible()) return true;
    } catch {
      // ignore stale selectors
    }
  }
  return false;
}

async function findComposer(page) {
  // Borrowed from GeminiPilot selector patterns + fallbacks.
  const selectors = [
    '[aria-label="Enter a prompt here"]',
    '.text-input-field [aria-label="Enter a prompt here"]',
    '.text-input-field textarea',
    '.text-input-field [contenteditable="true"]',
    'textarea[aria-label*="prompt" i]',
    'textarea[aria-label*="message" i]',
    'div[role="textbox"][contenteditable="true"]',
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
    const c = await findComposer(page);
    if (c) return c;
    await page.waitForTimeout(1200);
  }
  throw new Error('Gemini composer not found. Please log in and keep chat page open.');
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

async function dismissBlockingDialogs(page) {
  const closeSelectors = [
    'button[aria-label*="close" i]',
    'button[title*="close" i]',
    '[role="dialog"] button[aria-label*="close" i]',
    '[aria-modal="true"] button[aria-label*="close" i]',
    'button:has-text("Close")',
    'button:has-text("Not now")',
    'button:has-text("Maybe later")',
    'button:has-text("Skip")',
    'button:has-text("Cancel")',
  ];

  const textHints = [
    'Close',
    'Not now',
    'Maybe later',
    'Skip',
    'Cancel',
    '\u5173\u95ed',
    '\u53d6\u6d88',
    '\u7a0d\u540e',
    '\u4ee5\u540e',
    '\u8df3\u8fc7',
    '\u5148\u4e0d\u7528',
  ];

  for (let round = 0; round < 5; round++) {
    let acted = false;

    // Do not press Escape while Gemini is actively responding/generating,
    // otherwise it can stop the response and cause missing output state.
    let isBusy = false;
    try {
      isBusy = (await anyVisible(page, getStopSelectors())) || (await anyVisible(page, getGeneratingSelectors()));
    } catch {
      isBusy = false;
    }
    if (!isBusy) {
      try {
        await page.keyboard.press('Escape');
        acted = true;
        await page.waitForTimeout(200);
      } catch {
        // ignore
      }
    }

    for (const sel of closeSelectors) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.count() > 0 && await loc.isVisible()) {
          await loc.click({ timeout: 1500 });
          acted = true;
          await page.waitForTimeout(250);
        }
      } catch {
        // next selector
      }
    }

    for (const t of textHints) {
      const b1 = page.locator(`button:has-text("${t}")`).first();
      const b2 = page.locator(`[role="button"]:has-text("${t}")`).first();
      try {
        if (await b1.count() > 0 && await b1.isVisible()) {
          await b1.click({ timeout: 1200 });
          acted = true;
          await page.waitForTimeout(220);
        }
      } catch {
        // continue
      }
      try {
        if (await b2.count() > 0 && await b2.isVisible()) {
          await b2.click({ timeout: 1200 });
          acted = true;
          await page.waitForTimeout(220);
        }
      } catch {
        // continue
      }
    }

    // Heuristic fallback: close icon at top-right inside visible modal dialogs.
    try {
      const clickedByHeuristic = await page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };

        const dialogs = Array.from(
          document.querySelectorAll('[role="dialog"], [aria-modal="true"], .mat-mdc-dialog-container')
        ).filter(visible);

        const closeLike = /close|cancel|skip|not now|later|[\u5173\u95ed\u53d6\u6d88\u8df3\u8fc7\u7a0d\u540e]/i;

        for (const d of dialogs) {
          const dr = d.getBoundingClientRect();
          const candidates = Array.from(d.querySelectorAll('button, [role="button"]')).filter(visible);
          const btn = candidates.find((b) => {
            const br = b.getBoundingClientRect();
            const label = `${(b.getAttribute('aria-label') || '')} ${(b.getAttribute('title') || '')} ${(b.textContent || '')}`;
            const nearTopRight = br.right >= dr.right - 120 && br.top <= dr.top + 100;
            return nearTopRight || closeLike.test(label);
          });
          if (btn) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (clickedByHeuristic) {
        acted = true;
        await page.waitForTimeout(260);
      }
    } catch {
      // ignore
    }

    if (!acted) break;
  }
}
async function tryClickNewChat(page) {
  // GeminiPilot: button[aria-label*='New chat']
  const selectors = [
    "button[aria-label*='New chat']",
    "a[aria-label*='New chat']",
    '[data-test-id="conversation"] button[aria-label*="New"]',
    'button:has-text("New chat")',
    'a:has-text("New chat")',
  ];

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count() > 0 && await loc.isVisible()) {
        await loc.click({ timeout: 3000 });
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {
      // continue
    }
  }
  return false;
}

function detectModeFromText(raw) {
  const text = String(raw || '').toLowerCase();
  if (/3\.1\s*pro|(^|\s)pro(\s|$)|gemini\s*pro/.test(text)) return 'pro';
  if (/\bfast\b|\bquick\b|\u5feb\u901f/.test(text)) return 'quick';
  if (/\bthinking\b|\u601d\u8003/.test(text)) return 'thinking';
  return '';
}

async function getComposerBox(page) {
  try {
    const composer = await findComposer(page);
    if (!composer) return null;
    return await composer.locator.boundingBox();
  } catch {
    return null;
  }
}

async function getModeControlCandidate(page) {
  const viewport = page.viewportSize() || { width: 1480, height: 960 };
  const composerBox = await getComposerBox(page);
  const nodes = page.locator('button,[role="button"],[aria-haspopup="menu"]');
  const total = Math.min(await nodes.count(), 360);

  let best = null;
  for (let i = 0; i < total; i++) {
    const one = nodes.nth(i);
    try {
      if (!(await one.isVisible()) || !(await one.isEnabled())) continue;

      const box = await one.boundingBox();
      if (!box) continue;
      if (box.y < viewport.height * 0.42) continue;
      if (box.width > 280 || box.height > 90) continue;

      if (composerBox) {
        const centerY = box.y + box.height / 2;
        const composerY = composerBox.y + composerBox.height / 2;
        if (Math.abs(centerY - composerY) > 200) continue;
        if (box.x < composerBox.x - 160 || box.x > composerBox.x + composerBox.width + 320) continue;
      }

      const text = await one.evaluate((el) => {
        const merged = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`;
        return merged.replace(/\s+/g, ' ').trim();
      }).catch(() => '');
      const mode = detectModeFromText(text);
      if (!mode) continue;

      const score = box.y * 3 + box.x * 1.5;
      if (!best || score > best.score) {
        best = { locator: one, mode, text, score };
      }
    } catch {
      // ignore
    }
  }
  return best;
}

async function isProModeActive(page) {
  const mode = await getModeControlCandidate(page);
  return Boolean(mode && mode.mode === 'pro');
}

async function clickModeTrigger(page) {
  const mode = await getModeControlCandidate(page);
  if (!mode || !mode.locator) return false;
  try {
    await mode.locator.click({ timeout: 2200 });
    return true;
  } catch {
    return false;
  }
}

async function selectProByKeyboard(page, currentMode = '') {
  try {
    const mode = String(currentMode || '').toLowerCase();
    const steps = mode === 'quick' ? 2 : 1;
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(150);
    }
    await page.keyboard.press('Enter');
    return true;
  } catch {
    return false;
  }
}

async function clickProOption(page, currentMode = '') {
  const keyboardSelected = await selectProByKeyboard(page, currentMode);
  if (keyboardSelected) return true;

  const selectors = [
    '[role="menu"] [role="menuitemradio"]:has-text("Pro")',
    '[role="menu"] [role="menuitem"]:has-text("Pro")',
    '[role="listbox"] [role="option"]:has-text("Pro")',
    '[role="dialog"] [role="menuitemradio"]:has-text("Pro")',
    '[role="dialog"] [role="button"]:has-text("Pro")',
    'text=/^Pro$/',
    'text=/^Pro\\b/i',
    'text=/Advanced math and code/i',
    `[role="menu"] [role="menuitemradio"]:has-text("${'\u4e13\u4e1a'}")`,
    `[role="menu"] [role="menuitem"]:has-text("${'\u4e13\u4e1a'}")`,
  ];

  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const count = await loc.count();
      for (let i = 0; i < count; i++) {
        const one = loc.nth(i);
        try {
          if (!(await one.isVisible())) continue;
          await one.click({ timeout: 2200 });
          return true;
        } catch {
          // continue
        }
      }
    } catch {
      // ignore invalid selector on localized UI
    }
  }

  try {
    const clicked = await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };

      const labelOf = (el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim();
      const match = (text) => /\bpro\b/i.test(text) || /advanced math and code/i.test(text);

      const nodes = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],div,li,span'))
        .filter(visible)
        .map((el) => ({ el, text: labelOf(el), rect: el.getBoundingClientRect() }))
        .filter((x) => match(x.text))
        .filter((x) => x.rect.bottom > window.innerHeight * 0.45)
        .filter((x) => x.rect.width < 420 && x.rect.height < 160)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

      for (const item of nodes) {
        const clickable = item.el.closest('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],li,div') || item.el;
        if (!visible(clickable)) continue;
        clickable.click();
        return true;
      }
      return false;
    });
    if (clicked) return true;
  } catch {
    // heuristic fallback failed
  }

  return false;
}

async function closeModeMenu(page) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.keyboard.press('Escape');
    } catch {
      // ignore
    }
    await page.waitForTimeout(120);
  }
}

async function ensureProMode(page, timeoutMs = 60000) {
  const first = await getModeControlCandidate(page);
  if (first && first.mode === 'pro') {
    await closeModeMenu(page);
    return { ok: true, already: true };
  }

  const start = Date.now();
  let pickedOnce = false;

  while (Date.now() - start < timeoutMs) {
    await dismissBlockingDialogs(page);

    const now = await getModeControlCandidate(page);
    if (now && now.mode === 'pro') {
      await closeModeMenu(page);
      return { ok: true, already: !pickedOnce };
    }

    const opened = await clickModeTrigger(page);
    if (!opened) {
      await page.waitForTimeout(700);
      continue;
    }

    await page.waitForTimeout(350);
    const picked = await clickProOption(page, now && now.mode ? now.mode : '');
    if (picked) {
      pickedOnce = true;
      await page.waitForTimeout(2200);
      continue;
    }

    await closeModeMenu(page);
    await page.waitForTimeout(600);
  }

  await closeModeMenu(page);
  throw new Error('Failed to switch Gemini mode to Pro within timeout.');
}

async function attachImage(page, imagePath) {
  log('attach_image_start', { image: path.basename(String(imagePath || '')) });
  await dismissBlockingDialogs(page);

  // 1) direct input[type=file] (visible or hidden)
  const inputLocator = page.locator('input[type="file"]');
  const count = await inputLocator.count();
  for (let i = 0; i < count; i++) {
    const one = inputLocator.nth(i);
    try {
      await one.setInputFiles(imagePath, { timeout: 5000 });
      await page.waitForTimeout(700);
      log('attach_image_done', { image: path.basename(String(imagePath || '')), method: 'direct_input' });
      return true;
    } catch {
      // try next
    }
  }

  const openers = [
    '.upload-button button',
    'button[aria-label*="Add files" i]',
    'button[aria-label*="Upload" i]',
    'button[aria-label*="plus" i]',
    'button[aria-label*="add" i]',
    'button:has-text("Upload")',
    'button:has-text("Add files")',
    'button:has-text("Tools")',
    '[aria-haspopup="menu"]',
  ];

  const uploadItems = [
    '[role="menuitem"]:has-text("Upload files")',
    'button:has-text("Upload files")',
    '[role="menuitem"]:has-text("Upload file")',
    'button:has-text("Upload file")',
    '[role="menuitem"]:has-text("Upload")',
    'button:has-text("Upload")',
    '[role="menuitem"]',
    '[role="menu"] [role="button"]',
  ];

  // 2) opener -> direct chooser OR opener -> menu item -> chooser
  for (const openSel of openers) {
    const opener = page.locator(openSel).first();
    try {
      if (!(await opener.count()) || !(await opener.isVisible())) continue;

      const chooserFromOpener = page.waitForEvent('filechooser', { timeout: 1800 }).catch(() => null);
      await opener.click({ timeout: 2500 });
      const directChooser = await chooserFromOpener;
      if (directChooser) {
        await directChooser.setFiles(imagePath);
        await page.waitForTimeout(700);
        log('attach_image_done', { image: path.basename(String(imagePath || '')), method: `opener_direct:${openSel}` });
        return true;
      }

      await page.waitForTimeout(250);

      for (const itemSel of uploadItems) {
        const item = page.locator(itemSel).first();
        try {
          if (!(await item.count()) || !(await item.isVisible())) continue;

          const chooserPromise = page.waitForEvent('filechooser', { timeout: 3500 }).catch(() => null);
          await item.click({ timeout: 2500 });
          const chooser = await chooserPromise;
          if (chooser) {
            await chooser.setFiles(imagePath);
            await page.waitForTimeout(700);
            log('attach_image_done', { image: path.basename(String(imagePath || '')), method: `menu_chooser:${openSel}|${itemSel}` });
            return true;
          }

          // Some UI creates/updates file input without native chooser event.
          const menuInput = page.locator('input[type="file"]').first();
          if (await menuInput.count()) {
            await menuInput.setInputFiles(imagePath, { timeout: 3000 });
            await page.waitForTimeout(700);
            log('attach_image_done', { image: path.basename(String(imagePath || '')), method: `menu_input:${openSel}|${itemSel}` });
            return true;
          }
        } catch {
          // next menu item selector
        }
      }
    } catch {
      // next opener
    }
  }

  // 3) keyboard fallback
  try {
    const hotkey = process.platform === 'darwin' ? 'Meta+O' : 'Control+O';
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 3500 }).catch(() => null);
    await page.keyboard.press(hotkey);
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(imagePath);
      await page.waitForTimeout(700);
      log('attach_image_done', { image: path.basename(String(imagePath || '')), method: 'keyboard_hotkey' });
      return true;
    }
  } catch {
    // ignore
  }

  // 4) one more direct input pass in case DOM changed after menu interactions
  const inputLocator2 = page.locator('input[type="file"]');
  const count2 = await inputLocator2.count();
  for (let i = 0; i < count2; i++) {
    const one = inputLocator2.nth(i);
    try {
      await one.setInputFiles(imagePath, { timeout: 4000 });
      await page.waitForTimeout(700);
      log('attach_image_done', { image: path.basename(String(imagePath || '')), method: 'direct_input_retry' });
      return true;
    } catch {
      // try next
    }
  }

  log('attach_image_failed', { image: path.basename(String(imagePath || '')) });
  return false;
}
async function fillComposer(page, text) {
  await dismissBlockingDialogs(page);
  let composer = await findComposer(page);
  if (!composer) throw new Error('composer not found while typing');

  let loc = composer.locator;
  let tag = await loc.evaluate((el) => (el.tagName || '').toLowerCase()).catch(() => '');
  const safeText = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  log('composer_fill', {
    length: safeText.length,
    preview: safeText.slice(0, 180),
  });

  const applyText = async () => {
    if (tag === 'textarea' || tag === 'input') {
      await loc.fill(safeText);
    } else {
      await loc.click({ timeout: 5000 });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.insertText(safeText);
    }
  };

  try {
    await applyText();
  } catch (err) {
    const message = String(err && err.message ? err.message : err).toLowerCase();
    if (!/intercepts pointer events|overlay|backdrop|pointer events/.test(message)) throw err;

    await dismissBlockingDialogs(page);
    await page.waitForTimeout(250);
    composer = await findComposer(page);
    if (!composer) throw err;
    loc = composer.locator;
    tag = await loc.evaluate((el) => (el.tagName || '').toLowerCase()).catch(() => '');
    await applyText();
  }
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

function getStopSelectors() {
  return [
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="stop" i]',
    'button[aria-label*="\u505c\u6b62" i]',
    'button[aria-label*="\u505c\u6b62\u751f\u6210" i]',
    'button[aria-label*="\u505c\u6b62\u56de\u5e94" i]',
    'button:has-text("Stop generating")',
    'button:has-text("Stop")',
    `button:has-text("${'\u505c\u6b62'}")`,
    `button:has-text("${'\u505c\u6b62\u751f\u6210'}")`,
    `button:has-text("${'\u505c\u6b62\u56de\u5e94'}")`,
    '[data-test-id="stop-button"]',
    '[data-test-id*="stop" i]',
    '[data-testid*="stop" i]',
  ];
}

function getGeneratingSelectors() {
  return [
    ':text("Generating the Image")',
    ':text("Generating image")',
    ':text("Generating...")',
    ':text("Creating image")',
    ':text("生成图片")',
    ':text("正在生成")',
    ':text("生成中")',
  ];
}

async function pickSendButton(page) {
  const sendSelectors = [
    '[aria-label="Send message"]',
    'button[aria-label*="Send message" i]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Run" i]',
    'button[aria-label*="\u53d1\u9001" i]',
    'button[aria-label*="\u63d0\u4ea4" i]',
    'button:has-text("Send message")',
    'button:has-text("Send")',
    `button:has-text("${'\u53d1\u9001'}")`,
    `button:has-text("${'\u63d0\u4ea4'}")`,
    '[data-test-id*="send" i]',
    '[data-testid*="send" i]',
  ];

  for (const sel of sendSelectors) {
    const loc = page.locator(sel);
    const count = await loc.count();
    for (let i = count - 1; i >= 0; i--) {
      const one = loc.nth(i);
      try {
        if (await one.isVisible() && await one.isEnabled()) return one;
      } catch {
        // ignore
      }
    }
  }

  // Heuristic fallback: pick the right-most enabled button in lower half.
  const viewport = page.viewportSize() || { width: 1480, height: 960 };
  const all = page.locator('button,[role="button"]');
  const total = Math.min(await all.count(), 320);
  let best = { idx: -1, score: -1 };

  for (let i = 0; i < total; i++) {
    const btn = all.nth(i);
    try {
      if (!(await btn.isVisible()) || !(await btn.isEnabled())) continue;
      const box = await btn.boundingBox();
      if (!box) continue;
      if (box.y < viewport.height * 0.48) continue;

      const text = await btn.evaluate((el) => {
        const raw = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`;
        return raw.toLowerCase();
      }).catch(() => '');

      let score = (box.x + box.width) + box.y;
      if (box.width <= 72 && box.height <= 72) score += 120;
      if (/(send|run|submit|\u53d1\u9001|\u8fd0\u884c|\u63d0\u4ea4)/i.test(text)) score += 2000;
      if (/(upload|tool|\u4e0a\u4f20|\u5de5\u5177|\u6dfb\u52a0|\+)/i.test(text)) score -= 1400;
      if (score > best.score) best = { idx: i, score };
    } catch {
      // ignore
    }
  }

  if (best.idx >= 0) return all.nth(best.idx);
  return null;
}

async function sendMessage(page, options = {}) {
  const waitReadyMs = Math.max(5000, toInt(options.waitReadyMs, 45000));
  const throwOnTimeout = toBool(options.throwOnTimeout, true);
  const start = Date.now();
  let lastErr = '';

  while (Date.now() - start < waitReadyMs) {
    const btn = await pickSendButton(page);
    if (btn) {
      try {
        await btn.click({ timeout: 2500 });
        await page.waitForTimeout(180);
        log('send_message_done', { method: 'button' });
        return true;
      } catch (e) {
        lastErr = String(e?.message || e);
      }
    }
    await page.waitForTimeout(650);
  }

  // Keyboard fallback only when not generating.
  const busy = await anyVisible(page, getStopSelectors());
  if (!busy) {
    try {
      const combo = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';
      await page.keyboard.press(combo);
      await page.waitForTimeout(200);
      log('send_message_done', { method: 'keyboard', combo });
      return true;
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }

  if (throwOnTimeout) {
    log('send_message_failed', { error: lastErr || 'send button unavailable' });
    throw new Error(`Send button not found or not enabled. ${lastErr}`.trim());
  }
  log('send_message_failed', { error: lastErr || 'send button unavailable', throwOnTimeout: false });
  return false;
}

async function waitForGeminiIdle(page, timeoutMs, options = {}) {
  const stopSelectors = getStopSelectors();
  const generatingSelectors = getGeneratingSelectors();

  const minNoBusyMs = Math.max(3000, toInt(options.minNoBusyMs, 45000));
  const throwOnTimeout = toBool(options.throwOnTimeout, false);
  const start = Date.now();
  let seenBusy = false;
  let stableNoBusyRounds = 0;
  log('wait_idle_start', { timeoutMs, minNoBusyMs, throwOnTimeout });

  while (Date.now() - start < timeoutMs) {
    const busyStop = await anyVisible(page, stopSelectors);
    const busyGenerating = await anyVisible(page, generatingSelectors);
    const busy = busyStop || busyGenerating;
    if (busy) {
      seenBusy = true;
      stableNoBusyRounds = 0;
      await page.waitForTimeout(1200);
      continue;
    }

    stableNoBusyRounds += 1;
    const elapsed = Date.now() - start;
    const stableNow = stableNoBusyRounds >= 3;

    if (seenBusy && stableNow) {
      log('wait_idle_done', { elapsedMs: elapsed, seenBusy, stableNoBusyRounds });
      return;
    }
    if (!seenBusy && elapsed >= minNoBusyMs && stableNow) {
      log('wait_idle_done', { elapsedMs: elapsed, seenBusy, stableNoBusyRounds });
      return;
    }
    await page.waitForTimeout(1200);
  }

  if (throwOnTimeout) {
    log('wait_idle_timeout', { timeoutMs, minNoBusyMs, seenBusy, stableNoBusyRounds });
    throw new Error('Timed out while waiting Gemini to become idle.');
  }
  log('wait_idle_timeout', { timeoutMs, minNoBusyMs, seenBusy, stableNoBusyRounds, nonThrowing: true });
}

async function reloadCurrentConversationPage(page, reason = '') {
  try {
    log('page_refresh_start', { reason, url: page.url() });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2200);
    await dismissBlockingDialogs(page);
    await waitForComposer(page, 30000);
    await waitForGeminiIdle(page, 30000, { minNoBusyMs: 5000, throwOnTimeout: false });
    log('page_refresh_done', { reason, url: page.url() });
    return true;
  } catch (err) {
    log('page_refresh_failed', {
      reason,
      error: String(err && err.message ? err.message : err),
    });
    return false;
  }
}

function candidateKey(c) {
  const normalizedSrc = normalizeUrlNoQuery(c.src || c.src_no_query || '');
  const short = normalizedSrc.length > 240 ? normalizedSrc.slice(0, 240) : normalizedSrc;
  if (short) return `${short}|${c.width || 0}x${c.height || 0}`;
  if (c && c.markerId) return `marker:${c.markerId}|${c.displayWidth || 0}x${c.displayHeight || 0}|${c.x || 0},${c.y || 0}`;
  return `unknown|${c.width || 0}x${c.height || 0}|${c.displayWidth || 0}x${c.displayHeight || 0}|${c.x || 0},${c.y || 0}`;
}

function isTransientNavigationError(err) {
  const msg = String(err && err.message ? err.message : err || '');
  return /execution context was destroyed/i.test(msg)
    || /most likely because of a navigation/i.test(msg)
    || /cannot find context with specified id/i.test(msg)
    || /target page, context or browser has been closed/i.test(msg)
    || /frame was detached/i.test(msg);
}

async function collectImageCandidates(page) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await page.evaluate(() => {
        const stripQuery = (src) => {
          try {
            const u = new URL(src);
            u.search = '';
            u.hash = '';
            return u.toString();
          } catch {
            return src;
          }
        };

        const nextMarkerId = () => `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const imgs = Array.from(document.querySelectorAll('img'));
        return imgs
          .map((img, domIndex) => {
            if (!img.dataset.codexImgId) img.dataset.codexImgId = nextMarkerId();
            const rect = img.getBoundingClientRect();
            const naturalWidth = Number(img.naturalWidth || 0);
            const naturalHeight = Number(img.naturalHeight || 0);
            return {
              markerId: img.dataset.codexImgId,
              src: img.currentSrc || img.src || '',
              src_no_query: stripQuery(img.currentSrc || img.src || ''),
              alt: img.alt || '',
              width: naturalWidth,
              height: naturalHeight,
              complete: !!img.complete,
              displayWidth: Math.round(rect.width || img.clientWidth || 0),
              displayHeight: Math.round(rect.height || img.clientHeight || 0),
              x: Math.round(rect.x || 0),
              y: Math.round(rect.y || 0),
              domIndex,
            };
          })
          .filter((x) => {
            if (!x.src) return false;
            if (x.src.startsWith('https://ssl.gstatic.com')) return false;
            if (!x.complete) return false;
            if ((x.width || 0) < 200 || (x.height || 0) < 200) return false;
            const displayW = x.displayWidth || 0;
            const displayH = x.displayHeight || 0;
            const displayArea = displayW * displayH;
            if (Math.max(displayW, displayH) < 140 && displayArea < 18000) return false;
            return true;
          });
      });
    } catch (err) {
      lastErr = err;
      if (!isTransientNavigationError(err) || attempt >= 6) throw err;
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 });
      } catch {
        // ignore transient navigation timing
      }
      await page.waitForTimeout(500);
    }
  }
  throw lastErr;
}

async function fetchCandidateData(page, candidate) {
  const src = String(candidate.src || '');

  if (src.startsWith('data:')) {
    const m = src.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      const mime = m[1] || 'image/png';
      const b64 = m[2] || '';
      const buffer = Buffer.from(b64, 'base64');
      const dim = detectImageDimensions(buffer, mime);
      return { ok: true, mime, base64: b64, buffer, width: dim.width, height: dim.height, method: 'data-url' };
    }
  }

  // Try context.request first for http(s) URLs (bypasses page CORS constraints).
  if (/^https?:\/\//i.test(src)) {
    try {
      const response = await page.context().request.get(src, {
        timeout: 20000,
        failOnStatusCode: false,
      });
      if (response.ok()) {
        const buffer = await response.body();
        if (buffer && buffer.length > 0) {
          const headers = response.headers();
          const mime = String(headers['content-type'] || 'image/png');
          const dim = detectImageDimensions(buffer, mime);
          return {
            ok: true,
            mime,
            base64: buffer.toString('base64'),
            buffer,
            width: dim.width,
            height: dim.height,
            method: 'context-request',
          };
        }
      }
    } catch {
      // fallback below
    }
  }

  // Try fetch() in page context (works for blob/data URLs and CORS-allowed URLs)
  try {
    const fetched = await page.evaluate(async (imageSrc) => {
      try {
        const r = await fetch(imageSrc);
        if (!r.ok) return { ok: false, error: `status ${r.status}` };

        const blob = await r.blob();
        const arr = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < arr.length; i += CHUNK) {
          binary += String.fromCharCode(...arr.subarray(i, i + CHUNK));
        }
        return { ok: true, mime: blob.type || 'image/png', base64: btoa(binary) };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }, src);

    if (fetched?.ok && fetched.base64) {
      const buffer = Buffer.from(fetched.base64, 'base64');
      const dim = detectImageDimensions(buffer, fetched.mime || 'image/png');
      return {
        ok: true,
        mime: fetched.mime || 'image/png',
        base64: fetched.base64,
        buffer,
        width: dim.width,
        height: dim.height,
        method: 'fetch',
      };
    }
  } catch {
    // fallback below
  }

  return { ok: false, error: 'extract failed: unable to fetch original image bytes' };
}

async function tryClickAndCaptureDownload(page, locator, saveBasePath) {
  try {
    log('ui_download_click_start', { saveBasePath });
    const downloadsDir = getDefaultDownloadsDir();
    const beforeSnapshot = snapshotDownloadDir(downloadsDir);
    const beforePlaywrightArtifacts = snapshotPlaywrightArtifactDir();
    const clickStartedAt = Date.now();
    const downloadPromise = page.waitForEvent('download', { timeout: 12000 }).catch(() => null);
    await locator.click({ timeout: 2000 });
    const dl = await downloadPromise;

    if (dl) {
      const suggested = dl.suggestedFilename() || 'gemini_image.png';
      const ext = path.extname(suggested) || '.png';
      const savePath = `${saveBasePath}${ext}`;
      await dl.saveAs(savePath);

      const buffer = fs.readFileSync(savePath);
      const dim = detectImageDimensions(buffer, ext.replace('.', ''));
      log('ui_download_click_done', {
        method: 'playwright-download-event',
        savePath,
        suggested: suggested,
        width: dim.width,
        height: dim.height,
      });
      return {
        ok: true,
        mime: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : (ext === '.webp' ? 'image/webp' : 'image/png'),
        buffer,
        width: dim.width,
        height: dim.height,
        method: 'ui-download',
        suggested_filename: suggested,
        tempPath: savePath,
      };
    }

    const freshDownloadsFile = await waitForFreshDownloadedImage(downloadsDir, beforeSnapshot, clickStartedAt, 12000);
    if (freshDownloadsFile) {
      const built = buildDownloadedFileResult(freshDownloadsFile, saveBasePath, 'browser-download-dir-fallback');
      if (built) {
        log('ui_download_click_done', {
          method: 'browser-download-dir-fallback',
          savePath: built.tempPath,
          suggested: freshDownloadsFile.name,
          width: built.width,
          height: built.height,
        });
        return built;
      }
    }

    const freshArtifactFile = await waitForFreshPlaywrightArtifact(beforePlaywrightArtifacts, clickStartedAt, 12000);
    if (!freshArtifactFile) {
      log('ui_download_click_no_file', { saveBasePath });
      return null;
    }

    const builtArtifact = buildDownloadedFileResult(freshArtifactFile, saveBasePath, 'ui-download/playwright-artifact-fallback');
    if (!builtArtifact) {
      log('ui_download_click_no_file', { saveBasePath, artifactPath: freshArtifactFile.full });
      return null;
    }
    log('ui_download_click_done', {
      method: 'playwright-artifact-fallback',
      savePath: builtArtifact.tempPath,
      suggested: freshArtifactFile.name,
      width: builtArtifact.width,
      height: builtArtifact.height,
    });
    return builtArtifact;
  } catch {
    log('ui_download_click_failed', { saveBasePath });
    return null;
  }
}

async function clearTargetCardMarks(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll('[data-codex-target-card],[data-codex-target-image]').forEach((el) => {
        el.removeAttribute('data-codex-target-card');
        el.removeAttribute('data-codex-target-image');
      });
    });
  } catch {
    // ignore cleanup failure
  }
}

async function markTargetCardFromImage(imgLocator, markerId) {
  try {
    return await imgLocator.evaluate((el, payload) => {
      const { downloadSelectors, markerId: targetMarkerId } = payload;
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      document.querySelectorAll('[data-codex-target-card],[data-codex-target-image]').forEach((node) => {
        node.removeAttribute('data-codex-target-card');
        node.removeAttribute('data-codex-target-image');
      });

      const elementBox = el.getBoundingClientRect();
      const hasVisibleDownloadButton = (node) => {
        for (const sel of downloadSelectors) {
          try {
            const buttons = Array.from(node.querySelectorAll(sel));
            if (buttons.some(visible)) return true;
          } catch {
            // ignore one bad selector
          }
        }
        return false;
      };

      el.setAttribute('data-codex-target-image', targetMarkerId);

      let chosen = null;
      let cursor = el.parentElement;
      while (cursor) {
        const rect = cursor.getBoundingClientRect();
        const looksLikeCard = rect.width >= Math.max(140, elementBox.width - 24)
          && rect.height >= Math.max(140, elementBox.height - 24);
        if (looksLikeCard && hasVisibleDownloadButton(cursor)) {
          chosen = cursor;
          break;
        }
        cursor = cursor.parentElement;
      }

      if (!chosen) {
        cursor = el.parentElement;
        while (cursor) {
          const rect = cursor.getBoundingClientRect();
          const containsImageArea = rect.width >= Math.max(140, elementBox.width - 24)
            && rect.height >= Math.max(140, elementBox.height - 24);
          if (containsImageArea) {
            chosen = cursor;
            if (rect.width >= elementBox.width + 24 || rect.height >= elementBox.height + 24) break;
          }
          cursor = cursor.parentElement;
        }
      }

      if (chosen) chosen.setAttribute('data-codex-target-card', targetMarkerId);

      const toBox = (rect) => rect ? ({
        x: Math.round(rect.x || 0),
        y: Math.round(rect.y || 0),
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0),
      }) : null;

      return {
        ok: true,
        hasCard: Boolean(chosen),
        imgBox: toBox(elementBox),
        cardBox: chosen ? toBox(chosen.getBoundingClientRect()) : null,
      };
    }, {
      downloadSelectors: GEMINI_DOWNLOAD_SELECTORS,
      markerId,
    });
  } catch {
    return null;
  }
}

async function tryDownloadFromGeminiUi(page, debugDir, task, attempt, preferredCandidates = null) {
  const saveBase = path.join(debugDir, `ui_dl_${task.id}_a${attempt}_${Date.now()}`);

  const trySelectors = async () => {
    for (const sel of GEMINI_DOWNLOAD_SELECTORS) {
      const loc = page.locator(sel);
      const count = await loc.count();
      if (!count) continue;
      for (let i = count - 1; i >= Math.max(0, count - 10); i--) {
        const one = loc.nth(i);
        try {
          if (!(await one.isVisible())) continue;
          const oneResult = await tryClickAndCaptureDownload(page, one, saveBase);
          if (oneResult) return oneResult;
        } catch {
          // continue
        }
      }
    }
    return null;
  };

  const trySelectorsNear = async (targetBox) => {
    if (!targetBox) return null;
    const cx = targetBox.x + targetBox.width / 2;
    const cy = targetBox.y + targetBox.height / 2;
    const nearby = [];
    for (const sel of GEMINI_DOWNLOAD_SELECTORS) {
      const loc = page.locator(sel);
      const count = await loc.count();
      for (let i = 0; i < count; i++) {
        const one = loc.nth(i);
        try {
          if (!(await one.isVisible())) continue;
          const box = await one.boundingBox();
          if (!box) continue;
          const bx = box.x + box.width / 2;
          const by = box.y + box.height / 2;
          const dx = Math.abs(bx - cx);
          const dy = Math.abs(by - cy);
          if (dx > 460 || dy > 520) continue;
          nearby.push({ locator: one, score: dx + dy * 1.2 });
        } catch {
          // ignore
        }
      }
    }
    nearby.sort((a, b) => a.score - b.score);
    for (const one of nearby.slice(0, 12)) {
      const oneResult = await tryClickAndCaptureDownload(page, one.locator, saveBase);
      if (oneResult) return oneResult;
    }
    return null;
  };

  const trySelectorsInMarkedCard = async (markerId) => {
    if (!markerId) return null;
    const card = page.locator(`[data-codex-target-card="${markerId}"]`).first();
    try {
      if (!(await card.count()) || !(await card.isVisible())) return null;
    } catch {
      return null;
    }

    for (const sel of GEMINI_DOWNLOAD_SELECTORS) {
      try {
        const loc = card.locator(sel);
        const count = await loc.count();
        for (let i = count - 1; i >= 0; i--) {
          const one = loc.nth(i);
          try {
            if (!(await one.isVisible())) continue;
            const oneResult = await tryClickAndCaptureDownload(page, one, saveBase);
            if (oneResult) return oneResult;
          } catch {
            // continue
          }
        }
      } catch {
        // continue
      }
    }
    return null;
  };

  const tryTopToolbarButtons = async () => {
    const viewport = page.viewportSize() || { width: 1480, height: 960 };
    const all = page.locator('button,[role="button"]');
    const total = await all.count();
    const picks = [];

    for (let i = 0; i < total; i++) {
      const one = all.nth(i);
      try {
        if (!(await one.isVisible())) continue;
        const box = await one.boundingBox();
        if (!box) continue;
        if (box.y > Math.max(140, viewport.height * 0.18)) continue;
        if (box.x < viewport.width * 0.72) continue;
        if (box.width > 76 || box.height > 76) continue;

        const meta = await one.evaluate((el) => ({
          text: String(el.textContent || '').trim(),
          aria: String(el.getAttribute('aria-label') || '').trim(),
          title: String(el.getAttribute('title') || '').trim(),
        })).catch(() => ({ text: '', aria: '', title: '' }));

        const label = `${meta.text} ${meta.aria} ${meta.title}`.toLowerCase();
        if (/done|back|close|share|copy|more|menu|完成|关闭|分享|复制|更多/.test(label)) continue;

        picks.push({ locator: one, x: box.x, label });
      } catch {
        // ignore one bad candidate
      }
    }

    if (!picks.length) return null;

    picks.sort((a, b) => a.x - b.x);
    const ordered = picks.length <= 2
      ? picks
      : picks.slice(1, Math.max(1, picks.length - 1)).concat([picks[0], picks[picks.length - 1]]);

    for (const pick of ordered.slice(0, 6)) {
      const oneResult = await tryClickAndCaptureDownload(page, pick.locator, saveBase);
      if (oneResult) return oneResult;
      try { await page.keyboard.press('Escape'); } catch {}
      await page.waitForTimeout(150);
    }

    return null;
  };

  const preferredIndexes = Array.isArray(preferredCandidates)
    ? await (async () => {
        const picks = [];
        for (const candidate of preferredCandidates) {
          const markerId = String(candidate && candidate.markerId || '').trim();
          if (!markerId) continue;
          try {
            const marked = page.locator(`img[data-codex-img-id="${markerId}"]`).first();
            if (await marked.count() > 0 && await marked.isVisible()) {
              const idx = await marked.evaluate((el) => {
                const all = Array.from(document.querySelectorAll('img'));
                return all.indexOf(el);
              });
              if (Number.isInteger(idx) && idx >= 0) picks.push(idx);
            }
          } catch {
            // fallback below
          }
        }
        if (picks.length) {
          return Array.from(new Set(picks)).sort((a, b) => b - a);
        }

        const all = page.locator('img');
        const total = await all.count();
        const live = [];
        for (let i = 0; i < total; i++) {
          const img = all.nth(i);
          try {
            if (!(await img.isVisible())) continue;
            const meta = await img.evaluate((el) => {
              const box = el.getBoundingClientRect();
              return {
                markerId: el.dataset.codexImgId || '',
                src: el.currentSrc || el.src || '',
                width: el.naturalWidth || el.width || 0,
                height: el.naturalHeight || el.height || 0,
                displayWidth: Math.round(box.width || el.clientWidth || 0),
                displayHeight: Math.round(box.height || el.clientHeight || 0),
                x: Math.round(box.x || 0),
                y: Math.round(box.y || 0),
              };
            });
            live.push({
              idx: i,
              markerId: meta.markerId || '',
              srcNoQuery: normalizeUrlNoQuery(meta.src),
              width: meta.width || 0,
              height: meta.height || 0,
              displayWidth: meta.displayWidth || 0,
              displayHeight: meta.displayHeight || 0,
              x: meta.x || 0,
              y: meta.y || 0,
            });
          } catch {
            // ignore one bad image node
          }
        }

        const fallbackPicks = [];
        for (const candidate of preferredCandidates) {
          const wantedMarker = String(candidate && candidate.markerId || '').trim();
          const wantedSrc = normalizeUrlNoQuery(candidate && (candidate.src || candidate.src_no_query || ''));
          let best = null;
          for (const item of live) {
            let score = 0;
            if (wantedMarker) {
              if (item.markerId === wantedMarker) score += 1000000;
              else score -= 500000;
            }
            if (wantedSrc) {
              if (item.srcNoQuery !== wantedSrc) continue;
              score += 100000;
            } else {
              score += 1000;
            }
            score -= Math.abs((item.displayWidth || 0) - (candidate.displayWidth || 0)) * 4;
            score -= Math.abs((item.displayHeight || 0) - (candidate.displayHeight || 0)) * 4;
            score -= Math.abs((item.x || 0) - (candidate.x || 0));
            score -= Math.abs((item.y || 0) - (candidate.y || 0));
            if (!best || score > best.score) best = { idx: item.idx, score };
          }
          if (best) fallbackPicks.push(best.idx);
        }

        return Array.from(new Set(fallbackPicks)).sort((a, b) => b - a);
      })()
    : [];

  // If caller gives preferred candidates, only target those generated nodes.
  if (preferredIndexes.length) {
    for (const idx of preferredIndexes) {
      const img = page.locator('img').nth(idx);
      let box = null;
      const markerId = `target_${Date.now()}_${idx}`;
      try {
        if (!(await img.count()) || !(await img.isVisible())) continue;
        const size = await img.evaluate((el) => ({
          w: el.naturalWidth || el.width || 0,
          h: el.naturalHeight || el.height || 0,
        }));
        if (Math.max(size.w, size.h) < 300) continue;
        await img.scrollIntoViewIfNeeded();
        await img.hover({ timeout: 1200 });
        await page.waitForTimeout(180);
        const marked = await markTargetCardFromImage(img, markerId);
        box = marked && marked.cardBox ? marked.cardBox : (marked && marked.imgBox ? marked.imgBox : await img.boundingBox());
      } catch {
        await clearTargetCardMarks(page);
        continue;
      }

      const fromMarkedCard = await trySelectorsInMarkedCard(markerId);
      if (fromMarkedCard) {
        await clearTargetCardMarks(page);
        return fromMarkedCard;
      }
      const near = await trySelectorsNear(box);
      if (near) {
        await clearTargetCardMarks(page);
        return near;
      }
      try {
        await img.click({ timeout: 1500 });
        await page.waitForTimeout(240);
      } catch {
        await clearTargetCardMarks(page);
        continue;
      }
      const fromMarkedCardAfterClick = await trySelectorsInMarkedCard(markerId);
      if (fromMarkedCardAfterClick) {
        await clearTargetCardMarks(page);
        return fromMarkedCardAfterClick;
      }
      const globalAfterClick = await trySelectors();
      if (globalAfterClick) {
        await clearTargetCardMarks(page);
        return globalAfterClick;
      }
      const toolbarAfterClick = await tryTopToolbarButtons();
      if (toolbarAfterClick) {
        await clearTargetCardMarks(page);
        return toolbarAfterClick;
      }
      try { await page.keyboard.press('Escape'); } catch {}
      await page.waitForTimeout(120);
      await clearTargetCardMarks(page);
    }
    return null;
  }

  // No preferred candidates: fallback to previous global strategy.
  const direct = await trySelectors();
  if (direct) return direct;

  const imgs = page.locator('img');
  const count = await imgs.count();
  for (let i = count - 1; i >= Math.max(0, count - 8); i--) {
    const img = imgs.nth(i);
    try {
      const size = await img.evaluate((el) => ({
        w: el.naturalWidth || el.width || 0,
        h: el.naturalHeight || el.height || 0,
      }));
      if (Math.max(size.w, size.h) < 180) continue;
      await img.scrollIntoViewIfNeeded();
      await img.hover({ timeout: 1200 });
      await page.waitForTimeout(180);
      await img.click({ timeout: 1200 });
      await page.waitForTimeout(220);
      const fromOverlay = await trySelectors();
      if (fromOverlay) return fromOverlay;
      const fromToolbar = await tryTopToolbarButtons();
      if (fromToolbar) return fromToolbar;
      try { await page.keyboard.press('Escape'); } catch {}
      await page.waitForTimeout(120);
    } catch {
      // next
    }
  }

  return null;
}

async function hasVisibleGeminiDownloadButton(page) {
  for (const sel of GEMINI_DOWNLOAD_SELECTORS) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    if (!count) continue;
    for (let i = count - 1; i >= Math.max(0, count - 8); i--) {
      const one = loc.nth(i);
      try {
        if (await one.isVisible()) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

async function captureFailureShot(page, debugDir, taskId, attempt, reason, item, failedScreenshots) {
  if (!page) return null;
  try {
    const file = path.join(
      debugDir,
      `fail_${safeSlug(taskId)}_a${String(attempt)}_${safeSlug(reason)}.png`
    );
    await page.screenshot({ path: file, fullPage: true });
    if (item && Array.isArray(item.debug_screenshots)) item.debug_screenshots.push(file);
    if (Array.isArray(failedScreenshots)) failedScreenshots.push(file);
    return file;
  } catch {
    return null;
  }
}

async function captureTraceShot(page, debugDir, label, payload = {}) {
  if (!page || !debugDir) return null;
  try {
    traceShotSeq += 1;
    const file = path.join(
      debugDir,
      `${String(traceShotSeq).padStart(4, '0')}_${safeSlug(label)}.png`
    );
    await page.screenshot({ path: file, fullPage: true });
    log('trace_screenshot', { label, path: file, ...payload });
    return file;
  } catch (err) {
    log('trace_screenshot_failed', {
      label,
      error: String(err && err.message ? err.message : err),
    });
    return null;
  }
}

async function detectTemporaryBusyReply(page) {
  try {
    const tailText = await page.evaluate(() => {
      const t = (document.body && document.body.innerText) ? document.body.innerText : '';
      return String(t || '').slice(-5000).toLowerCase();
    });
    const patterns = [
      /ask me again later/,
      /can't do that (for you )?right now/,
      /try again later/,
      /too many requests/,
      /rate limit/,
      /temporarily unavailable/,
      /currently unavailable/,
      /please wait/,
      /稍后再试/,
      /请稍后再试/,
      /当前无法/,
      /请求过多/,
      /限流/,
      /繁忙/,
      /忙不过来/,
    ];
    return patterns.some((re) => re.test(tailText));
  } catch {
    return false;
  }
}

function extractLatestAssistantReplyWindow(text) {
  const source = String(text || '');
  if (!source) return '';
  const markers = [
    /product keywords:[^\r\n]*/ig,
    /continue generating (?:main image|a\+ image) #\d+\./ig,
    /i cannot see the image\.[^\r\n]*/ig,
    /please regenerate (?:main image|a\+ image) #\d+\./ig,
    /regenerate (?:main image|a\+ image) #\d+\./ig,
    /these are additional reference images #[^\r\n]*/ig,
  ];
  let cutAt = -1;
  for (const re of markers) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      const end = match.index + String(match[0] || '').length;
      if (end > cutAt) cutAt = end;
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  const tail = cutAt >= 0 ? source.slice(cutAt) : source;
  return tail.replace(/\s+/g, ' ').trim();
}

async function detectModelNeedsInputsReply(page) {
  try {
    const conversationTail = await page.evaluate(() => {
      const t = (document.body && document.body.innerText) ? document.body.innerText : '';
      return String(t || '').slice(-8000);
    });
    const latestReplyText = extractLatestAssistantReplyWindow(conversationTail).toLowerCase();
    const asksImages = /(upload|send|provide|share|attach).{0,60}(product images|reference images|images of the product)/.test(latestReplyText)
      || /(product images|reference images|images of the product).{0,60}(upload|send|provide|share|attach)/.test(latestReplyText);
    const asksKeywords = /(provide|send|share|enter|type).{0,60}(product keywords|keywords|selling[- ]point keywords|amazon selling[- ]point keywords)/.test(latestReplyText)
      || /(product keywords|selling[- ]point keywords|amazon selling[- ]point keywords).{0,60}(provide|send|share|enter|type|required|needed)/.test(latestReplyText)
      || /please.{0,40}(product keywords|keywords|selling[- ]point keywords|amazon selling[- ]point keywords)/.test(latestReplyText);
    return {
      needsImages: asksImages,
      needsKeywords: asksKeywords,
      latestReplyText,
    };
  } catch {
    return {
      needsImages: false,
      needsKeywords: false,
      latestReplyText: '',
    };
  }
}

async function hasKeywordsContextInConversation(page, keywords) {
  try {
    const normalized = String(keywords || '').trim();
    const hint = normalized
      .split(/[,，;；|\/\s]+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2)
      .slice(0, 2);

    const text = await page.evaluate(() => {
      const t = (document.body && document.body.innerText) ? document.body.innerText : '';
      return String(t || '').slice(-15000);
    });
    if (!/Product keywords:/i.test(text)) return false;
    if (!hint.length) return true;
    return hint.some((h) => text.includes(h));
  } catch {
    return false;
  }
}

async function resendRequestedInputs(page, imagePaths, keywords, idleNoBusyMs, genTimeoutSec, options = {}) {
  const needImages = toBool(options.needImages, false);
  const needKeywords = toBool(options.needKeywords, false);
  if (!needImages && !needKeywords) {
    return { sentImages: 0, sentKeywords: false };
  }

  await waitForComposer(page, 20000);
  await dismissBlockingDialogs(page);

  let sentCount = 0;
  if (needImages) {
    for (const p of imagePaths) {
      const attached = await attachImage(page, p);
      if (!attached) {
        throw new Error(`Recovery bootstrap failed: cannot upload reference image #${sentCount + 1}.`);
      }
      sentCount += 1;
      await page.waitForTimeout(260);
    }
  }

  let sentKeywords = false;
  if (needKeywords) {
    const prompt = `Product keywords: ${keywords}`;

    await fillComposer(page, prompt);
    const composerText = await readComposerText(page);
    if (!/product keywords:/i.test(composerText)) {
      throw new Error('Recovery bootstrap failed: keyword prompt not typed.');
    }
    sentKeywords = true;
  }

  const beforeSubmitCandidates = await collectImageCandidates(page);
  const beforeSubmitTail = await getConversationTail(page);
  await sendMessage(page, { waitReadyMs: 90000, throwOnTimeout: true });
  await waitForReferenceSubmissionSettled(page, beforeSubmitCandidates, beforeSubmitTail, genTimeoutSec, idleNoBusyMs, {
    phase: 'recovery_bootstrap',
    needsImages: needImages,
    needsKeywords: sentKeywords,
  });
  await page.waitForTimeout(800);
  return { sentImages: sentCount, sentKeywords };
}

async function getConversationTail(page, limit = 8000) {
  try {
    return await page.evaluate((chars) => {
      const t = (document.body && document.body.innerText) ? document.body.innerText : '';
      return String(t || '').slice(-chars);
    }, limit);
  } catch {
    return '';
  }
}

function hasTextOnlyGenerationProgress(beforeTail, afterTail) {
  const before = String(beforeTail || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const after = String(afterTail || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!after || after === before) return false;

  const growth = Math.max(0, after.length - before.length);
  const generationPatterns = [
    /generating image/,
    /here is main image #\d+/,
    /main image #\d+/,
    /a\+ image #\d+/,
    /please review this image/,
    /if you are satisfied, i will proceed/,
    /i (?:will )?(?:now )?proceed with generating/,
    /i have completed the .*?(?:main|a\+)\s+image/,
    /shall i continue(?: to the next one)?/,
    /continue to the next one/,
  ];
  const beforeMatched = generationPatterns.some((re) => re.test(before));
  const afterMatched = generationPatterns.some((re) => re.test(after));
  return afterMatched && (growth >= 80 || !beforeMatched);
}

async function stopCurrentResponseIfBusy(page, meta = {}) {
  const stopSelectors = getStopSelectors();
  for (const sel of stopSelectors) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const one = loc.nth(i);
      try {
        if (!(await one.isVisible()) || !(await one.isEnabled())) continue;
        await one.click({ timeout: 1500 });
        await page.waitForTimeout(400);
        log('stop_current_response_done', { ...meta, selector: sel, index: i });
        await waitForGeminiIdle(page, 20000, { minNoBusyMs: 3000, throwOnTimeout: false });
        return true;
      } catch {
        // try next visible stop control
      }
    }
  }
  log('stop_current_response_skip', meta);
  return false;
}

async function waitForReferenceSubmissionSettled(page, beforeCandidates, beforeTail, genTimeoutSec, idleNoBusyMs, meta = {}) {
  try {
    await waitForGeminiIdle(page, genTimeoutSec * 1000, { minNoBusyMs: idleNoBusyMs, throwOnTimeout: true });
    return { status: 'idle', newCandidates: [] };
  } catch (err) {
    const beforeSet = new Set((beforeCandidates || []).map(candidateKey));
    const afterCandidates = await collectImageCandidates(page).catch(() => []);
    const newCandidates = afterCandidates.filter((c) => !beforeSet.has(candidateKey(c)));
    if (newCandidates.length) {
      log('reference_submission_timeout_with_new_images', {
        ...meta,
        count: newCandidates.length,
        indexes: newCandidates.map((x) => x.domIndex),
      });
      return {
        status: 'timeout_with_new_images',
        newCandidates,
        error: String(err && err.message ? err.message : err),
      };
    }

    const afterTail = await getConversationTail(page);
    if (!hasTextOnlyGenerationProgress(beforeTail, afterTail)) throw err;

    const stopped = await stopCurrentResponseIfBusy(page, {
      ...meta,
      reason: 'reference_submission_timeout_with_reply_text',
    }).catch(() => false);

    log('reference_submission_timeout_with_reply_text', {
      ...meta,
      beforeTailLength: String(beforeTail || '').length,
      afterTailLength: String(afterTail || '').length,
      stopped,
    });
    return {
      status: 'timeout_with_reply_text',
      newCandidates: [],
      error: String(err && err.message ? err.message : err),
    };
  }
}

async function waitForFixedPromptReplySettled(page, beforeCandidates, genTimeoutSec, idleNoBusyMs, meta = {}) {
  try {
    await waitForGeminiIdle(page, genTimeoutSec * 1000, { minNoBusyMs: idleNoBusyMs, throwOnTimeout: true });
    return { status: 'idle', newCandidates: [], needsInputsReply: false };
  } catch (err) {
    const beforeSet = new Set((beforeCandidates || []).map(candidateKey));
    const afterCandidates = await collectImageCandidates(page).catch(() => []);
    const newCandidates = afterCandidates.filter((c) => !beforeSet.has(candidateKey(c)));
    const inputReply = await detectModelNeedsInputsReply(page).catch(() => ({
      needsImages: false,
      needsKeywords: false,
      latestReplyText: '',
    }));
    const needsInputsReply = !!(inputReply.needsImages || inputReply.needsKeywords);
    if (!needsInputsReply && !newCandidates.length) throw err;

    log('fixed_prompt_timeout_but_reply_detected', {
      ...meta,
      count: newCandidates.length,
      indexes: newCandidates.map((x) => x.domIndex),
      needsInputsReply,
      needsImages: !!inputReply.needsImages,
      needsKeywords: !!inputReply.needsKeywords,
    });
    return {
      status: 'timeout_with_reply',
      newCandidates,
      needsInputsReply,
      error: String(err && err.message ? err.message : err),
    };
  }
}

function buildTasks() {
  return [
    { id: 'main_01', phase: 'main', idx: 1, width: 1600, height: 1600, goal: 'Main image #1. Pure white background (#FFFFFF). Product only. No text, no pets, no people, no extra props.' },
    { id: 'main_02', phase: 'main', idx: 2, width: 1600, height: 1600, goal: 'Main image #2. Japanese lifestyle scene with one person using the product.' },
    { id: 'main_03', phase: 'main', idx: 3, width: 1600, height: 1600, goal: 'Main image #3. Pet/family scene with the product.' },
    { id: 'main_04', phase: 'main', idx: 4, width: 1600, height: 1600, goal: 'Main image #4. Travel-use scene highlighting telescopic handle and movement.' },
    { id: 'main_05', phase: 'main', idx: 5, width: 1600, height: 1600, goal: 'Main image #5. Feature-focused visual showing wheels, handle, and folding design.' },
    { id: 'main_06', phase: 'main', idx: 6, width: 1600, height: 1600, goal: 'Main image #6. Capacity and storage organization visual.' },
    { id: 'main_07', phase: 'main', idx: 7, width: 1600, height: 1600, goal: 'Main image #7. Warm lifestyle scene (person + pet optional).' },
    { id: 'aplus_01', phase: 'a_plus', idx: 8, width: 970, height: 600, goal: 'A+ image #1 (970x600). Hero banner style, clearly different from all main images.' },
    { id: 'aplus_02', phase: 'a_plus', idx: 9, width: 970, height: 600, goal: 'A+ image #2 (970x600). Feature comparison style, not repeating main images.' },
    { id: 'aplus_03', phase: 'a_plus', idx: 10, width: 970, height: 600, goal: 'A+ image #3 (970x600). Folding process storytelling visual, not repeating main images.' },
    { id: 'aplus_04', phase: 'a_plus', idx: 11, width: 970, height: 600, goal: 'A+ image #4 (970x600). Material and mobility storytelling visual, not repeating main images.' },
  ];
}

function buildTaskPrompt(task, keywords, attempt, failureReasonCode = '') {
  const isAPlus = task.phase === 'a_plus';
  const indexInPhase = isAPlus ? (task.idx - 7) : task.idx;
  if (attempt > 1) {
    const duplicateRetry = failureReasonCode === 'visual_duplicate' || failureReasonCode === 'duplicate_image';
    if (duplicateRetry) {
      return isAPlus
        ? `The last A+ image #${indexInPhase} was a duplicate of an earlier result. Please regenerate A+ image #${indexInPhase} with a clearly different layout, scene, and text. Do not repeat any previous image.`
        : `The last main image #${indexInPhase} was a duplicate of an earlier result. Please regenerate main image #${indexInPhase} with a clearly different scene, composition, and text. Do not repeat any previous image.`;
    }
    return isAPlus
      ? `I cannot see the image. Please regenerate A+ image #${indexInPhase}.`
      : `I cannot see the image. Please regenerate main image #${indexInPhase}.`;
  }

  if (!isAPlus) {
    return `Continue generating main image #${indexInPhase}.`;
  }

  if (indexInPhase === 1) {
    return 'Main images are done. Continue with A+ image #1.';
  }

  return `Continue generating A+ image #${indexInPhase}.`;
}
function pickFromPool(pool, task, acceptedVisuals = []) {
  const candidates = pool
    .map((x, idx) => ({ idx, item: x }))
    .filter(({ item }) => isAcceptableResolution(task, item.width, item.height));
  if (!candidates.length) return null;

  const targetRatio = task.width / task.height;
  candidates.sort((a, b) => {
    const ratioA = (Number(a.item.width || 0) > 0 && Number(a.item.height || 0) > 0)
      ? (Number(a.item.width) / Number(a.item.height))
      : 0;
    const ratioB = (Number(b.item.width || 0) > 0 && Number(b.item.height || 0) > 0)
      ? (Number(b.item.width) / Number(b.item.height))
      : 0;
    const scoreA = Math.abs(ratioA - targetRatio) * 100000 - Number(a.item.area || 0);
    const scoreB = Math.abs(ratioB - targetRatio) * 100000 - Number(b.item.area || 0);
    return scoreA - scoreB;
  });

  for (const candidate of candidates) {
    const visualHash = ensureVisualHash(candidate.item);
    const dup = findVisualDuplicate(visualHash, acceptedVisuals);
    if (dup) {
      continue;
    }
    const idx = candidate.idx;
    if (idx >= 0) return pool.splice(idx, 1)[0];
  }
  return null;
}

(async () => {
  const args = parseArgs(process.argv);

  const fixedPromptFile = args['fixed-prompt-file'];
  const imagePathArg = args['image-path'];
  const imagePaths = Array.isArray(imagePathArg)
    ? imagePathArg
    : (imagePathArg ? [imagePathArg] : []);
  const keywordsRaw = args['keywords'] || '';
  const keywords = normalizeKeywords(keywordsRaw);

  const outputDir = args['output-dir'] || path.resolve(process.cwd(), 'output', `gemini_rpa_${nowTag()}`);
  const sessionDir = args['session-dir'] || path.resolve(process.cwd(), '.gemini_profile');

  const maxRetry = Math.max(1, Math.min(12, toInt(args['max-retry'], 5)));
  const retryWaitSec = Math.max(1, Math.min(300, toInt(args['retry-wait-sec'], 15)));
  const taskGapSec = Math.max(0, Math.min(120, toInt(args['task-gap-sec'], 3)));
  const genTimeoutSec = Math.max(30, Math.min(1200, toInt(args['gen-timeout-sec'], 240)));
  const uiDownloadRetries = Math.max(1, Math.min(8, toInt(args['ui-download-retries'], 3)));
  const requireUiDownload = toBool(args['require-ui-download'], true);
  const noImageTaskFailsBeforeRestart = Math.max(2, Math.min(5, toInt(args['no-image-task-fails-before-restart'], 2)));
  const maxFlowRestarts = Math.max(0, Math.min(5, toInt(args['max-flow-restarts'], 2)));
  const loginWaitSec = Math.max(30, Math.min(1800, toInt(args['login-wait-sec'], 600)));
  const proSwitchTimeoutSec = Math.max(10, Math.min(180, toInt(args['pro-switch-timeout-sec'], 60)));
  const idleNoBusyMs = Math.max(5000, Math.min(60000, toInt(args['idle-no-busy-ms'], 12000)));
  const postIdlePollSec = Math.max(8, Math.min(180, toInt(args['post-idle-poll-sec'], 24)));
  const viewportWidth = Math.max(1024, Math.min(3200, toInt(args['viewport-width'], 1480)));
  const viewportHeight = Math.max(680, Math.min(2200, toInt(args['viewport-height'], 960)));
  const pageZoom = Math.max(0.55, Math.min(1.0, Number(args['page-zoom'] ?? 0.8)));
  const strictProSwitch = toBool(args['strict-pro-switch'], false);
  const maxImagesPerMessage = Math.max(1, Math.min(10, toInt(args['max-images-per-message'], 10)));
  const keepOpenOnFailureSec = Math.max(0, Math.min(300, toInt(args['keep-open-on-failure-sec'], 30)));
  const ensureProAtStart = toBool(args['ensure-pro-at-start'], true);
  const attachEachTask = toBool(args['attach-each-task'], false);
  const stopAfterBootstrap = toBool(args['stop-after-bootstrap'], false);

  const headless = toBool(args['headless'], false);
  const openNewChat = toBool(args['open-new-chat'], true);

  const baseUrl = args['base-url'] || 'https://gemini.google.com/app?hl=en';
  const locale = args['locale'] || 'en-US';
  const browserChannel = args['browser-channel'] || 'chrome';
  const browserExecutablePath = args['browser-executable-path'] || resolveChromeExecutable();

  let fixedPrompt = '';

  const runId = nowTag();
  const summaryPath = path.join(outputDir, `summary_${runId}.json`);
  const debugDir = path.join(outputDir, 'debug');

  const tasks = buildTasks();
  const summary = {
    run_id: runId,
    started_at: new Date().toISOString(),
    config: {
      fixed_prompt_file: fixedPromptFile,
      image_path: imagePaths[0] || null,
      image_paths: imagePaths,
      image_count: imagePaths.length,
      keywords_raw_length: String(keywordsRaw || '').length,
      keywords_normalized_length: String(keywords || '').length,
      output_dir: outputDir,
      session_dir: sessionDir,
      max_retry: maxRetry,
      retry_wait_sec: retryWaitSec,
      task_gap_sec: taskGapSec,
      ui_download_retries: uiDownloadRetries,
      require_ui_download: requireUiDownload,
      no_image_task_fails_before_restart: noImageTaskFailsBeforeRestart,
      max_flow_restarts: maxFlowRestarts,
      generation_timeout_sec: genTimeoutSec,
      idle_no_busy_ms: idleNoBusyMs,
      post_idle_poll_sec: postIdlePollSec,
      login_wait_sec: loginWaitSec,
      pro_switch_timeout_sec: proSwitchTimeoutSec,
      viewport_width: viewportWidth,
      viewport_height: viewportHeight,
      page_zoom: pageZoom,
      strict_pro_switch: strictProSwitch,
      max_images_per_message: maxImagesPerMessage,
      keep_open_on_failure_sec: keepOpenOnFailureSec,
      ensure_pro_at_start: ensureProAtStart,
      attach_each_task: attachEachTask,
      stop_after_bootstrap: stopAfterBootstrap,
      headless,
      open_new_chat: openNewChat,
      base_url: baseUrl,
      browser_channel: browserChannel,
      browser_executable_path: browserExecutablePath || null,
    },
    ready_step: null,
    mode_step: null,
    bootstrap_step: null,
    tasks: [],
    failed_tasks: [],
    failed_task_ids: [],
    failed_reason_counts: {},
    flow_restarts: [],
    phase_summary: {
      main: { ok: 0, failed: 0 },
      a_plus: { ok: 0, failed: 0 },
    },
    failed_screenshots: [],
    debug_dir: debugDir,
    trace_file: null,
  };

  let context;
  let page = null;
  try {
    if (!fixedPromptFile || !fileExists(fixedPromptFile)) {
      throw new Error('Missing fixed prompt file. Use --fixed-prompt-file <path>.');
    }
    if (!imagePaths.length) {
      throw new Error('Missing product image file(s). Use --image-path <path> (can repeat).');
    }
    const missingImagePaths = imagePaths.filter((p) => !fileExists(p));
    if (missingImagePaths.length) {
      throw new Error(`Missing product image file(s): ${missingImagePaths.join(', ')}`);
    }
    if (!String(keywords).trim()) {
      throw new Error('Missing keywords. Use --keywords \"...\".');
    }

    ensureDir(outputDir);
    ensureDir(sessionDir);
    ensureDir(debugDir);
    activeTraceFile = path.join(debugDir, 'trace.jsonl');
    traceShotSeq = 0;
    fs.writeFileSync(activeTraceFile, '', 'utf8');
    summary.trace_file = activeTraceFile;

    fixedPrompt = readTextFile(fixedPromptFile).trim();
    if (!fixedPrompt) throw new Error('Fixed prompt file is empty.');

    log('launch_browser', { headless, sessionDir, browserChannel, browserExecutablePath: browserExecutablePath || null });
    const launchOpts = {
      headless,
      locale,
      viewport: { width: viewportWidth, height: viewportHeight },
      acceptDownloads: true,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US',
        `--window-size=${viewportWidth},${viewportHeight}`,
      ],
    };

    if (browserExecutablePath) {
      launchOpts.executablePath = browserExecutablePath;
    } else if (browserChannel) {
      launchOpts.channel = browserChannel;
    }

    context = await chromium.launchPersistentContext(sessionDir, launchOpts);

    page = context.pages()[0] || await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

    log('wait_for_login');
    await waitForComposer(page, loginWaitSec * 1000);
    await applyPageZoom(page, pageZoom);
    await dismissBlockingDialogs(page);

    if (openNewChat) {
      const clicked = await tryClickNewChat(page);
      log('new_chat', { clicked });
      await waitForComposer(page, 20000);
      await applyPageZoom(page, pageZoom);
      await dismissBlockingDialogs(page);
    }

    if (ensureProAtStart) {
      try {
        const modeRet = await ensureProMode(page, proSwitchTimeoutSec * 1000);
        summary.mode_step = {
          status: 'ok',
          completed_at: new Date().toISOString(),
          already_pro: Boolean(modeRet && modeRet.already),
        };
        log('ensure_pro_mode', summary.mode_step);
      } catch (modeErr) {
        const msg = String(modeErr && modeErr.message ? modeErr.message : modeErr);
        summary.mode_step = {
          status: strictProSwitch ? 'failed' : 'warning',
          completed_at: new Date().toISOString(),
          error: msg,
        };
        log('ensure_pro_mode_failed', { strict: strictProSwitch, error: msg });
        if (strictProSwitch) throw modeErr;
      }
    } else {
      summary.mode_step = {
        status: 'skipped',
        completed_at: new Date().toISOString(),
      };
      log('ensure_pro_mode_skipped');
    }

    await page.screenshot({ path: path.join(debugDir, '01_ready.png'), fullPage: true });
    await captureTraceShot(page, debugDir, 'ready');

    // Step 1: send fixed prompt unchanged
    log('send_fixed_prompt');
    const beforeFixedPromptCandidates = await collectImageCandidates(page);
    await fillComposer(page, fixedPrompt);
    await captureTraceShot(page, debugDir, 'fixed_prompt_typed');
    await sendMessage(page, { waitReadyMs: 90000, throwOnTimeout: true });
    const fixedPromptSettle = await waitForFixedPromptReplySettled(
      page,
      beforeFixedPromptCandidates,
      genTimeoutSec,
      idleNoBusyMs,
      { phase: 'fixed_prompt' }
    );
    await page.waitForTimeout(2000);

    const readyCandidates = await collectImageCandidates(page);
    summary.ready_step = {
      status: 'ok',
      completed_at: new Date().toISOString(),
      image_candidates_after_ready: readyCandidates.length,
      settle_status: fixedPromptSettle.status,
      generated_during_ready: fixedPromptSettle.newCandidates.length,
      needs_inputs_reply: fixedPromptSettle.needsInputsReply,
    };

    await page.screenshot({ path: path.join(debugDir, '02_after_ready.png'), fullPage: true });
    await captureTraceShot(page, debugDir, 'after_fixed_prompt_reply', { imageCandidates: readyCandidates.length });

    // Bootstrap step: upload reference images in chunks and keep them as one product reference set.
    const chunks = chunkArray(imagePaths, maxImagesPerMessage);
    log('bootstrap_send_product_images_in_chunks', {
      count: imagePaths.length,
      chunk_count: chunks.length,
      max_images_per_message: maxImagesPerMessage,
    });

    let globalImageIndex = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const isLastChunk = ci === chunks.length - 1;

      await waitForComposer(page, 20000);
      await dismissBlockingDialogs(page);

      for (let i = 0; i < chunk.length; i++) {
        globalImageIndex += 1;
        const onePath = chunk[i];
        const attached = await attachImage(page, onePath);
        if (!attached) {
          throw new Error(`Bootstrap step failed: cannot upload product image #${globalImageIndex}.`);
        }
        await captureTraceShot(page, debugDir, `bootstrap_image_${globalImageIndex}_attached`);
        await page.waitForTimeout(350);
      }

            const chunkStart = ci * maxImagesPerMessage + 1;
      const chunkEnd = chunkStart + chunk.length - 1;
      const bootstrapPrompt = isLastChunk
        ? `Product keywords: ${keywords}`
        : [
            `These are additional reference images #${chunkStart} to #${chunkEnd} for the same product.`,
            'Wait.',
          ].join(' ');
      await fillComposer(page, bootstrapPrompt);
      await captureTraceShot(page, debugDir, `bootstrap_chunk_${ci + 1}_typed`, { isLastChunk });
      if (isLastChunk) {
        const composerText = await readComposerText(page);
        if (!/product keywords:/i.test(composerText)) {
          throw new Error('Bootstrap keyword message was not typed into composer.');
        }
      }
      const beforeSubmitCandidates = await collectImageCandidates(page);
      const beforeSubmitTail = await getConversationTail(page);
      await sendMessage(page, { waitReadyMs: 90000, throwOnTimeout: true });
      const bootstrapSettle = await waitForReferenceSubmissionSettled(page, beforeSubmitCandidates, beforeSubmitTail, genTimeoutSec, idleNoBusyMs, {
        phase: 'bootstrap',
        chunk: ci + 1,
        isLastChunk,
      });
      await page.waitForTimeout(1200);
      await captureTraceShot(page, debugDir, `bootstrap_chunk_${ci + 1}_done`, {
        isLastChunk,
        settleStatus: bootstrapSettle.status,
        generatedDuringBootstrap: bootstrapSettle.newCandidates.length,
      });
    }

    summary.bootstrap_step = {
      status: 'ok',
      completed_at: new Date().toISOString(),
      note: `${imagePaths.length} product image(s) uploaded in ${chunks.length} chunk(s); keywords submitted at final chunk.`,
    };
    await page.screenshot({ path: path.join(debugDir, '03_after_bootstrap.png'), fullPage: true });

    if (stopAfterBootstrap) {
      summary.finished_at = new Date().toISOString();
      summary.generated_ok = 0;
      summary.expected_total = tasks.length;
      summary.failed_count = 0;
      summary.result = 'bootstrap_only';
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
      log('run_finished_bootstrap_only', { summaryPath });
      console.log(`SUMMARY_PATH=${summaryPath}`);
      console.log(`DEBUG_DIR=${debugDir}`);
      console.log(`FAILED_SCREENSHOTS=${JSON.stringify(summary.failed_screenshots)}`);
      console.log(`FAILED_REASON_COUNTS=${JSON.stringify(summary.failed_reason_counts)}`);
      console.log(`PHASE_SUMMARY=${JSON.stringify(summary.phase_summary)}`);
      console.log(`FAILED_TASK_IDS=${JSON.stringify(summary.failed_task_ids)}`);
      return;
    }

    const usedSignatures = new Set();
    const usedContentHashes = new Set();
    const acceptedVisuals = [];
    const referenceContentHashes = new Set();
    const referenceNameTokens = new Set(
      imagePaths
        .map((p) => normalizeNameToken(path.basename(p)))
        .filter((x) => x && x.length >= 5)
    );
    for (const p of imagePaths) {
      try {
        referenceContentHashes.add(sha1(fs.readFileSync(p)));
      } catch {
        // ignore bad reference hash
      }
    }
    const baselineCandidates = await collectImageCandidates(page);
    let knownCandidateKeys = new Set(baselineCandidates.map(candidateKey));
    const pool = [];
    let pendingBootstrapCandidates = baselineCandidates.slice();
    if (pendingBootstrapCandidates.length) {
      log('bootstrap_pending_candidates', {
        count: pendingBootstrapCandidates.length,
        indexes: pendingBootstrapCandidates.map((x) => x.domIndex),
      });
    }
    const bumpReason = (reasonCode) => {
      const key = reasonCode || 'unknown';
      summary.failed_reason_counts[key] = (summary.failed_reason_counts[key] || 0) + 1;
    };
    const bumpPhase = (phase, kind) => {
      if (!summary.phase_summary[phase]) summary.phase_summary[phase] = { ok: 0, failed: 0 };
      summary.phase_summary[phase][kind] = (summary.phase_summary[phase][kind] || 0) + 1;
    };
    const noImageReasonCodes = new Set(['no_new_image', 'ui_download_missing']);
    let consecutiveNoImageTaskFails = 0;
    let flowRestartCount = 0;

    const restartFromFixedPrompt = async (reason) => {
      if (flowRestartCount >= maxFlowRestarts) {
        log('flow_restart_skip', { reason, flowRestartCount, maxFlowRestarts });
        return false;
      }

      const restartIndex = flowRestartCount + 1;
      log('flow_restart_begin', { restartIndex, reason });
      try {
        try {
          if (page && !page.isClosed()) await page.close();
        } catch {
          // ignore close error
        }

        page = await context.newPage();
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await waitForComposer(page, loginWaitSec * 1000);
        await applyPageZoom(page, pageZoom);
        await dismissBlockingDialogs(page);

        if (openNewChat) {
          const clicked = await tryClickNewChat(page);
          log('flow_restart_new_chat', { restartIndex, clicked });
          await waitForComposer(page, 20000);
          await applyPageZoom(page, pageZoom);
          await dismissBlockingDialogs(page);
        }

        if (ensureProAtStart) {
          try {
            await ensureProMode(page, proSwitchTimeoutSec * 1000);
            log('flow_restart_pro_ok', { restartIndex });
          } catch (modeErr) {
            const msg = String(modeErr && modeErr.message ? modeErr.message : modeErr);
            log('flow_restart_pro_failed', { restartIndex, strict: strictProSwitch, error: msg });
            if (strictProSwitch) throw modeErr;
          }
        }

        await fillComposer(page, fixedPrompt);
        await sendMessage(page, { waitReadyMs: 90000, throwOnTimeout: true });
        await waitForGeminiIdle(page, genTimeoutSec * 1000, { minNoBusyMs: idleNoBusyMs, throwOnTimeout: true });
        await page.waitForTimeout(1200);

        let restartGlobalImageIndex = 0;
        const chunks = chunkArray(imagePaths, maxImagesPerMessage);
        for (let ci = 0; ci < chunks.length; ci++) {
          const chunk = chunks[ci];
          const isLastChunk = ci === chunks.length - 1;

          await waitForComposer(page, 20000);
          await dismissBlockingDialogs(page);

          for (let i = 0; i < chunk.length; i++) {
            restartGlobalImageIndex += 1;
            const onePath = chunk[i];
            const attached = await attachImage(page, onePath);
            if (!attached) {
              throw new Error(`Flow restart bootstrap failed: cannot upload product image #${restartGlobalImageIndex}.`);
            }
            await page.waitForTimeout(320);
          }

          const chunkStart = ci * maxImagesPerMessage + 1;
          const chunkEnd = chunkStart + chunk.length - 1;
          const bootstrapPrompt = isLastChunk
            ? `Product keywords: ${keywords}`
            : [
                `These are additional reference images #${chunkStart} to #${chunkEnd} for the same product.`,
                'Do not generate images yet.',
                'Reply with a short acknowledgement only.',
              ].join(' ');

          await fillComposer(page, bootstrapPrompt);
          if (isLastChunk) {
            const composerText = await readComposerText(page);
            if (!/product keywords:/i.test(composerText)) {
              throw new Error('Flow restart failed: bootstrap keyword message was not typed into composer.');
            }
          }
          const beforeRestartSubmitCandidates = await collectImageCandidates(page);
          const beforeRestartSubmitTail = await getConversationTail(page);
          await sendMessage(page, { waitReadyMs: 90000, throwOnTimeout: true });
          await waitForReferenceSubmissionSettled(page, beforeRestartSubmitCandidates, beforeRestartSubmitTail, genTimeoutSec, idleNoBusyMs, {
            phase: 'flow_restart_bootstrap',
            chunk: ci + 1,
            isLastChunk,
            restartIndex,
          });
          await page.waitForTimeout(1000);
        }

        const fresh = await collectImageCandidates(page);
        knownCandidateKeys = new Set(fresh.map(candidateKey));
        pendingBootstrapCandidates = fresh.slice();
        if (pendingBootstrapCandidates.length) {
          log('flow_restart_pending_candidates', {
            restartIndex,
            count: pendingBootstrapCandidates.length,
            indexes: pendingBootstrapCandidates.map((x) => x.domIndex),
          });
        }
        flowRestartCount += 1;
        summary.flow_restarts.push({
          index: flowRestartCount,
          reason,
          completed_at: new Date().toISOString(),
          baseline_candidates: fresh.length,
        });
        log('flow_restart_done', { restartIndex: flowRestartCount, baselineCandidates: fresh.length });
        return true;
      } catch (restartErr) {
        const errMsg = String(restartErr && restartErr.message ? restartErr.message : restartErr);
        summary.flow_restarts.push({
          index: restartIndex,
          reason,
          failed_at: new Date().toISOString(),
          error: errMsg,
        });
        log('flow_restart_failed', { restartIndex, reason, error: errMsg });
        return false;
      }
    };

    for (const task of tasks) {
      let recoveredInputsForTask = false;
      const item = {
        task_id: task.id,
        phase: task.phase,
        idx: task.idx,
        target_size: `${task.width}x${task.height}`,
        status: 'failed',
        attempts: 0,
        output_file: null,
        actual_size: null,
        source_method: null,
        failure_reason_code: null,
        error: null,
        debug_screenshots: [],
      };

      const fromPool = pickFromPool(pool, task, acceptedVisuals);
      if (fromPool) {
        const ext = extFromMime(fromPool.mime);
        const outName = `${String(task.idx).padStart(2, '0')}_${task.id}_${task.width}x${task.height}.${ext}`;
        const outPath = path.join(outputDir, outName);
        fs.writeFileSync(outPath, fromPool.buffer);
        const contentHash = fromPool.hash || sha1(fromPool.buffer);
        if (fromPool.signature) usedSignatures.add(fromPool.signature);
        usedContentHashes.add(contentHash);

        item.status = 'ok';
        item.attempts = 0;
        item.output_file = outPath;
        item.actual_size = `${fromPool.width || '?'}x${fromPool.height || '?'}`;
        item.source_method = `${fromPool.method || 'pool'}/pool`;
        item.failure_reason_code = null;
        const poolVisualHash = ensureVisualHash(fromPool, outPath);
        if (poolVisualHash) {
          acceptedVisuals.push({
            taskId: task.id,
            file: outPath,
            visualHash: poolVisualHash,
          });
        }

        summary.tasks.push(item);
        bumpPhase(task.phase, 'ok');
        log('task_use_pool', { task: task.id, output: outPath });
        continue;
      }

      for (let attempt = 1; attempt <= maxRetry; attempt++) {
        item.attempts = attempt;
        log('task_attempt', { task: task.id, attempt });
        await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_start`);

        await waitForComposer(page, 20000);
        await dismissBlockingDialogs(page);
        await waitForGeminiIdle(page, Math.min(genTimeoutSec * 1000, 120000), { minNoBusyMs: Math.min(15000, idleNoBusyMs), throwOnTimeout: false });

        const extracted = [];
        const extractedHashes = new Set();
        let newCandidates = [];
        let reusedBootstrapCandidates = false;
        let beforeSet = null;

        if (pendingBootstrapCandidates.length) {
          newCandidates = pendingBootstrapCandidates.slice();
          pendingBootstrapCandidates = [];
          reusedBootstrapCandidates = newCandidates.length > 0;
          if (reusedBootstrapCandidates) {
            log('task_use_bootstrap_candidates', {
              task: task.id,
              attempt,
              count: newCandidates.length,
              indexes: newCandidates.map((x) => x.domIndex),
            });
            await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_use_bootstrap_candidates`, {
              count: newCandidates.length,
            });
          }
        }

        const needAttach = attachEachTask && !reusedBootstrapCandidates;
        if (needAttach) {
          const attached = await attachImage(page, imagePaths[0]);
          if (!attached) {
            item.failure_reason_code = 'attach_failed';
            item.error = 'Unable to attach product image in Gemini UI.';
            await captureFailureShot(page, debugDir, task.id, attempt, 'attach_failed', item, summary.failed_screenshots);
            log('attach_failed', { task: task.id, attempt });
            if (attempt < maxRetry) await page.waitForTimeout(retryWaitSec * 1000);
            continue;
          }
        }

        if (!reusedBootstrapCandidates && !recoveredInputsForTask) {
          const inputReply = await detectModelNeedsInputsReply(page);
          const needsInputs = !!(inputReply.needsImages || inputReply.needsKeywords);
          if (needsInputs) {
            log('model_needs_inputs_detected', {
              task: task.id,
              attempt,
              needsImages: !!inputReply.needsImages,
              needsKeywords: !!inputReply.needsKeywords,
              preview: String(inputReply.latestReplyText || '').slice(0, 240),
            });
            await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_needs_inputs`);
            try {
              const recoverResult = await resendRequestedInputs(page, imagePaths, keywords, idleNoBusyMs, genTimeoutSec, {
                needImages: !!inputReply.needsImages,
                needKeywords: !!inputReply.needsKeywords,
              });
              const freshAfterRecover = await collectImageCandidates(page);
              knownCandidateKeys = new Set(freshAfterRecover.map(candidateKey));
              recoveredInputsForTask = true;
              log('model_needs_inputs_recovered', {
                task: task.id,
                attempt,
                baseline: freshAfterRecover.length,
                sentImages: recoverResult.sentImages,
                sentKeywords: recoverResult.sentKeywords,
              });
              await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_inputs_recovered`, { baseline: freshAfterRecover.length });
            } catch (recoverErr) {
              log('model_needs_inputs_recover_failed', { task: task.id, attempt, error: String(recoverErr && recoverErr.message ? recoverErr.message : recoverErr) });
              await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_inputs_recover_failed`);
            }
          }
        }

        if (!reusedBootstrapCandidates) {
          const beforeSend = await collectImageCandidates(page);
          beforeSet = new Set([...knownCandidateKeys, ...beforeSend.map(candidateKey)]);

          const prompt = buildTaskPrompt(task, keywords, attempt, item.failure_reason_code || '');
          await fillComposer(page, prompt);
          await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_prompt_typed`, { prompt });
          await sendMessage(page, { waitReadyMs: 90000, throwOnTimeout: true });
          await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_sent`);

          await waitForGeminiIdle(page, genTimeoutSec * 1000, { minNoBusyMs: idleNoBusyMs, throwOnTimeout: true });
          await page.waitForTimeout(1200);

          const pollCycles = Math.max(3, Math.min(90, Math.ceil(postIdlePollSec / 2)));
          for (let poll = 1; poll <= pollCycles; poll++) {
            const snap = await collectImageCandidates(page);
            newCandidates = snap.filter((c) => {
              const key = candidateKey(c);
              return !beforeSet.has(key) && !usedSignatures.has(key) && !knownCandidateKeys.has(key);
            });
            if (newCandidates.length) break;
            await page.waitForTimeout(2000);
          }
        }

        if (!newCandidates.length) {
          const directDownloadVisible = await hasVisibleGeminiDownloadButton(page);
          if (directDownloadVisible) {
            log('download_button_visible_without_candidate_skip', { task: task.id, attempt });
            await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_download_button_visible_without_candidate_skip`);
            const refreshed = await reloadCurrentConversationPage(page, `${task.id}_attempt_${attempt}_pending_image_frame`);
            if (refreshed) {
              await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_after_page_refresh`);
              if (!reusedBootstrapCandidates && beforeSet) {
                const snapAfterRefresh = await collectImageCandidates(page);
                newCandidates = snapAfterRefresh.filter((c) => {
                  const key = candidateKey(c);
                  return !beforeSet.has(key) && !usedSignatures.has(key) && !knownCandidateKeys.has(key);
                });
                if (newCandidates.length) {
                  log('new_candidates_detected_after_refresh', {
                    task: task.id,
                    attempt,
                    count: newCandidates.length,
                    indexes: newCandidates.map((x) => x.domIndex),
                  });
                }
              }
            }
          }
        }

        if (!newCandidates.length && !extracted.length) {
          const tempBusy = await detectTemporaryBusyReply(page);
          item.failure_reason_code = tempBusy ? 'model_busy' : 'no_new_image';
          item.error = tempBusy
            ? 'Gemini returned temporary busy/rate-limit response; will retry this image.'
            : 'No new generated image detected in this attempt.';
          await captureFailureShot(page, debugDir, task.id, attempt, item.failure_reason_code, item, summary.failed_screenshots);
          log(item.failure_reason_code, { task: task.id, attempt, tempBusy });
          await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_${item.failure_reason_code}`);
          if (attempt < maxRetry) await page.waitForTimeout(retryWaitSec * 1000);
          continue;
        }

        if (newCandidates.length && !extracted.length) {
          newCandidates.sort((a, b) => (b.domIndex || 0) - (a.domIndex || 0));
          log('new_candidates_detected', {
            task: task.id,
            attempt,
            count: newCandidates.length,
            indexes: newCandidates.map((x) => x.domIndex),
          });
          await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_new_candidates`, { count: newCandidates.length });
          for (const cand of newCandidates) {
            knownCandidateKeys.add(candidateKey(cand));
          }

          // Download-first: strictly target only current new generated nodes.
          // If Gemini returns a batch in one reply, download the whole batch and
          // leave the extras in pool for the following tasks.
          for (let dlTry = 1; dlTry <= uiDownloadRetries; dlTry++) {
            log('ui_download_try_start', { task: task.id, attempt, dlTry, candidateCount: newCandidates.length });
            await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_download_try_${dlTry}_before`);
            let batchAdded = 0;
            for (let candidateIdx = 0; candidateIdx < newCandidates.length; candidateIdx++) {
              const preferredCandidate = newCandidates[candidateIdx];
              const uiDownloaded = await tryDownloadFromGeminiUi(
                page,
                debugDir,
                task,
                `${attempt}_${dlTry}_${candidateIdx + 1}`,
                [preferredCandidate]
              );
              if (!(uiDownloaded && uiDownloaded.ok && uiDownloaded.buffer)) continue;

              const byRefName = looksLikeReferenceFileName(uiDownloaded.suggested_filename, referenceNameTokens);
              if (byRefName) {
                log('ui_download_reference_skip', {
                  task: task.id,
                  attempt,
                  dlTry,
                  candidateIdx,
                  suggested: uiDownloaded.suggested_filename || '',
                });
                continue;
              }

              if (!isAcceptableResolution(task, uiDownloaded.width, uiDownloaded.height)) {
                log('ui_download_resolution_skip', {
                  task: task.id,
                  attempt,
                  dlTry,
                  candidateIdx,
                  width: uiDownloaded.width,
                  height: uiDownloaded.height,
                  expected: `${task.width}x${task.height}`,
                });
                continue;
              }

              const hash = sha1(uiDownloaded.buffer);
              if (extractedHashes.has(hash)) {
                log('ui_download_duplicate_skip', {
                  task: task.id,
                  attempt,
                  dlTry,
                  candidateIdx,
                  hash,
                });
                continue;
              }

              extractedHashes.add(hash);
              extracted.push({
                signature: `ui-download|${task.id}|a${attempt}|d${dlTry}|c${candidateIdx + 1}|${hash}`,
                mime: uiDownloaded.mime,
                buffer: uiDownloaded.buffer,
                width: uiDownloaded.width,
                height: uiDownloaded.height,
                method: `${uiDownloaded.method || 'ui-download'}/try${dlTry}/candidate${candidateIdx + 1}`,
                tempPath: uiDownloaded.tempPath || '',
                area: (uiDownloaded.width || 0) * (uiDownloaded.height || 0),
                hash,
              });
              batchAdded += 1;
              log('ui_download_try_done', {
                task: task.id,
                attempt,
                dlTry,
                candidateIdx,
                method: uiDownloaded.method || 'ui-download',
                suggested: uiDownloaded.suggested_filename || '',
                width: uiDownloaded.width,
                height: uiDownloaded.height,
              });
              await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_download_try_${dlTry}_candidate_${candidateIdx + 1}_success`);
              await page.waitForTimeout(180);
            }

            if (batchAdded > 0) {
              log('ui_download_batch_done', {
                task: task.id,
                attempt,
                dlTry,
                downloadedCount: batchAdded,
                extractedCount: extracted.length,
              });
              break;
            }
            log('ui_download_try_miss', { task: task.id, attempt, dlTry });
            await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_download_try_${dlTry}_miss`);
            if (dlTry < uiDownloadRetries) await page.waitForTimeout(1200);
          }

          // Optional fallback only when strict UI-download mode is disabled.
          if (!extracted.length && !requireUiDownload) {
            for (let i = 0; i < newCandidates.length; i++) {
              const cand = newCandidates[i];
              const key = candidateKey(cand);
              const one = await fetchCandidateData(page, cand);
              if (one.ok) {
                const hash = sha1(one.buffer);
                extracted.push({
                  signature: key,
                  mime: one.mime,
                  buffer: one.buffer,
                  width: one.width,
                  height: one.height,
                  method: one.method,
                  tempPath: '',
                  area: (one.width || 0) * (one.height || 0),
                  hash,
                });
              }
            }
          }
        }

        if (!extracted.length) {
          item.failure_reason_code = requireUiDownload ? 'ui_download_missing' : 'extract_failed';
          item.error = requireUiDownload
            ? 'Generated image detected, but Gemini download button did not return a downloadable file.'
            : 'Detected images but failed to extract bytes.';
          await captureFailureShot(page, debugDir, task.id, attempt, 'extract_failed', item, summary.failed_screenshots);
          log('extract_failed', { task: task.id, attempt });
          if (attempt < maxRetry) await page.waitForTimeout(retryWaitSec * 1000);
          continue;
        }

        const downloadedFirst = requireUiDownload
          ? extracted.filter((x) => /ui-download/i.test(String(x.method || '')))
          : extracted;
        if (!downloadedFirst.length) {
          item.failure_reason_code = 'ui_download_missing';
          item.error = 'Only non-download capture results found; strict mode requires Gemini download action.';
          await captureFailureShot(page, debugDir, task.id, attempt, 'ui_download_missing', item, summary.failed_screenshots);
          log('ui_download_missing', { task: task.id, attempt });
          if (attempt < maxRetry) await page.waitForTimeout(retryWaitSec * 1000);
          continue;
        }

        const generatedOnly = downloadedFirst.filter((x) => !referenceContentHashes.has(x.hash));
        if (!generatedOnly.length) {
          item.failure_reason_code = 'reference_image_selected';
          item.error = 'Only reference product images were captured; no generated image detected.';
          await captureFailureShot(page, debugDir, task.id, attempt, 'reference_image_selected', item, summary.failed_screenshots);
          log('reference_image_selected', { task: task.id, attempt });
          if (attempt < maxRetry) await page.waitForTimeout(retryWaitSec * 1000);
          continue;
        }

        const ranked = generatedOnly
          .slice()
          .sort((a, b) => {
            const exactA = (a.width === task.width && a.height === task.height) ? 1 : 0;
            const exactB = (b.width === task.width && b.height === task.height) ? 1 : 0;
            if (exactA !== exactB) return exactB - exactA;
            return (b.area || 0) - (a.area || 0);
          });
        let chosen = null;
        for (const candidate of ranked) {
          const visualHash = ensureVisualHash(candidate);
          const dup = findVisualDuplicate(visualHash, acceptedVisuals);
          if (dup) {
            log('visual_duplicate_candidate_skip', {
              task: task.id,
              attempt,
              method: candidate.method || '',
              againstTask: dup.taskId,
              distance: dup.distance,
            });
            continue;
          }
          chosen = candidate;
          break;
        }
        if (!chosen) {
          item.failure_reason_code = 'visual_duplicate';
          item.error = 'All generated candidates are visually too similar to previous accepted outputs.';
          await captureFailureShot(page, debugDir, task.id, attempt, 'visual_duplicate', item, summary.failed_screenshots);
          log('visual_duplicate', { task: task.id, attempt, extracted_count: extracted.length });
          if (attempt < maxRetry) await page.waitForTimeout(retryWaitSec * 1000);
          continue;
        }

        const ext = extFromMime(chosen.mime);
        const outName = `${String(task.idx).padStart(2, '0')}_${task.id}_${task.width}x${task.height}.${ext}`;
        const outPath = path.join(outputDir, outName);
        const contentHash = chosen.hash || sha1(chosen.buffer);
        if (usedContentHashes.has(contentHash)) {
          item.failure_reason_code = 'duplicate_image';
          item.error = 'Captured image duplicates a previous task result.';
          await captureFailureShot(page, debugDir, task.id, attempt, 'duplicate_image', item, summary.failed_screenshots);
          log('duplicate_image', { task: task.id, attempt });
          if (attempt < maxRetry) await page.waitForTimeout(retryWaitSec * 1000);
          continue;
        }

        if (!isAcceptableResolution(task, chosen.width, chosen.height)) {
          item.failure_reason_code = 'resolution_mismatch';
          item.error = `Captured image size is too small or wrong ratio: ${chosen.width || '?'}x${chosen.height || '?'}.`;
          await captureFailureShot(page, debugDir, task.id, attempt, 'resolution_mismatch', item, summary.failed_screenshots);
          log('resolution_mismatch', {
            task: task.id,
            attempt,
            width: chosen.width,
            height: chosen.height,
            method: chosen.method,
          });
          if (attempt < maxRetry) await page.waitForTimeout(retryWaitSec * 1000);
          continue;
        }

        fs.writeFileSync(outPath, chosen.buffer);
        const chosenVisualHash = ensureVisualHash(chosen, outPath);
        const rest = extracted.filter((x) => x !== chosen);
        const visualCompareBase = chosenVisualHash
          ? acceptedVisuals.concat([{ taskId: task.id, file: outPath, visualHash: chosenVisualHash }])
          : acceptedVisuals;
        for (const r of rest) {
          const restVisualHash = ensureVisualHash(r);
          const dup = findVisualDuplicate(restVisualHash, visualCompareBase);
          if (dup) {
            log('visual_duplicate_pool_skip', {
              task: task.id,
              attempt,
              method: r.method || '',
              againstTask: dup.taskId,
              distance: dup.distance,
            });
            continue;
          }
          pool.push(r);
        }

        usedSignatures.add(chosen.signature);
        usedContentHashes.add(contentHash);
        if (chosenVisualHash) {
          acceptedVisuals.push({
            taskId: task.id,
            file: outPath,
            visualHash: chosenVisualHash,
          });
        }

        item.status = 'ok';
        item.output_file = outPath;
        item.actual_size = `${chosen.width || '?'}x${chosen.height || '?'}`;
        item.source_method = chosen.method || 'unknown';
        item.failure_reason_code = null;
        item.error = null;

        log('task_done', {
          task: task.id,
          attempt,
          output: outPath,
          actual_size: item.actual_size,
          pool_size: pool.length,
        });
        await captureTraceShot(page, debugDir, `${task.id}_attempt_${attempt}_task_done`, { output: outPath });

        await page.screenshot({ path: path.join(debugDir, `task_${String(task.idx).padStart(2, '0')}.png`), fullPage: true });
        break;
      }

      if (item.status !== 'ok') {
        const reasonCode = item.failure_reason_code || 'unknown';
        summary.failed_tasks.push({
          task_id: task.id,
          phase: task.phase,
          reason_code: reasonCode,
          error: item.error || 'unknown',
          screenshot_paths: item.debug_screenshots,
        });
        summary.failed_task_ids.push(task.id);
        bumpReason(reasonCode);
        bumpPhase(task.phase, 'failed');

        if (noImageReasonCodes.has(reasonCode)) {
          consecutiveNoImageTaskFails += 1;
          log('no_image_task_fail_streak', {
            task: task.id,
            reasonCode,
            streak: consecutiveNoImageTaskFails,
            threshold: noImageTaskFailsBeforeRestart,
          });

          if (consecutiveNoImageTaskFails >= noImageTaskFailsBeforeRestart) {
            const restarted = await restartFromFixedPrompt(
              `consecutive_no_image_tasks_${consecutiveNoImageTaskFails}`
            );
            if (restarted) {
              consecutiveNoImageTaskFails = 0;
            }
          }
        } else {
          consecutiveNoImageTaskFails = 0;
        }
      } else {
        bumpPhase(task.phase, 'ok');
        consecutiveNoImageTaskFails = 0;
      }

      summary.tasks.push(item);
      await page.waitForTimeout(taskGapSec * 1000);
    }

    summary.finished_at = new Date().toISOString();
    summary.generated_ok = summary.tasks.filter((x) => x.status === 'ok').length;
    summary.expected_total = tasks.length;
    summary.failed_count = summary.failed_tasks.length;
    summary.result = summary.failed_tasks.length ? 'partial' : 'success';

    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    log('run_finished', { summaryPath, result: summary.result, generated_ok: summary.generated_ok });

    console.log(`SUMMARY_PATH=${summaryPath}`);
    console.log(`DEBUG_DIR=${debugDir}`);
    console.log(`FAILED_SCREENSHOTS=${JSON.stringify(summary.failed_screenshots)}`);
    console.log(`FAILED_REASON_COUNTS=${JSON.stringify(summary.failed_reason_counts)}`);
    console.log(`PHASE_SUMMARY=${JSON.stringify(summary.phase_summary)}`);
    console.log(`FAILED_TASK_IDS=${JSON.stringify(summary.failed_task_ids)}`);

    if (summary.failed_tasks.length) process.exitCode = 2;
  } catch (err) {
    summary.finished_at = new Date().toISOString();
    summary.result = 'failed';
    summary.fatal_error = err.message;
    try { ensureDir(outputDir); ensureDir(debugDir); } catch {}
    if (page) {
      try {
        const fatalShot = path.join(debugDir, `fatal_${safeSlug(nowTag())}.png`);
        await page.screenshot({ path: fatalShot, fullPage: true });
        summary.failed_screenshots.push(fatalShot);
      } catch {}
    }
    try { fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8'); } catch {}
    log('run_failed', { error: err.message, summaryPath });
    console.log(`SUMMARY_PATH=${summaryPath}`);
    console.log(`DEBUG_DIR=${debugDir}`);
    console.log(`FAILED_SCREENSHOTS=${JSON.stringify(summary.failed_screenshots)}`);
    console.log(`FAILED_REASON_COUNTS=${JSON.stringify(summary.failed_reason_counts || {})}`);
    console.log(`PHASE_SUMMARY=${JSON.stringify(summary.phase_summary || {})}`);
    console.log(`FAILED_TASK_IDS=${JSON.stringify(summary.failed_task_ids || [])}`);
    console.error(err.stack || String(err));
    process.exitCode = 1;
  } finally {
    if (context) {
      if (!headless && process.exitCode === 1 && keepOpenOnFailureSec > 0) {
        log('keep_browser_open_before_close', { seconds: keepOpenOnFailureSec });
        try {
          await page.waitForTimeout(keepOpenOnFailureSec * 1000);
        } catch {
          // ignore
        }
      }
      try { await context.close(); } catch {}
    }
  }
})();


