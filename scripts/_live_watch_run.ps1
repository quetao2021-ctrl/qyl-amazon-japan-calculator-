$ErrorActionPreference='Stop'
Set-Location 'E:\codex'
$argList = @(
  'scripts/gemini_web_rpa_worker.js',
  '--fixed-prompt-file','E:\codex\prompts\fixed_prompt_for_gemini_web_rpa.txt',
  '--image-path','E:\codex\output\lan_portal_uploads\input_job_20260421_155603_4kxf0_02.jpeg',
  '--image-path','E:\codex\output\lan_portal_uploads\input_job_20260421_155603_4kxf0_03.jpeg',
  '--image-path','E:\codex\output\lan_portal_uploads\input_job_20260421_155603_4kxf0_05.jpeg',
  '--keywords','台湾茶具，茶具',
  '--output-dir','E:\codex\output\live_watch_20260421_2',
  '--session-dir','E:\codex\.gemini_profile_live',
  '--max-retry','2',
  '--retry-wait-sec','12',
  '--task-gap-sec','3',
  '--gen-timeout-sec','240',
  '--login-wait-sec','600',
  '--attach-each-task','false',
  '--headless','false',
  '--open-new-chat','true',
  '--keep-open-after-run-sec','7200'
)
node @argList
