@echo off
chcp 65001 >nul
setlocal
set "EXE=%~dp0anchor-motor\anchor-motor.exe"
if not exist "%EXE%" (
  echo ERRO: motor empacotado ausente. Reinstale o Dynamic Anchor a partir do pacote completo.
  if not defined ANCHOR_SEM_PAUSA pause
  exit /b 3
)
start "Dynamic Anchor - motor de rosto" "%EXE%"
exit /b 0
