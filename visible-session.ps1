param([Parameter(Mandatory=$true)][string]$LaunchFile)
$ErrorActionPreference = 'Stop'
$launch = Get-Content -Raw -LiteralPath $LaunchFile | ConvertFrom-Json
$Host.UI.RawUI.WindowTitle = 'Codex + DeepSeek | ' + $launch.jobId.Substring(0,8)
$env:DSH_HOME = $launch.dshHome
$env:DSH_PERMISSION_MODE = 'workspace-write'
$env:DSH_BRIDGE_JOB_DIR = Split-Path -Parent $LaunchFile
$env:DSH_BRIDGE_DSH_BIN = $launch.dshBin
Remove-Item Env:DSH_TUI_RESUME_SESSION -ErrorAction SilentlyContinue
Remove-Item Env:DSH_CC_RESUME_SESSION -ErrorAction SilentlyContinue
Remove-Item Env:DSH_TUI_WORKSPACE_TARGET -ErrorAction SilentlyContinue
Set-Location -LiteralPath $launch.cwd
Start-Transcript -LiteralPath (Join-Path $env:DSH_BRIDGE_JOB_DIR 'console.log') -Append | Out-Null
Write-Host 'Codex + DeepSeek collaboration window' -ForegroundColor Cyan
Write-Host ('Stage: ' + $launch.jobId)
Write-Host 'You can watch the task, tools and replies here. Codex will review the result.'
try {
    $profileName = if ($launch.profile) { $launch.profile } else { 'codex-collab' }
    & $launch.node $launch.dshBin --profile $profileName
    $resultCode = $LASTEXITCODE
} catch {
    $_ | Out-String | Add-Content -LiteralPath (Join-Path $env:DSH_BRIDGE_JOB_DIR 'stderr.log')
    $resultCode = 1
    Write-Host $_ -ForegroundColor Red
}
$outcomeFile = Join-Path $env:DSH_BRIDGE_JOB_DIR 'process-outcome.json'
if (-not (Test-Path -LiteralPath $outcomeFile)) {
    @{ exit_code = 1; reason = 'failed'; error = ('Visible TUI exited before stage outcome; code ' + $resultCode) } | ConvertTo-Json -Compress | Set-Content -LiteralPath $outcomeFile -Encoding utf8
}
Write-Host 'The TUI process has ended. This window remains open for inspection.' -ForegroundColor Yellow
Stop-Transcript | Out-Null
