$procs = Get-CimInstance Win32_Process | Where-Object {
  ($_.CommandLine -like '*_live_watch_run.ps1*') -or ($_.CommandLine -like '*gemini_web_rpa_worker.js*')
}
foreach($p in $procs){
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
}
Write-Output ('killed=' + ($procs | Measure-Object).Count)
