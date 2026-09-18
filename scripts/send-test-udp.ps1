param(
    [int]$Port = 5300,
    [int]$Count = 120,
    [int]$Hz = 60
)

$client = [System.Net.Sockets.UdpClient]::new()
$endpoint = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, $Port)
$delayMs = [Math]::Max(1, [Math]::Round(1000 / [Math]::Max(1, $Hz)))

Write-Host "Sending $Count test UDP packets to 127.0.0.1:$Port at ~${Hz}Hz..."

try {
    for ($i = 1; $i -le $Count; $i++) {
        $message = "RACELAB_TEST|seq=$i|utc=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($message)
        [void]$client.Send($bytes, $bytes.Length, $endpoint)
        Start-Sleep -Milliseconds $delayMs
    }
}
finally {
    $client.Dispose()
}

Write-Host "Done. RaceLab should show traffic and a hex preview."
