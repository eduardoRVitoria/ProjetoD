@echo off
setlocal enabledelayedexpansion
title Portal RDV - vigia (nao feche esta janela)
cd /d "%~dp0"

rem  Vigia do Portal RDV.
rem
rem  O portal fecha sozinho quando encontra um erro que nao da para confiar -
rem  melhor cair e voltar limpo do que gravar dado errado. So que, num PC, cair
rem  significa ficar fora do ar ate alguem perceber. Este arquivo e quem
rem  percebe: liga o portal, espera ele morrer e liga de novo, sempre.
rem
rem  Deixe ESTA janela aberta. Fechar ela desliga o portal de vez.

if "%PORT%"=="" set PORT=3000

rem  Node: usa o do PATH; se nao achar, tenta os lugares de costume.
set NODE=node
where node >nul 2>&1 || (
  if exist "%ProgramFiles%\nodejs\node.exe" set NODE="%ProgramFiles%\nodejs\node.exe"
)
if not defined NODE goto sem_node

set /a TENTATIVAS=0

:ligar
echo.
echo  [%date% %time%] subindo o Portal RDV na porta %PORT%...
%NODE% servidor.js
set CODIGO=%ERRORLEVEL%

rem  Codigo 0 e saida pedida (Ctrl+C, encerramento normal): nao religa sozinho,
rem  senao nao existe jeito de desligar o portal.
if "%CODIGO%"=="0" (
  echo  [%date% %time%] o portal foi encerrado de proposito. Fim.
  goto fim
)

set /a TENTATIVAS+=1
echo  [%date% %time%] o portal caiu ^(codigo %CODIGO%^). Religando em 3s... ^(queda n. !TENTATIVAS!^)
timeout /t 3 /nobreak >nul
goto ligar

:sem_node
echo.
echo  Nao achei o Node neste computador. Instale em https://nodejs.org
echo.
pause
exit /b 1

:fim
echo.
pause
