#!/usr/bin/env bash
set -e

# Install reese supervisor as systemd service

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="reese-supervisor"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Find bun
BUN_PATH=$(which bun)
if [ -z "$BUN_PATH" ]; then
  echo "❌ bun not found in PATH"
  exit 1
fi

# Get current user
USER=$(whoami)

echo "📦 Installing ${SERVICE_NAME} service..."
echo "   User: $USER"
echo "   WorkDir: $SCRIPT_DIR"
echo "   Bun: $BUN_PATH"

# Create service file
sudo bash -c "cat > $SERVICE_FILE" <<EOF
[Unit]
Description=Reese Gateway Supervisor
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$BUN_PATH run src/index.ts supervisor
Restart=always
RestartSec=5
EnvironmentFile=$SCRIPT_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
sudo systemctl daemon-reload

# Enable and start
sudo systemctl enable $SERVICE_NAME
sudo systemctl start $SERVICE_NAME

echo "✅ Service installed and started!"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status $SERVICE_NAME"
echo "  sudo systemctl restart $SERVICE_NAME"
echo "  sudo systemctl stop $SERVICE_NAME"
echo "  journalctl -u $SERVICE_NAME -f"
echo ""
echo "Telegram commands:"
echo "  /gateway - restart gateway"
echo "  /status  - check gateway status"
echo "  /stop    - stop gateway"
echo "  /start   - start gateway"
