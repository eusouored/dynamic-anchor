# Testa os .bat do motor de verdade, num perfil isolado (LOCALAPPDATA/TEMP próprios).
# Uso: powershell -File bats.ps1 <pasta motor-rosto>
param([string]$pasta)
$ErrorActionPreference = 'Stop'
$perfil = Join-Path $env:TEMP ('anchor-bats-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force "$perfil\local", "$perfil\roaming", "$perfil\temp" | Out-Null
$env:LOCALAPPDATA = "$perfil\local"; $env:APPDATA = "$perfil\roaming"; $env:TEMP = "$perfil\temp"; $env:TMP = "$perfil\temp"
$env:ANCHOR_SEM_PAUSA = '1'
function Status { try { Invoke-RestMethod -Uri 'http://127.0.0.1:47833/v1/status' -TimeoutSec 2 } catch { $null } }
$r = [ordered]@{}
if (Status) { throw 'já há um motor na porta 47833' }
# 1) preparar-motor.bat: diagnóstico completo, relatório em %LOCALAPPDATA%\Dynamic Anchor\motor-rosto\diagnostico.txt
$p = Start-Process cmd.exe -ArgumentList '/c', "`"$pasta\preparar-motor.bat`"" -PassThru -WindowStyle Hidden
$diag = Join-Path $env:LOCALAPPDATA 'Dynamic Anchor\motor-rosto\diagnostico.txt'
for ($i = 0; $i -lt 240 -and -not (Test-Path $diag); $i++) { Start-Sleep -Milliseconds 500 }; Start-Sleep 1
$r.motorLigadoPelaPreparacao = [bool](Status)
if ($r.motorLigadoPelaPreparacao) { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47833/v1/encerrar' -Body '{}' -ContentType 'application/json' -TimeoutSec 3 | Out-Null; Start-Sleep 2 }
$r.diagnosticoExiste = Test-Path $diag
if ($r.diagnosticoExiste) { $t = Get-Content $diag -Raw -Encoding UTF8; $r.diagnosticoPronto = $t -match 'RESULTADO: PRONTO'; $r.diagnosticoFalhas = ([regex]::Matches($t, '\[FALHA\]')).Count; $r.diagnosticoNomeAntigo = $t -match '(?i)red.?lock|head.?lock'; $r.diagnosticoResumo = ($t -split "`n" | Where-Object { $_ -match 'RESULTADO|\[FALHA\]' }) -join ' | ' }
# 2) iniciar-motor.bat: o motor passa a responder
Start-Process cmd.exe -ArgumentList '/c', "`"$pasta\iniciar-motor.bat`"" -WindowStyle Hidden | Out-Null
$st = $null; for ($i = 0; $i -lt 120 -and -not $st; $i++) { Start-Sleep -Milliseconds 500; $st = Status }
$r.iniciarResponde = [bool]$st
if ($st) { $r.servico = $st.service; $r.versao = $st.version }
# 3) parar-motor.bat: o motor para de responder
& cmd.exe /c "`"$pasta\parar-motor.bat`"" | Out-Null
Start-Sleep -Seconds 2
$r.pararDesligou = -not (Status)
$r.pastaDados = (Get-ChildItem $env:LOCALAPPDATA -Directory | Select-Object -ExpandProperty Name) -join ','
$r | ConvertTo-Json
