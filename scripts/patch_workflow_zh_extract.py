import json

p = r"E:\codex\n8n_gemini_workflows\gemini_web_rpa_7plus4_workflow_zh.json"
with open(p, 'r', encoding='utf-8') as f:
    d = json.load(f)

node = next(x for x in d['nodes'] if x['name'] == '提取执行结果')
js = node['parameters']['jsCode']
old = '    ok: exitCode === 0,'
new = '    ok: exitCode === 0 || exitCode === 2,\n    status: exitCode === 0 ? "success" : (exitCode === 2 ? "partial" : "failed"),'
if old in js:
    js = js.replace(old, new, 1)
node['parameters']['jsCode'] = js

with open(p, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(d, f, ensure_ascii=True, indent=2)

print('PATCHED', p)
