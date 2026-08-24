@echo off
title Portal RDV - servidor
cd /d "%~dp0"

set NODE="%USERPROFILE%\Tools\node-v24.19.0-win-x64\node.exe"

if not exist %NODE% (
  echo.
  echo  Nao encontrei o Node em:
  echo  %NODE%
  echo.
  echo  Se ele foi movido, ajuste a linha "set NODE=" deste arquivo.
  echo.
  pause
  exit /b 1
)

echo.
echo  Subindo o Portal RDV... deixe esta janela aberta.
echo  Para desligar o portal, feche esta janela.
echo.

%NODE% servidor.js

echo.
echo  O servidor parou.
pause
