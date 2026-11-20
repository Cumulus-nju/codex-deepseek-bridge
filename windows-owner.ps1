param([Parameter(Mandatory = $true)][string]$LaunchFile)
$ErrorActionPreference = 'Stop'
$launch = Get-Content -Raw -LiteralPath $LaunchFile | ConvertFrom-Json
$process = [System.Diagnostics.Process]::new()
$stdoutFile = $null
$stderrFile = $null
$outcome = @{ exit_code = $null; reason = $null }
try {
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $launch.node
    $info.WorkingDirectory = $launch.cwd
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $info.Environment['DSH_HOME'] = $launch.dshHome
    $info.Environment['DSH_PERMISSION_MODE'] = 'workspace-write'
    foreach ($argument in $launch.args) { $info.ArgumentList.Add([string]$argument) }
    $process.StartInfo = $info
    $stdoutFile = [System.IO.File]::Open($launch.stdout, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $stderrFile = [System.IO.File]::Open($launch.stderr, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    if (-not $process.Start()) { throw 'Unable to start DeepSeek process' }
    # Hold the original OS process handle. Never reopen a stored PID to terminate it.
    $heldProcessHandle = $process.Handle
    $copyOut = $process.StandardOutput.BaseStream.CopyToAsync($stdoutFile)
    $copyErr = $process.StandardError.BaseStream.CopyToAsync($stderrFile)
    if ($launch.stdin) { $process.StandardInput.Write([string]$launch.stdin) }
    $process.StandardInput.Close()
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $process.WaitForExit(100)) {
        if ([System.IO.File]::Exists($launch.cancelFile)) { $outcome.reason = 'cancelled' }
        elseif ($watch.Elapsed.TotalSeconds -ge $launch.timeoutSeconds) { $outcome.reason = 'timed_out' }
        if ($outcome.reason) {
            # This Process instance owns the live child; .NET kills its descendants too.
            if (-not $process.HasExited) { $process.Kill($true) }
            $process.WaitForExit()
            break
        }
    }
    $outcome.exit_code = $process.ExitCode
    if (-not [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($copyOut, $copyErr), 5000)) {
        throw 'Log streams did not close; a detached descendant may remain. Inspect workspace before another stage.'
    }
}
catch {
    $outcome.error = $_.Exception.Message
    $outcome.reason = 'failed'
    try { if ($process.Id -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() } } catch { }
}
finally {
    if ($stdoutFile) { $stdoutFile.Dispose() }
    if ($stderrFile) { $stderrFile.Dispose() }
    $process.Dispose()
    $outcome | ConvertTo-Json -Compress | Set-Content -LiteralPath $launch.outcomeFile -Encoding utf8
}
