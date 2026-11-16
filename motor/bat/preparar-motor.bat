@echo off
chcp 65001 >nul
setlocal
set "EXE=%~dp0anchor-motor\anchor-motor.exe"
if not exist "%EXE%" (
  echo ERRO: motor empacotado ausente. Reinstale o Dynamic Anchor a partir do pacote completo.
  if not defined ANCHOR_SEM_PAUSA pause
  exit /b 3
)
set "DADOS=%LOCALAPPDATA%\Dynamic Anchor\motor-rosto"
if not exist "%DADOS%" mkdir "%DADOS%"
start "" /wait "%EXE%" --preparar "%DADOS%\diagnostico.txt"
set "RC=%ERRORLEVEL%"
if exist "%DADOS%\diagnostico.txt" type "%DADOS%\diagnostico.txt"
if not defined ANCHOR_SEM_PAUSA pause
exit /b %RC%
