#!/usr/bin/env node

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GEMINI_WORKER_PATH = path.join(ROOT, 'scripts', 'gemini_web_rpa_worker.js');
const GPT_WORKER_PATH = path.join(ROOT, 'scripts', 'chatgpt_web_chat_worker.js');
const DEFAULT_PROMPT_PATH = path.join(ROOT, 'prompts', 'fixed_prompt_for_gemini_web_rpa.txt');
const DEFAULT_GEMINI_SESSION_DIR = path.join(ROOT, '.gemini_profile_live');
const DEFAULT_GPT_SESSION_DIR = path.join(ROOT, '.chatgpt_profile_live');

const JOB_ROOT = path.join(ROOT, 'output', 'lan_portal_jobs');
const UPLOAD_ROOT = path.join(ROOT, 'output', 'lan_portal_uploads');
const PUBLIC_DIR = path.join(ROOT, 'web', 'lan_portal');
const CALC_HTML_CANDIDATES = [
  path.join(ROOT, 'QYL_amazon_japan_calculator.html'),
  path.join(ROOT, 'qyl-amazon-japan-calculator', 'QYL_amazon_japan_calculator.html'),
];
const CALC_HTML_PATH = CALC_HTML_CANDIDATES.find((p) => fs.existsSync(p)) || '';

const PORT = Number(process.env.PORT || 8788);
const PASSCODE = String(process.env.PORTAL_PASSCODE || '').trim();
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const MAX_UPLOAD_FILES = Math.min(10, Number(process.env.MAX_UPLOAD_FILES || 10));
const JOB_RETENTION_DAYS = Math.max(1, Number(process.env.JOB_RETENTION_DAYS || 3));
const JOB_RETENTION_MS = JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const JOB_CLEANUP_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.JOB_CLEANUP_INTERVAL_MS || 30 * 60 * 1000));
const JOB_INDEX_PATH = path.join(JOB_ROOT, 'jobs_index.json');

const WORKER_DEFAULTS = {
  maxRetry: Number(process.env.JOB_MAX_RETRY || 3),
  retryWaitSec: Number(process.env.JOB_RETRY_WAIT_SEC || 12),
  taskGapSec: Number(process.env.JOB_TASK_GAP_SEC || 4),
  genTimeoutSec: Number(process.env.JOB_GEN_TIMEOUT_SEC || 240),
  loginWaitSec: Number(process.env.JOB_LOGIN_WAIT_SEC || 600),
  idleNoBusyMs: Number(process.env.JOB_IDLE_NO_BUSY_MS || 12000),
  postIdlePollSec: Number(process.env.JOB_POST_IDLE_POLL_SEC || 24),
  requireUiDownload: String(process.env.JOB_REQUIRE_UI_DOWNLOAD || 'true'),
  viewportWidth: Number(process.env.JOB_VIEWPORT_WIDTH || 1700),
  viewportHeight: Number(process.env.JOB_VIEWPORT_HEIGHT || 1050),
  pageZoom: Number(process.env.JOB_PAGE_ZOOM || 1.0),
  headless: 'false',
  openNewChat: 'true',
  attachEachTask: 'false',
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function nowTag() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jobId() {
  return `job_${nowTag()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getLanIps() {
  const out = [];
  const n = os.networkInterfaces();
  for (const key of Object.keys(n)) {
    for (const one of n[key] || []) {
      if (one.family === 'IPv4' && !one.internal) out.push(one.address);
    }
  }
  return Array.from(new Set(out));
}

function safeFileName(name) {
  const base = String(name || 'file').replace(/[^\w.\-]/g, '_');
  return base.length ? base : 'file';
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function parseTimeMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function isWithinPath(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  return target === base || target.startsWith(base + path.sep);
}

function removePathSafe(targetPath, baseDir, recursive = false) {
  if (!targetPath) return;
  if (!isWithinPath(baseDir, targetPath)) return;
  try {
    fs.rmSync(targetPath, { recursive, force: true });
  } catch {
    // ignore cleanup errors
  }
}

function listOutputImages(outputDir) {
  if (!fs.existsSync(outputDir)) return [];
  const names = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((n) => /\.(png|jpg|jpeg|webp)$/i.test(n))
    .sort();
  return names.map((n) => {
    const full = path.join(outputDir, n);
    const st = fs.statSync(full);
    return { name: n, size: st.size, updated_at: st.mtime.toISOString() };
  });
}


function escapePsSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

function buildJobZip(job) {
  const files = listOutputImages(job.output_dir);
  if (!files.length) {
    throw new Error('No output images to package.');
  }

  const zipPath = path.join(job.output_dir, `${job.id}_all.zip`);
  let latestImageMtime = 0;
  const absoluteFiles = files.map((f) => {
    const full = path.join(job.output_dir, f.name);
    try {
      const m = fs.statSync(full).mtimeMs;
      if (m > latestImageMtime) latestImageMtime = m;
    } catch {
      // ignore
    }
    return full;
  });

  if (fs.existsSync(zipPath)) {
    try {
      const zipMtime = fs.statSync(zipPath).mtimeMs;
      if (zipMtime >= latestImageMtime) return zipPath;
    } catch {
      // recreate below
    }
  }

  const literalPaths = absoluteFiles.map((p) => `'${escapePsSingleQuoted(p)}'`).join(', ');
  const cmd = `Compress-Archive -LiteralPath @(${literalPaths}) -DestinationPath '${escapePsSingleQuoted(zipPath)}' -Force`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    windowsHide: true,
    stdio: 'pipe',
  });

  if (!fs.existsSync(zipPath)) {
    throw new Error('Failed to create zip package.');
  }
  return zipPath;
}

ensureDir(JOB_ROOT);
ensureDir(UPLOAD_ROOT);
ensureDir(PUBLIC_DIR);

if (!fs.existsSync(GEMINI_WORKER_PATH)) {
  console.error(`Worker script not found: ${GEMINI_WORKER_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(GPT_WORKER_PATH)) {
  console.error(`Worker script not found: ${GPT_WORKER_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(DEFAULT_PROMPT_PATH)) {
  console.error(`Fixed prompt file not found: ${DEFAULT_PROMPT_PATH}`);
  process.exit(1);
}
if (!CALC_HTML_PATH) {
  console.warn('Calculator HTML not found; /calculator route will be disabled.');
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_UPLOAD_FILES },
});

const jobs = new Map();
const queue = [];
let runningJobId = null;

function serializeJobForIndex(job) {
  return {
    id: job.id,
    provider: job.provider || 'gemini',
    status: job.status,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    requester: job.requester,
    keywords: job.keywords,
    image_name: job.image_name,
    image_names: Array.isArray(job.image_names) ? job.image_names : [],
    image_paths: Array.isArray(job.image_paths) ? job.image_paths : [],
    output_dir: job.output_dir,
    summary_path: job.summary_path || '',
    summary_result: job.summary_result || '',
    result_text: job.result_text || '',
    error: job.error || '',
    last_event: job.last_event || '',
  };
}

function saveJobsIndex() {
  const payload = {
    version: 1,
    saved_at: new Date().toISOString(),
    retention_days: JOB_RETENTION_DAYS,
    jobs: Array.from(jobs.values())
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(serializeJobForIndex),
  };
  const tempPath = `${JOB_INDEX_PATH}.tmp`;
  const content = JSON.stringify(payload, null, 2);
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, JOB_INDEX_PATH);
    return;
  } catch (err) {
    // Keep server running even when index file is temporarily locked by another process.
    try {
      fs.writeFileSync(JOB_INDEX_PATH, content, 'utf8');
      return;
    } catch (fallbackErr) {
      const msg = String((fallbackErr && fallbackErr.message) || (err && err.message) || fallbackErr || err);
      console.warn(`[warn] saveJobsIndex failed: ${msg}`);
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}

function normalizeStoredJob(raw) {
  if (!raw || !raw.id) return null;
  const outputDir = raw.output_dir ? String(raw.output_dir) : path.join(JOB_ROOT, String(raw.id));
  const imageNames = Array.isArray(raw.image_names) ? raw.image_names : [];
  const imagePaths = Array.isArray(raw.image_paths) ? raw.image_paths : [];
  const startedAt = raw.started_at || null;
  let status = raw.status || 'failed';
  let error = raw.error || '';
  let finishedAt = raw.finished_at || null;

  if (status === 'running' || status === 'queued') {
    status = 'failed';
    if (!error) error = 'Server restarted before this task completed. Please retry.';
    if (!finishedAt) finishedAt = new Date().toISOString();
  }

  return {
    id: String(raw.id),
    provider: raw.provider || 'gemini',
    status,
    created_at: raw.created_at || new Date().toISOString(),
    started_at: startedAt,
    finished_at: finishedAt,
    requester: raw.requester || 'guest',
    keywords: raw.keywords || '',
    image_name: raw.image_name || imageNames[0] || '',
    image_names: imageNames,
    image_paths: imagePaths,
    output_dir: outputDir,
    summary_path: raw.summary_path || '',
    summary_result: raw.summary_result || '',
    result_text: raw.result_text || '',
    result_images: listOutputImages(outputDir),
    queue_index: 0,
    last_event: raw.last_event || '',
    error,
    logs: [],
    pid: null,
  };
}

function loadJobsIndex() {
  if (!fs.existsSync(JOB_INDEX_PATH)) return 0;
  const data = readJsonSafe(JOB_INDEX_PATH);
  const list = Array.isArray(data) ? data : (Array.isArray(data && data.jobs) ? data.jobs : []);
  let loaded = 0;
  for (const raw of list) {
    const normalized = normalizeStoredJob(raw);
    if (!normalized) continue;
    jobs.set(normalized.id, normalized);
    loaded += 1;
  }
  return loaded;
}

function removeJobArtifacts(job) {
  if (!job) return;
  for (const imagePath of (job.image_paths || [])) {
    removePathSafe(imagePath, UPLOAD_ROOT, false);
  }
  removePathSafe(job.output_dir, JOB_ROOT, true);
}

function cleanupExpiredJobs() {
  const now = Date.now();
  const expiredIds = [];

  for (const [id, job] of jobs.entries()) {
    if (id === runningJobId) continue;
    const createdAtMs = parseTimeMs(job.created_at);
    if (!createdAtMs) continue;
    if ((now - createdAtMs) > JOB_RETENTION_MS) {
      expiredIds.push(id);
    }
  }

  if (!expiredIds.length) return 0;

  for (const id of expiredIds) {
    const job = jobs.get(id);
    if (!job) continue;
    removeJobArtifacts(job);
    jobs.delete(id);
    let idx = queue.indexOf(id);
    while (idx >= 0) {
      queue.splice(idx, 1);
      idx = queue.indexOf(id);
    }
  }

  refreshQueueIndex();
  saveJobsIndex();
  return expiredIds.length;
}

function pushLog(job, text) {
  if (!text) return;
  const line = `[${new Date().toISOString()}] ${text}`;
  job.logs.push(line);
  if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
}

function compactJob(job) {
  return {
    id: job.id,
    provider: job.provider || 'gemini',
    status: job.status,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    requester: job.requester,
    keywords: job.keywords,
    image_name: job.image_name,
    image_count: Array.isArray(job.image_paths) ? job.image_paths.length : 0,
    image_names: job.image_names || [],
    queue_index: job.queue_index,
    summary_result: job.summary_result || '',
    result_text: job.result_text || '',
    result_images: job.result_images,
    error: job.error,
  };
}

function createJobFromFiles({ files, requester, keywords, provider }) {
  const id = jobId();
  const outputDir = path.join(JOB_ROOT, id);
  ensureDir(outputDir);

  const imagePaths = [];
  const imageNames = [];
  (files || []).forEach((file, idx) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const imageName = safeFileName(`input_${id}_${String(idx + 1).padStart(2, '0')}${ext}`);
    const imagePath = path.join(UPLOAD_ROOT, imageName);
    fs.writeFileSync(imagePath, file.buffer);
    imagePaths.push(imagePath);
    imageNames.push(file.originalname || imageName);
  });

  return {
    id,
    provider: provider || 'gemini',
    status: 'queued',
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    requester: requester || 'guest',
    keywords,
    image_name: imageNames[0] || '',
    image_names: imageNames,
    image_paths: imagePaths,
    output_dir: outputDir,
    summary_path: '',
    summary_result: '',
    result_text: '',
    result_images: [],
    queue_index: queue.length + 1,
    last_event: 'queued',
    error: '',
    logs: [],
    pid: null,
  };
}

function createJobFromExistingJob(sourceJob, { requester, keywords } = {}) {
  const sourcePaths = Array.isArray(sourceJob.image_paths) ? sourceJob.image_paths : [];
  const sourceNames = Array.isArray(sourceJob.image_names) ? sourceJob.image_names : [];
  const provider = sourceJob.provider || 'gemini';
  if (!sourcePaths.length && provider !== 'gpt') {
    throw new Error('Source job has no reference images.');
  }

  const files = sourcePaths.map((src, idx) => {
    if (!fs.existsSync(src)) {
      throw new Error(`Missing source image file: ${src}`);
    }
    return {
      originalname: sourceNames[idx] || path.basename(src),
      buffer: fs.readFileSync(src),
    };
  });

  return createJobFromFiles({
    files,
    requester: requester || sourceJob.requester || 'guest',
    keywords: (keywords && String(keywords).trim()) || sourceJob.keywords || '',
    provider,
  });
}

function refreshQueueIndex() {
  queue.forEach((id, idx) => {
    const j = jobs.get(id);
    if (j) j.queue_index = idx + 1;
  });
}

function parseLineAsJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function runJob(job) {
  job.status = 'running';
  job.started_at = new Date().toISOString();
  job.queue_index = 0;
  pushLog(job, 'Job started.');
  saveJobsIndex();

  let args = [];
  if ((job.provider || 'gemini') === 'gpt') {
    args = [
      GPT_WORKER_PATH,
      '--prompt', job.keywords,
      '--output-dir', job.output_dir,
      '--session-dir', DEFAULT_GPT_SESSION_DIR,
      '--login-wait-sec', String(WORKER_DEFAULTS.loginWaitSec),
      '--gen-timeout-sec', String(WORKER_DEFAULTS.genTimeoutSec),
      '--idle-no-busy-ms', String(WORKER_DEFAULTS.idleNoBusyMs),
      '--viewport-width', String(WORKER_DEFAULTS.viewportWidth),
      '--viewport-height', String(WORKER_DEFAULTS.viewportHeight),
      '--page-zoom', String(WORKER_DEFAULTS.pageZoom),
      '--headless', WORKER_DEFAULTS.headless,
      '--open-new-chat', WORKER_DEFAULTS.openNewChat,
    ];
  } else {
    args = [
      GEMINI_WORKER_PATH,
      '--fixed-prompt-file', DEFAULT_PROMPT_PATH,
      '--keywords', job.keywords,
      '--output-dir', job.output_dir,
      '--session-dir', DEFAULT_GEMINI_SESSION_DIR,
      '--max-retry', String(WORKER_DEFAULTS.maxRetry),
      '--retry-wait-sec', String(WORKER_DEFAULTS.retryWaitSec),
      '--task-gap-sec', String(WORKER_DEFAULTS.taskGapSec),
      '--gen-timeout-sec', String(WORKER_DEFAULTS.genTimeoutSec),
      '--login-wait-sec', String(WORKER_DEFAULTS.loginWaitSec),
      '--idle-no-busy-ms', String(WORKER_DEFAULTS.idleNoBusyMs),
      '--post-idle-poll-sec', String(WORKER_DEFAULTS.postIdlePollSec),
      '--require-ui-download', String(WORKER_DEFAULTS.requireUiDownload),
      '--viewport-width', String(WORKER_DEFAULTS.viewportWidth),
      '--viewport-height', String(WORKER_DEFAULTS.viewportHeight),
      '--page-zoom', String(WORKER_DEFAULTS.pageZoom),
      '--strict-new-chat', 'true',
      '--stop-after-bootstrap', 'false',
      '--max-images-per-message', '10',
      '--headless', WORKER_DEFAULTS.headless,
      '--open-new-chat', WORKER_DEFAULTS.openNewChat,
      '--attach-each-task', WORKER_DEFAULTS.attachEachTask,
    ];
  }
  for (const p of (job.image_paths || [])) {
    args.push('--image-path', p);
  }

  pushLog(job, `Spawn: node ${args.map((x) => JSON.stringify(x)).join(' ')}`);
  const child = spawn('node', args, {
    cwd: ROOT,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.pid = child.pid;

  let summaryPathFromStdout = '';

  const onLine = (raw, streamName) => {
    const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      pushLog(job, `${streamName}: ${line}`);
      if (line.startsWith('SUMMARY_PATH=')) {
        summaryPathFromStdout = line.slice('SUMMARY_PATH='.length).trim();
      }
      const parsed = parseLineAsJson(line);
      if (parsed && parsed.event) {
        job.last_event = parsed.event;
      }
    }
  };

  child.stdout.on('data', (d) => onLine(d, 'stdout'));
  child.stderr.on('data', (d) => onLine(d, 'stderr'));

  const code = await new Promise((resolve) => {
    child.on('close', resolve);
  });

  let summaryPath = summaryPathFromStdout;
  if (!summaryPath) {
    const maybe = fs.readdirSync(job.output_dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /^summary_.*\.json$/i.test(d.name))
      .map((d) => path.join(job.output_dir, d.name))
      .sort()
      .pop();
    if (maybe) summaryPath = maybe;
  }
  job.summary_path = summaryPath || '';

  const summary = summaryPath ? readJsonSafe(summaryPath) : null;
  if (summary) {
    job.summary_result = summary.result || '';
    job.result_text = String(summary.reply_text || summary.result_text || '').trim();
    if (summary.fatal_error) {
      job.error = summary.fatal_error;
    }
  }

  job.result_images = listOutputImages(job.output_dir);

  if (code === 0 && (job.result_images.length > 0 || job.result_text)) {
    job.status = 'success';
  } else if (code === 2 && (job.result_images.length > 0 || job.result_text)) {
    job.status = 'partial';
  } else {
    job.status = 'failed';
  }

  if (code !== 0 && code !== 2 && !job.error) {
    job.error = `Worker exited with code ${code}`;
  }
  if (job.result_images.length === 0 && !job.result_text && !job.error) {
    job.error = 'No output result found in job output directory.';
  }

  job.finished_at = new Date().toISOString();
  pushLog(job, `Job finished. status=${job.status} code=${code}`);
  saveJobsIndex();
}

async function processQueue() {
  if (runningJobId) return;
  const next = queue.shift();
  refreshQueueIndex();
  saveJobsIndex();
  if (!next) return;

  const job = jobs.get(next);
  if (!job) return processQueue();

  runningJobId = job.id;
  try {
    await runJob(job);
  } catch (err) {
    job.status = 'failed';
    job.error = String(err && err.message ? err.message : err);
    job.finished_at = new Date().toISOString();
    pushLog(job, `Fatal: ${job.error}`);
    saveJobsIndex();
  } finally {
    runningJobId = null;
    processQueue();
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    server_time: new Date().toISOString(),
    running_job_id: runningJobId,
    queued_jobs: queue.length,
  });
});

app.get('/api/config', (_req, res) => {
  const lanUrls = getLanIps().map((ip) => `http://${ip}:${PORT}`);
  res.json({
    passcode_required: Boolean(PASSCODE),
    max_upload_mb: MAX_UPLOAD_MB,
    max_upload_files: MAX_UPLOAD_FILES,
    retention_days: JOB_RETENTION_DAYS,
    concurrency_limit: 1,
    calculator_enabled: Boolean(CALC_HTML_PATH),
    lan_urls: lanUrls,
    defaults: {
      gemini_session_dir: DEFAULT_GEMINI_SESSION_DIR,
      gpt_session_dir: DEFAULT_GPT_SESSION_DIR,
      fixed_prompt_file: DEFAULT_PROMPT_PATH,
    },
    providers: [
      { id: 'gemini', label: 'Gemini 图片生成' },
      { id: 'gpt', label: 'GPT 网页对话' },
    ],
  });
});

app.post('/api/jobs', upload.any(), (req, res) => {
  try {
    if (PASSCODE) {
      const provided = String(req.body.passcode || '').trim();
      if (provided !== PASSCODE) {
        return res.status(401).json({ error: 'Passcode is invalid.' });
      }
    }

    const provider = String(req.body.provider || 'gemini').trim().toLowerCase();
    if (!['gemini', 'gpt'].includes(provider)) {
      return res.status(400).json({ error: 'provider is invalid.' });
    }

    const keywords = String(req.body.keywords || '').trim();
    const requester = String(req.body.requester || '').trim();
    if (!keywords) return res.status(400).json({ error: 'keywords is required.' });

    const incomingFiles = (req.files || [])
      .filter((f) => ['product_image', 'product_images'].includes(f.fieldname));
    if (provider === 'gemini' && !incomingFiles.length) {
      return res.status(400).json({ error: 'At least one product image is required.' });
    }

    const job = createJobFromFiles({
      files: incomingFiles,
      requester,
      keywords,
      provider,
    });
    jobs.set(job.id, job);
    queue.push(job.id);

    refreshQueueIndex();
    saveJobsIndex();
    processQueue();

    return res.status(201).json({
      ok: true,
      created_count: 1,
      job: compactJob(job),
      jobs: [compactJob(job)],
    });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

app.post('/api/jobs/:id/retry', (req, res) => {
  try {
    if (PASSCODE) {
      const provided = String((req.body && req.body.passcode) || '').trim();
      if (provided !== PASSCODE) {
        return res.status(401).json({ error: 'Passcode is invalid.' });
      }
    }

    const source = jobs.get(req.params.id);
    if (!source) return res.status(404).json({ error: 'source job not found' });

    const requester = String((req.body && req.body.requester) || '').trim();
    const keywords = String((req.body && req.body.keywords) || '').trim();
    const job = createJobFromExistingJob(source, { requester, keywords });

    jobs.set(job.id, job);
    queue.push(job.id);
    refreshQueueIndex();
    saveJobsIndex();
    processQueue();

    return res.status(201).json({
      ok: true,
      source_job_id: source.id,
      created_count: 1,
      job: compactJob(job),
      jobs: [compactJob(job)],
    });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

app.get('/api/jobs', (_req, res) => {
  const list = Array.from(jobs.values())
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(compactJob);
  res.json({
    running_job_id: runningJobId,
    queued_jobs: queue.length,
    jobs: list,
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(compactJob(job));
});

app.get('/api/jobs/:id/files/:fileName', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const fileName = path.basename(req.params.fileName || '');
  const full = path.resolve(job.output_dir, fileName);
  const safeBase = path.resolve(job.output_dir);
  if (!full.startsWith(safeBase + path.sep) && full !== safeBase) {
    return res.status(400).json({ error: 'invalid path' });
  }
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'file not found' });
  return res.sendFile(full);
});

app.get('/api/jobs/:id/download-all', (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });

    const zipPath = buildJobZip(job);
    const downloadName = `${job.id}_images.zip`;
    return res.download(zipPath, downloadName);
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

app.get('/calculator', (_req, res) => {
  if (!CALC_HTML_PATH) {
    return res.status(404).send('Calculator page not found on this machine.');
  }
  return res.sendFile(CALC_HTML_PATH);
});

const loadedJobsCount = loadJobsIndex();
const cleanedAtBoot = cleanupExpiredJobs();
refreshQueueIndex();
saveJobsIndex();

setInterval(() => {
  const removed = cleanupExpiredJobs();
  if (removed > 0) {
    console.log(`[cleanup] Removed ${removed} expired jobs (retention=${JOB_RETENTION_DAYS} days).`);
  }
}, JOB_CLEANUP_INTERVAL_MS);

app.listen(PORT, '0.0.0.0', () => {
  const lanUrls = getLanIps().map((ip) => `http://${ip}:${PORT}`);
  console.log(`LAN Gemini portal running on: http://127.0.0.1:${PORT}`);
  console.log(`Job retention: ${JOB_RETENTION_DAYS} days`);
  console.log(`Loaded job history: ${loadedJobsCount}, cleaned on boot: ${cleanedAtBoot}`);
  for (const u of lanUrls) {
    console.log(`LAN URL: ${u}`);
  }
  if (PASSCODE) {
    console.log('Passcode protection enabled via PORTAL_PASSCODE.');
  } else {
    console.log('Passcode protection disabled. Set PORTAL_PASSCODE to enable.');
  }
});
