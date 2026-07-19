# start-ibkr-gateway.ps1 — startet den IBKR Client Portal Gateway.
#
# Danach im Browser https://localhost:5000 öffnen und mit den PAPER-Zugangsdaten
# (Benutzer beginnt mit "du…") einloggen, bis "Client login succeeds" erscheint.
#
# Die IBKR-Session läuft täglich ab — dann dieses Skript erneut ausführen und neu
# einloggen. Das ist eine IBKR-Vorgabe, nicht umgehbar.

$dir = "C:\ibkr-gateway"

if (-not (Test-Path "$dir\dist")) {
  Write-Error "Gateway nicht gefunden unter $dir — erst herunterladen/entpacken."
  exit 1
}

# Läuft es schon?
$listening = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Output "Gateway läuft bereits auf Port 5000 (PID $($listening[0].OwningProcess))."
  Write-Output "Login: https://localhost:5000"
  exit 0
}

$cp = "$dir\root;$dir\dist\ibgroup.web.core.iblink.router.clientportal.gw.jar;$dir\build\lib\runtime\*"
$jargs = @(
  "-server", "-Dvertx.disableDnsResolver=true", "-Djava.net.preferIPv4Stack=true",
  "-Dvertx.logger-delegate-factory-class-name=io.vertx.core.logging.SLF4JLogDelegateFactory",
  "-Dnologback.statusListenerClass=ch.qos.logback.core.status.OnConsoleStatusListener",
  "-Dnolog4j.debug=true", "-Dnolog4j2.debug=true",
  "-classpath", $cp, "ibgroup.web.core.clientportal.gw.GatewayStart"
)

$p = Start-Process -FilePath "java" -ArgumentList $jargs -WorkingDirectory $dir -WindowStyle Hidden -PassThru
Write-Output "Gateway gestartet (PID $($p.Id)), warte auf Port 5000…"

for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 3
  if (Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue) {
    Write-Output "OK — jetzt im Browser einloggen: https://localhost:5000"
    exit 0
  }
}
Write-Warning "Port 5000 nach 45s nicht offen — Log prüfen: C:\ibkr-gateway\logs\"
