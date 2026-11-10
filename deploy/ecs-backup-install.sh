#!/bin/bash
# Run from the reviewed source bundle. Does not restart the teaching platform.
set -euo pipefail
test "$(id -u)" = 0
source_root=$(cd "$(dirname "$0")/.." && pwd)
node_bin=/opt/node-v24.10.0-linux-x64/bin/node
test -x "$node_bin"
test -s /etc/shixunlab/backup.env
test -s /var/lib/shixunlab/EXPORT_COMPLETE
install -d -m 0700 -o teaching -g teaching /var/backups/shixunlab
install -d -m 0755 /opt/shixunlab/backup/scripts /opt/shixunlab/backup/storage
install -m 0644 "$source_root/scripts/backup-ecs.cjs" /opt/shixunlab/backup/scripts/backup-ecs.cjs
install -m 0644 "$source_root/storage/oss.cjs" /opt/shixunlab/backup/storage/oss.cjs
chown root:root /etc/shixunlab/backup.env
chmod 0600 /etc/shixunlab/backup.env
install -m 0644 "$source_root/deploy/ecs-backup.service" /etc/systemd/system/shixunlab-backup.service
install -m 0644 "$source_root/deploy/ecs-backup.timer" /etc/systemd/system/shixunlab-backup.timer
systemctl daemon-reload
# Only enable the restart gate after the first real upload and read-back succeeds.
systemctl start shixunlab-backup.service
install -d -m 0755 /etc/systemd/system/shixunlab.service.d
cat > /etc/systemd/system/shixunlab.service.d/backup.conf <<'EOF'
[Service]
# The privileged prefix runs only systemctl as root, not the application.
# Backup has its own environment; credentials are never injected into the web service.
ExecStartPre=+/usr/bin/systemctl start shixunlab-backup.service
TimeoutStartSec=16min
EOF
systemctl daemon-reload
systemctl enable --now shixunlab-backup.timer
systemctl is-active shixunlab-backup.timer
printf 'OSS_BACKUP_INSTALLED_AND_VERIFIED\n'
