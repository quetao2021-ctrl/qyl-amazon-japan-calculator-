$ErrorActionPreference='Stop'
$fixedPrompt = 'E:\codex\prompts\fixed_prompt_for_gemini_web_rpa.txt'
$productImage = 'C:\Users\30588\Downloads\61zljhREOxL._AC_SX679_.jpg'
$keywords = '折叠拉杆箱 foldable trolley storage box, collapsible rolling box, japanese amazon'
$outputDir = 'E:\codex\output\gemini_rpa_live8'
$sessionDir = 'E:\codex\.gemini_profile_live'

node E:\codex\scripts\gemini_web_rpa_worker.js `
  --fixed-prompt-file "$fixedPrompt" `
  --image-path "$productImage" `
  --keywords "$keywords" `
  --output-dir "$outputDir" `
  --session-dir "$sessionDir" `
  --max-retry 3 `
  --retry-wait-sec 20 `
  --task-gap-sec 4 `
  --gen-timeout-sec 420 `
  --login-wait-sec 600 `
  --attach-each-task false `
  --headless false `
  --open-new-chat true