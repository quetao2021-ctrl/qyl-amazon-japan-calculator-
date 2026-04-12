import json

p = r"E:\codex\n8n_gemini_workflows\gemini_web_rpa_7plus4_workflow_zh.json"
with open(p, 'r', encoding='utf-8') as f:
    d = json.load(f)

node = next(x for x in d['nodes'] if x['name'] == '提取执行结果')
node['parameters']['jsCode'] = r'''
const stdout = $json.stdout || '';
const stderr = $json.stderr || '';
const exitCode = $json.exitCode;

const readLine = (prefix) => {
  const m = stdout.match(new RegExp(prefix + '=(.+)'));
  return m ? m[1].trim() : null;
};

const parseJsonLine = (line, fallback) => {
  if (!line) return fallback;
  try {
    return JSON.parse(line);
  } catch {
    return fallback;
  }
};

const summaryPath = readLine('SUMMARY_PATH');
const debugDir = readLine('DEBUG_DIR');

const failedLine = readLine('FAILED_SCREENSHOTS');
const reasonLine = readLine('FAILED_REASON_COUNTS');
const phaseLine = readLine('PHASE_SUMMARY');
const failedTaskIdsLine = readLine('FAILED_TASK_IDS');

let failedScreenshots = [];
if (failedLine) {
  try {
    const parsed = JSON.parse(failedLine);
    if (Array.isArray(parsed)) failedScreenshots = parsed;
  } catch {
    failedScreenshots = failedLine.split('|').map(s => s.trim()).filter(Boolean);
  }
}

const failedReasonCounts = parseJsonLine(reasonLine, {});
const phaseSummary = parseJsonLine(phaseLine, {});
const failedTaskIds = parseJsonLine(failedTaskIdsLine, []);

return [{
  json: {
    ok: exitCode === 0 || exitCode === 2,
    status: exitCode === 0 ? 'success' : (exitCode === 2 ? 'partial' : 'failed'),
    exit_code: exitCode,
    summary_path: summaryPath,
    debug_dir: debugDir,
    failed_screenshot_paths: failedScreenshots,
    failed_reason_counts: failedReasonCounts,
    phase_summary: phaseSummary,
    failed_task_ids: Array.isArray(failedTaskIds) ? failedTaskIds : [],
    stdout,
    stderr,
    note: summaryPath
      ? '执行完成，可打开 summary_path 查看11个任务详情。'
      : '未解析到 SUMMARY_PATH，请检查 stdout/stderr。'
  }
}];
'''

with open(p, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(d, f, ensure_ascii=True, indent=2)

print('PATCHED', p)
