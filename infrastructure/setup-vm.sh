#!/bin/bash
# ═══════════════════════════════════════════════════════════
# VM Setup Script — Run ONCE on a fresh Ubuntu 22.04 GCP VM
# Target: kodspot-electrical-api (asia-south1-b)
# ═══════════════════════════════════════════════════════════
set -euo pipefail

echo "══════════════════════════════════════════"
echo "  Kodspot Electrical Platform — VM Setup"
echo "══════════════════════════════════════════"

# 1. System updates
echo "→ Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# 2. Install Docker
echo "→ Installing Docker..."
sudo apt-get install -y ca-certificates curl gnupg lsb-release

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 3. Add current user to docker group (so we don't need sudo)
echo "→ Adding $USER to docker group..."
sudo usermod -aG docker "$USER"

# 4. Install Git
echo "→ Installing Git..."
sudo apt-get install -y git

# 5. Configure firewall (allow SSH, HTTP, HTTPS)
echo "→ Configuring firewall..."
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable

# 6. Install fail2ban for brute-force protection
echo "→ Installing fail2ban..."
sudo apt-get install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban

# 7. Clone the repository
echo "→ Cloning repository..."
cd ~
if [ -d "electrical-platform" ]; then
  echo "  Repository already exists, pulling latest..."
  cd electrical-platform
  git pull origin main
else
  git clone https://github.com/kodspot/electrical-platform.git
  cd electrical-platform
fi

# 8. Create backup directory
echo "→ Creating backup directory..."
sudo mkdir -p /opt/kodspot-backups
sudo chown "$USER":"$USER" /opt/kodspot-backups

# 9. Setup automated maintenance cron jobs
echo "→ Setting up maintenance cron jobs..."
CRON_FILE="/tmp/kodspot-cron"
cat > "$CRON_FILE" << 'CRON'
# Kodspot Electrical Platform — Automated Maintenance
# Daily database backup at 2 AM IST (14-day retention)
0 2 * * * /home/$USER/electrical-platform/infrastructure/backup-db.sh >> /var/log/kodspot-electrical-backup.log 2>&1
# Clean unused Docker images & containers every Sunday at 3 AM IST (no --volumes to protect DB data)
0 3 * * 0 docker system prune -af --filter "until=168h" >> /var/log/kodspot-electrical-maintenance.log 2>&1
# Clean old Docker build cache weekly
0 4 * * 0 docker builder prune -f --keep-storage=2GB >> /var/log/kodspot-electrical-maintenance.log 2>&1
CRON
crontab "$CRON_FILE"
rm "$CRON_FILE"
echo "  Cron jobs installed"

echo ""
echo "══════════════════════════════════════════"
echo "  ✅ VM Setup Complete!"
echo "══════════════════════════════════════════"
echo ""
echo "IMPORTANT: Log out and log back in for docker group to take effect:"
echo "  exit"
echo "  (then SSH back in)"
echo ""
echo "Then verify docker works without sudo:"
echo "  docker ps"
echo ""
