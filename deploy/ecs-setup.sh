#!/bin/bash
set -euo pipefail
release=${1:-/opt/shixunlab/releases/20261103}
case "$release" in /opt/shixunlab/releases/*) ;; *) echo 'Expected an isolated release directory' >&2; exit 1;; esac
test -f "$release/server.cjs"
test -x /opt/node-v24.10.0-linux-x64/bin/node
id teaching >/dev/null 2>&1 || useradd --system --home-dir /var/lib/shixunlab --shell /sbin/nologin teaching
install -d -m 0700 -o teaching -g teaching /var/lib/shixunlab
install -d -m 0700 /etc/shixunlab /etc/nginx/ssl/shixunlab
install -d -m 0700 -o teaching -g teaching /var/backups/shixunlab
# Preserve the original data path and credentials across code deployments.
if test -e /opt/shixunlab/current; then
    test -s /etc/shixunlab/app.env
    test -s /var/lib/shixunlab/EXPORT_COMPLETE
    for db in accounts/accounts.sqlite catering/emenu.sqlite hotel/hotel.sqlite; do
        test -s "/var/lib/shixunlab/$db"
    done
    # Fail before switching the release when no working remote backup exists.
    systemctl start shixunlab-backup.service
fi
ln -sfn "$release" /opt/shixunlab/current
if ! test -e /etc/shixunlab/app.env; then
cat > /etc/shixunlab/app.env <<'EOF'
NODE_ENV=production
STORAGE_BACKEND=nas
REQUIRE_NAS=0
DATA_DIR=/var/lib/shixunlab
HOST=127.0.0.1
PORT=9000
CATERING_PORT=9101
HOTEL_PORT=9102
ACCOUNTS_PORT=9104
ACCOUNTS_ADMIN_SOCKET=/run/shixunlab/accounts-admin.sock
TRUST_LOCAL_PROXY=1
ENABLE_MCP=0
ENABLE_TEACHER_CHAT=0
TEACHER_AGENT_MODE=disabled
NODE_OPTIONS=--max-old-space-size=192
EOF
fi
chmod 600 /etc/shixunlab/app.env
cat > /etc/systemd/system/shixunlab.service <<'EOF'
[Unit]
Description=Shixunlab teaching platform
After=network.target
[Service]
Type=simple
User=teaching
Group=teaching
WorkingDirectory=/opt/shixunlab/current
EnvironmentFile=/etc/shixunlab/app.env
ExecStartPre=/usr/bin/test -f /var/lib/shixunlab/EXPORT_COMPLETE
ExecStart=/opt/node-v24.10.0-linux-x64/bin/node server.cjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
KillMode=mixed
RuntimeDirectory=shixunlab
RuntimeDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/shixunlab /run/shixunlab
MemoryMax=1200M
TasksMax=128
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable shixunlab
printf 'ECS_SETUP_READY\n'
