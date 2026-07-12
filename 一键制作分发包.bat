@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title peilv 一键制作分发包

set "PNPM_VERSION=9.0.0"
set "NO_PAUSE="
if /i "%~1"=="--no-pause" set "NO_PAUSE=1"

cd /d "%~dp0"

echo ========================================
echo peilv 一键制作分发包
echo 项目目录：%cd%
echo ========================================
echo.

if not exist "package.json" (
  echo 错误：当前目录不是项目根目录。
  goto :failed
)

if not exist "scripts\create-distribution.ps1" (
  echo 错误：未找到 scripts\create-distribution.ps1。
  goto :failed
)

if not exist ".env" (
  echo 错误：未找到 .env，无法制作可用的分发包。
  goto :failed
)

echo [1/5] 检查 Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo 错误：未检测到 Node.js，请先安装 Node.js 20 或更高版本。
  goto :failed
)
node -e "const major=Number(process.versions.node.split('.')[0]); process.exit(major >= 20 ? 0 : 1)"
if errorlevel 1 (
  for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
  echo 错误：当前 Node.js 版本为 !NODE_VERSION!，需要 20 或更高版本。
  goto :failed
)
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
echo 已检测到 Node.js：%NODE_VERSION%

echo.
echo [2/5] 检查 pnpm...
where pnpm.cmd >nul 2>nul
if errorlevel 1 (
  echo 未检测到 pnpm，尝试通过 Corepack 启用 pnpm %PNPM_VERSION%...
  where corepack.cmd >nul 2>nul
  if errorlevel 1 (
    echo 错误：未检测到 pnpm 或 Corepack，请先执行 npm install -g pnpm@%PNPM_VERSION%。
    goto :failed
  )
  call corepack.cmd enable
  if errorlevel 1 (
    echo 错误：Corepack 启用失败，请以管理员身份运行或手动安装 pnpm。
    goto :failed
  )
  call corepack.cmd prepare pnpm@%PNPM_VERSION% --activate
  if errorlevel 1 (
    echo 错误：pnpm 准备失败，请检查网络后重试。
    goto :failed
  )
)
for /f "tokens=*" %%v in ('pnpm.cmd -v 2^>nul') do set "DETECTED_PNPM_VERSION=%%v"
echo 已检测到 pnpm：%DETECTED_PNPM_VERSION%

echo.
echo [3/5] 安装并检查依赖...
call pnpm.cmd install --prefer-frozen-lockfile --prefer-offline
if errorlevel 1 (
  echo 错误：依赖安装失败。
  goto :failed
)

echo.
echo [4/5] 构建生产版本...
call pnpm.cmd next build
if errorlevel 1 (
  echo 错误：Next.js 生产构建失败。
  goto :failed
)
call pnpm.cmd tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify
if errorlevel 1 (
  echo 错误：服务端入口打包失败。
  goto :failed
)

echo.
echo [5/5] 创建并校验 ZIP 分发包...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\create-distribution.ps1"
if errorlevel 1 (
  echo 错误：ZIP 分发包创建或校验失败。
  goto :failed
)

echo.
echo ========================================
echo 分发包制作完成。
echo ZIP file was created in the parent directory.
echo WARNING: The ZIP contains .env settings and access secrets.
echo ========================================
goto :success

:failed
echo.
echo 分发包制作失败，请根据上方错误信息处理后重试。
call :pause_if_needed
exit /b 1

:success
call :pause_if_needed
exit /b 0

:pause_if_needed
if not defined NO_PAUSE pause
exit /b 0
