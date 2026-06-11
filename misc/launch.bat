@echo off
set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%"
set "PATH=%ROOT_DIR%bin;%PATH%"

call npm i >nul

:: 检查配置文件是否存在
if not exist config.js (
  echo [信息] 未找到配置文件，正在从模板创建
  copy config.example.js config.js
  echo [重要] 新配置文件已创建，请编辑 config.js 来修改，然后
  echo.
  pause
  cls
)

node server.js --static dist.brip
pause
