import json

wf_path = r"E:\codex\n8n_gemini_workflows\gemini_web_rpa_7plus4_workflow_zh.json"

build_command_code = r'''
const pick = (...keys) => {
  for (const k of keys) {
    const v = $json[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
};

const q = (v) => `"${String(v ?? '').replace(/"/g, '\\"')}"`;

const fixedPromptFile = pick('固定提示词文件路径', 'fixed_prompt_file_path');
const imagePath = pick('产品图本地路径', 'product_image_path');
const keywords = pick('亚马逊关键词', 'amazon_keywords');

const outputDir = pick('输出目录', 'output_dir') || 'E:\\codex\\output\\gemini_rpa';
const sessionDir = pick('浏览器会话目录', 'session_dir') || 'E:\\codex\\.gemini_profile';

const maxRetry = pick('最大重试次数', 'max_retry') || 5;
const retryWait = pick('重试等待秒数', 'retry_wait_sec') || 15;
const taskGap = pick('任务间隔秒数', 'task_gap_sec') || 3;
const genTimeout = pick('每次生成超时秒数', 'gen_timeout_sec') || 240;
const loginWait = pick('登录等待秒数', 'login_wait_sec') || 600;
const headless = String(pick('无头模式(true/false)', 'headless') || 'false');
const openNewChat = String(pick('每次先开新对话(true/false)', 'open_new_chat') || 'true');

if (!fixedPromptFile || !imagePath || !keywords) {
  throw new Error('必填项缺失：固定提示词文件路径 / 产品图本地路径 / 亚马逊关键词');
}

const scriptPath = 'E:\\codex\\scripts\\gemini_web_rpa_worker.js';

const command = [
  'node', q(scriptPath),
  '--fixed-prompt-file', q(fixedPromptFile),
  '--image-path', q(imagePath),
  '--keywords', q(keywords),
  '--output-dir', q(outputDir),
  '--session-dir', q(sessionDir),
  '--max-retry', q(maxRetry),
  '--retry-wait-sec', q(retryWait),
  '--task-gap-sec', q(taskGap),
  '--gen-timeout-sec', q(genTimeout),
  '--login-wait-sec', q(loginWait),
  '--headless', q(headless),
  '--open-new-chat', q(openNewChat)
].join(' ');

return [{ json: { ...$json, command, script_path: scriptPath } }];
'''

extract_result_code = r'''
const stdout = $json.stdout || '';
const stderr = $json.stderr || '';
const exitCode = $json.exitCode;

const readLine = (prefix) => {
  const m = stdout.match(new RegExp(prefix + '=(.+)'));
  return m ? m[1].trim() : null;
};

const summaryPath = readLine('SUMMARY_PATH');
const debugDir = readLine('DEBUG_DIR');
const failedLine = readLine('FAILED_SCREENSHOTS');

let failedScreenshots = [];
if (failedLine) {
  try {
    const parsed = JSON.parse(failedLine);
    if (Array.isArray(parsed)) failedScreenshots = parsed;
  } catch {
    failedScreenshots = failedLine.split('|').map(s => s.trim()).filter(Boolean);
  }
}

return [{
  json: {
    ok: exitCode === 0,
    exit_code: exitCode,
    summary_path: summaryPath,
    debug_dir: debugDir,
    failed_screenshot_paths: failedScreenshots,
    stdout,
    stderr,
    note: summaryPath
      ? '执行完成，可打开 summary_path 查看11个任务详情。'
      : '未解析到 SUMMARY_PATH，请检查 stdout/stderr。'
  }
}];
'''

wf = {
  "name": "Gemini 网页RPA作图（7主图+4A+）",
  "nodes": [
    {
      "parameters": {
        "formTitle": "Gemini 网页RPA作图（无API）",
        "formDescription": "先在浏览器登录Gemini，再提交任务。",
        "formFields": {
          "values": [
            {"fieldLabel": "固定提示词文件路径", "fieldType": "text", "placeholder": "E:\\codex\\prompts\\fixed_prompt.txt", "requiredField": True},
            {"fieldLabel": "产品图本地路径", "fieldType": "text", "placeholder": "C:\\Users\\30588\\Downloads\\61zljhREOxL._AC_SX679_.jpg", "requiredField": True},
            {"fieldLabel": "亚马逊关键词", "fieldType": "textarea", "requiredField": True},
            {"fieldLabel": "输出目录", "fieldType": "text", "placeholder": "E:\\codex\\output\\gemini_rpa", "requiredField": False},
            {"fieldLabel": "浏览器会话目录", "fieldType": "text", "placeholder": "E:\\codex\\.gemini_profile", "requiredField": False},
            {"fieldLabel": "最大重试次数", "fieldType": "number", "placeholder": "5", "requiredField": False},
            {"fieldLabel": "重试等待秒数", "fieldType": "number", "placeholder": "15", "requiredField": False},
            {"fieldLabel": "任务间隔秒数", "fieldType": "number", "placeholder": "3", "requiredField": False},
            {"fieldLabel": "每次生成超时秒数", "fieldType": "number", "placeholder": "240", "requiredField": False},
            {"fieldLabel": "登录等待秒数", "fieldType": "number", "placeholder": "600", "requiredField": False},
            {"fieldLabel": "无头模式(true/false)", "fieldType": "text", "placeholder": "false", "requiredField": False},
            {"fieldLabel": "每次先开新对话(true/false)", "fieldType": "text", "placeholder": "true", "requiredField": False},
          ]
        },
        "options": {}
      },
      "id": "29314f30-2c2a-4e1d-a669-d3b7ee169e66",
      "name": "表单触发",
      "type": "n8n-nodes-base.formTrigger",
      "position": [-760, 320],
      "webhookId": "16ecf8f9-5e36-4e64-bf31-b42db05c9bd7",
      "typeVersion": 2.3
    },
    {
      "parameters": {"jsCode": build_command_code},
      "id": "5f4a0f98-3e6d-40f1-9b4f-6e318f0d0702",
      "name": "组装执行命令",
      "type": "n8n-nodes-base.code",
      "position": [-430, 320],
      "typeVersion": 2
    },
    {
      "parameters": {"command": "={{$json.command}}"},
      "id": "0fd47294-8f9f-4ce1-b8c4-98ef8a777f1e",
      "name": "执行RPA脚本",
      "type": "n8n-nodes-base.executeCommand",
      "position": [-120, 320],
      "typeVersion": 1
    },
    {
      "parameters": {"jsCode": extract_result_code},
      "id": "3fed9e97-c029-4f90-8d0a-d89227df4fd5",
      "name": "提取执行结果",
      "type": "n8n-nodes-base.code",
      "position": [180, 320],
      "typeVersion": 2
    }
  ],
  "pinData": {},
  "connections": {
    "表单触发": {"main": [[{"node": "组装执行命令", "type": "main", "index": 0}]]},
    "组装执行命令": {"main": [[{"node": "执行RPA脚本", "type": "main", "index": 0}]]},
    "执行RPA脚本": {"main": [[{"node": "提取执行结果", "type": "main", "index": 0}]]}
  },
  "active": False,
  "settings": {"executionOrder": "v1"},
  "versionId": "92f73315-43bd-4914-b5d6-47a7bf2d7ac9",
  "tags": []
}

with open(wf_path, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(wf, f, ensure_ascii=True, indent=2)

print('WROTE', wf_path)
