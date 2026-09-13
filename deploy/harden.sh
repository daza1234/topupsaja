#!/usr/bin/env bash
# Idempoten: pasang fail2ban (sshd jail default) + unattended-upgrades security.
set -euo pipefail

apt-get update -qq
apt-get install -y fail2ban unattended-upgrades

systemctl enable --now fail2ban

# Otomatis install security updates harian
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

systemctl restart fail2ban
echo "fail2ban:"; fail2ban-client status sshd || true
echo "20auto-upgrades:"; cat /etc/apt/apt.conf.d/20auto-upgrades
