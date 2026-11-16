@echo off
chcp 65001 >nul
setlocal
rem Desliga o motor de rosto (use antes de atualizar os arquivos do motor).
call :achar_python
if not defined PY goto :sem_python
"%PY%" -c "import urllib.request as u;u.urlopen(u.Request('http://127.0.0.1:47833/v1/encerrar',data=b'{}',method='POST',headers={'Content-Type':'application/json'}),timeout=3);print('Motor de rosto desligado.')" 2>nul || echo O motor de rosto ja estava desligado.
if not defined ANCHOR_SEM_PAUSA pause
exit /b 0

:sem_python
rem Motor empacotado (sem Python): desliga pelo PowerShell, tambem so em 127.0.0.1.
powershell -NoProfile -Command "try{Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47833/v1/encerrar' -Body '{}' -ContentType 'application/json' -TimeoutSec 3|Out-Null;'Motor de rosto desligado.'}catch{'O motor de rosto ja estava desligado.'}"
if not defined ANCHOR_SEM_PAUSA pause
exit /b 0

:achar_python
rem Procura o Python instalado por usuario ou para todos, do mais novo ao mais antigo.
set "PY="
for %%V in (319 318 317 316 315 314 313 312 311 310) do (
  if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
  if not defined PY if exist "%ProgramFiles%\Python%%V\python.exe" set "PY=%ProgramFiles%\Python%%V\python.exe"
)
if defined PY exit /b 0
for /f "delims=" %%P in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%P"
if defined PY if not exist "%PY%" set "PY="
if defined PY exit /b 0
for /f "delims=" %%P in ('python -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%P"
if defined PY if not exist "%PY%" set "PY="
exit /b 0
