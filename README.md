# QYL Gemini Web RPA Suite

这套项目主要用于你的本地 Gemini 网页生图工作流，包含：

- `scripts/gemini_web_rpa_worker.js`：Gemini 网页 RPA 主流程
- `scripts/gemini_lan_server.js`：本地局域网页面服务
- `web/lan_portal/index.html`：QYL 图片生成功能网页
- `n8n_gemini_workflows/`：n8n 工作流导出文件
- `qyl-amazon-japan-calculator/`：亚马逊日本定价计算器源码

## 新电脑最简使用

### 1. 安装基础环境

- Windows
- Node.js 20 或更新版本

### 2. 下载代码

直接下载这个仓库的 `main` 分支即可。

### 3. 一键初始化并启动

在项目根目录打开 PowerShell，运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

这个脚本会自动完成：

- 检查 Node.js
- 安装项目依赖
- 安装 Playwright Chromium
- 创建运行目录
- 启动本地服务
- 打开 QYL 图片生成功能网页

启动后默认访问：

```text
http://127.0.0.1:8787
```

## 第一次使用要做的事

- 第一次打开后，需要在 Gemini 网页里手动登录一次你的账号
- 登录成功后，后续会复用本地会话目录 `.gemini_profile_live`

## n8n

如果你要在新电脑继续用 n8n：

- 先安装 n8n
- 再导入 `n8n_gemini_workflows/` 里的工作流 JSON

## 说明

- 这套主流程是网页 RPA，不依赖 Gemini API Key
- `.env.example` 里的 GPT / MiniMax 变量是仓库里其他辅助脚本使用，不是这套 Gemini 网页工作流的必需项
