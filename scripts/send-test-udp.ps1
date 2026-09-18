param(
    [ValidateRange(1, 65535)][int]$Port = 5300,
    [ValidateRange(1, 10000000)][int]$Count = 1000,
    [ValidateRange(1, 10000)][int]$Hz = 60,
    [ValidateRange(64, 65507)][int]$PayloadBytes = 128,
    [string]$DiagnosticPath = ""
)

$ErrorActionPreference = "Stop"
$client = [System.Net.Sockets.UdpClient]::new()
$endpoint = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, $Port)
$sendAudit = [System.Collections.Generic.List[string]]::new()
$sent = 0
$failed = 0
$attempted = 0
$sentBytes = 0L
$failureMessage = $null
Write-Host "Sending $Count UDP packets ($PayloadBytes bytes each) to 127.0.0.1:$Port at ${Hz} Hz..."
$startTicks = [System.Diagnostics.Stopwatch]::GetTimestamp()
$timer = [System.Diagnostics.Stopwatch]::StartNew()

try {
    for ($i = 1; $i -le $Count; $i++) {
        # Absolute monotonic deadlines avoid accumulating send/sleep overhead.
        $deadlineMs = ($i - 1) * 1000.0 / $Hz
        while (($remainingMs = $deadlineMs - $timer.Elapsed.TotalMilliseconds) -gt 0) {
            if ($remainingMs -gt 2) {
                [System.Threading.Thread]::Sleep([int][Math]::Max(1, [Math]::Floor($remainingMs - 1)))
            }
            else {
                [System.Threading.Thread]::SpinWait(100)
            }
        }
        $message = "RACELAB_TEST|seq=$i|utc=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($message.PadRight($PayloadBytes, '.'))
        $written = 0
        $success = $false
        $sendError = ""
        $attempted++
        $beforeTicks = [System.Diagnostics.Stopwatch]::GetTimestamp()
        try {
            $written = $client.Send($bytes, $bytes.Length, $endpoint)
            if ($written -ne $PayloadBytes) { throw "Incomplete UDP send: $written bytes" }
            $success = $true
            $sent++
            $sentBytes += $written
        }
        catch {
            $failed++
            $sendError = $_.Exception.Message.Replace("`t", " ").Replace("`r", " ").Replace("`n", " ")
            throw
        }
        finally {
            $afterTicks = [System.Diagnostics.Stopwatch]::GetTimestamp()
            # Audit in memory; write only after sending so disk I/O cannot stall a send.
            if ($DiagnosticPath) {
                $sendAudit.Add("$i`t$beforeTicks`t$afterTicks`t$written`t$success`t$sendError")
            }
        }
    }
}
catch {
    $failureMessage = $_.Exception.Message
}
finally {
    $endTicks = [System.Diagnostics.Stopwatch]::GetTimestamp()
    $timer.Stop()
    $client.Dispose()
    if ($DiagnosticPath) {
        $auditLines = [System.Collections.Generic.List[string]]::new()
        $auditLines.Add("seq`tbefore_ticks`tafter_ticks`tbytes`tsuccess`terror")
        $auditLines.AddRange($sendAudit)
        [System.IO.File]::WriteAllLines($DiagnosticPath, $auditLines, [System.Text.UTF8Encoding]::new($false))
    }
}

[PSCustomObject]@{
    sent_packets = $sent
    failed_packets = $failed
    attempted_packets = $attempted
    sent_bytes = $sentBytes
    requested_hz = $Hz
    monotonic_start_ticks = $startTicks
    monotonic_end_ticks = $endTicks
    monotonic_frequency = [System.Diagnostics.Stopwatch]::Frequency
    elapsed_seconds = [Math]::Round($timer.Elapsed.TotalSeconds, 6)
    achieved_hz = if ($sent -gt 1) { [Math]::Round(($sent - 1) / $timer.Elapsed.TotalSeconds, 2) } else { 0 }
    error = $failureMessage
} | ConvertTo-Json -Compress
if ($failureMessage) { Write-Error $failureMessage; exit 1 }
