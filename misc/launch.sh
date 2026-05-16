#!/bin/bash
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"
export PATH="$SCRIPT_DIR/bin:$PATH"

npm i

# 检查配置文件是否存在
if [ ! -f config.js ]; then
    echo "[INFO] Config file not found. Creating config.js from example..."
    cp config.example.js config.js
    echo "[IMPORTANT] Please edit config.js to configure your environment."
    echo ""
    read -p "Press [Enter] key to continue starting the server..."
fi

node server.js --static dist.zip