@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title peilv 一键启动

set "SCRIPT_VERSION=2026.07.09"
set "PORT=5000"
set "APP_URL=http://localhost:%PORT%"
set "PNPM_VERSION=9.0.0"

cd /d "%~dp0"

echo ========================================
echo peilv 一键启动 - 分发版 %SCRIPT_VERSION%
echo 项目目录：%cd%
echo 访问地址：%APP_URL%
echo ========================================
echo.

if not exist "package.json" (
  echo 错误：当前目录不是项目根目录。
  echo 请把本文件放在包含 package.json 的项目文件夹里再运行。
  echo 当前目录：%cd%
  pause
  exit /b 1
)

echo [1/6] 检查 Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 错误：未检测到 Node.js。
  echo 请先安装 Node.js 20 或更高版本，然后重新双击本脚本。
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
echo 已检测到 Node.js：%NODE_VERSION%

echo.
echo [2/6] 检查 pnpm...
where pnpm >nul 2>nul
if errorlevel 1 (
  echo 未检测到 pnpm，尝试通过 Corepack 启用 pnpm...
  where corepack >nul 2>nul
  if errorlevel 1 (
    echo.
    echo 错误：未检测到 pnpm，也未检测到 corepack。
    echo 请手动执行：npm install -g pnpm
    pause
    exit /b 1
  )

  corepack enable
  if errorlevel 1 (
    echo.
    echo 错误：Corepack 启用失败。
    echo 请右键本脚本选择“以管理员身份运行”，或手动执行：npm install -g pnpm
    pause
    exit /b 1
  )

  corepack prepare pnpm@%PNPM_VERSION% --activate
  if errorlevel 1 (
    echo.
    echo 错误：pnpm 准备失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

for /f "tokens=*" %%v in ('pnpm -v 2^>nul') do set "DETECTED_PNPM_VERSION=%%v"
echo 已检测到 pnpm：%DETECTED_PNPM_VERSION%

if not exist ".env" (
  echo.
  echo 警告：未找到 .env 文件。
  echo 没有 .env 时，页面可能可以打开，但数据库/Supabase 相关功能可能无法使用。
  echo 如果你是普通使用者，请联系分发者补发 .env 或配置说明。
  echo.
  set /p CONTINUE_WITHOUT_ENV=仍然继续启动吗？输入 y 继续，其他任意键退出：
  if /i not "!CONTINUE_WITHOUT_ENV!"=="y" (
    echo 已取消启动。
    pause
    exit /b 1
  )
)

echo.
echo [3/6] 检查依赖...
if not exist "node_modules" (
  echo 未找到 node_modules，正在安装依赖，首次启动可能需要几分钟...
  call pnpm install --prefer-frozen-lockfile
  if errorlevel 1 (
    echo.
    echo 依赖安装失败，可能是网络无法访问默认 npm 源。
    set /p USE_MIRROR=是否使用国内镜像重试？输入 y 重试，其他任意键退出：
    if /i "!USE_MIRROR!"=="y" (
      call pnpm install --prefer-frozen-lockfile --registry=https://registry.npmmirror.com
      if errorlevel 1 (
        echo.
        echo 错误：使用镜像安装依赖仍然失败，请检查网络或联系分发者。
        pause
        exit /b 1
      )
    ) else (
      echo 已取消启动。
      pause
      exit /b 1
    )
  )
) else (
  echo 已找到 node_modules，跳过依赖安装。
)

echo.
echo [4/6] 检查启动命令...
if not exist "node_modules\.bin\tsx.cmd" (
  echo 未检测到本地启动命令 node_modules\.bin\tsx.cmd。
  echo 依赖可能没有安装完整，或 node_modules 不是在这台电脑上生成的。
  echo.
  set /p REINSTALL_DEPS=是否重新安装依赖？输入 y 重新安装，其他任意键退出：
  if /i "!REINSTALL_DEPS!"=="y" (
    echo 正在重新安装依赖...
    set "CI=true"
    call pnpm install --force --prefer-frozen-lockfile
    if errorlevel 1 (
      echo.
      echo 重新安装依赖失败，尝试使用国内镜像重试...
      call pnpm install --force --prefer-frozen-lockfile --registry=https://registry.npmmirror.com
      if errorlevel 1 (
        echo 错误：依赖不完整，无法启动。
        pause
        exit /b 1
      )
    )
  ) else (
    echo 已取消启动。
    pause
    exit /b 1
  )
)

echo.
echo [5/6] 释放 %PORT% 端口...
set "FOUND_PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  set "PID=%%a"
  if not "!PID!"=="0" (
    set "FOUND_PID=1"
    echo 结束占用端口 %PORT% 的进程 PID: !PID!
    taskkill /PID !PID! /F >nul 2>nul
    if errorlevel 1 (
      echo 警告：无法结束 PID !PID!，如启动失败请右键选择“以管理员身份运行”。
    )
  )
)

if not defined FOUND_PID (
  echo 端口 %PORT% 未被占用。
) else (
  timeout /t 1 >nul
  echo 端口清理完成。
)

echo.
echo [6/6] 启动服务...
echo 浏览器将在几秒后自动打开：%APP_URL%
echo 按 Ctrl+C 可停止服务。
echo.
start "" cmd /c "timeout /t 5 >nul && start "" %APP_URL%"

set "PORT=%PORT%"
call node_modules\.bin\tsx.cmd watch src/server.ts

echo.
echo 服务已退出。如果上面有报错，请截图发给分发者排查。
pause
