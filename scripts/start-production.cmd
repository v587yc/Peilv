@echo off
echo Windows production automation is not supported. Use the Linux systemd credential deployment. 1>&2
echo For local Windows development, use pnpm dev with an explicit private INTERNAL_API_SECRET_FILE. 1>&2
exit /b 1
