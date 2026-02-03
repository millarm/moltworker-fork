#!/bin/bash
# Workspace Bootstrap Script
# Restores workspace scripts from GitHub and installs dependencies
# Called after container restart to ensure bots are ready to run

set -e

WORKSPACE="/root/clawd"
GITHUB_REPO="${WORKSPACE_GITHUB_REPO:-millarm/moltworker}"
REQUIREMENTS_FILE="/usr/local/share/moltbot/requirements.txt"

echo "=== Workspace Bootstrap ==="

# 1. Setup git identity
echo "Setting up git identity..."
git config --global user.name "${GIT_USER_NAME:-Cassandra}"
git config --global user.email "${GIT_USER_EMAIL:-cassandra@clawd.bot}"

# 2. Setup gh credential helper for git pushes
if command -v gh &> /dev/null; then
    echo "Configuring GitHub CLI for git operations..."
    gh auth setup-git 2>/dev/null || true
fi

# 3. Install Python dependencies
if [ -f "$REQUIREMENTS_FILE" ]; then
    echo "Installing Python dependencies..."
    pip install -q -r "$REQUIREMENTS_FILE" 2>/dev/null || pip3 install -q -r "$REQUIREMENTS_FILE"
fi

# 4. Create necessary directories
echo "Creating workspace directories..."
mkdir -p "$WORKSPACE/logs"
mkdir -p "$WORKSPACE/config"
mkdir -p "$WORKSPACE/data"
mkdir -p "$WORKSPACE/memory"
mkdir -p "$WORKSPACE/docs"

# 5. Restore workspace scripts from GitHub if not present
if [ ! -f "$WORKSPACE/ig_data_logger.py" ] && [ -n "$GH_TOKEN" ]; then
    echo "Restoring workspace scripts from GitHub..."
    TEMP_DIR=$(mktemp -d)
    if gh repo clone "$GITHUB_REPO" "$TEMP_DIR" -- --depth 1 2>/dev/null; then
        # Copy workspace files
        cp -n "$TEMP_DIR/workspace/"*.py "$WORKSPACE/" 2>/dev/null || true
        cp -n "$TEMP_DIR/workspace/"*.sh "$WORKSPACE/" 2>/dev/null || true
        cp -rn "$TEMP_DIR/workspace/docs" "$WORKSPACE/" 2>/dev/null || true
        # Make scripts executable
        chmod +x "$WORKSPACE/"*.py "$WORKSPACE/"*.sh 2>/dev/null || true
        echo "Workspace scripts restored from $GITHUB_REPO"
    else
        echo "Warning: Could not restore workspace from GitHub"
    fi
    rm -rf "$TEMP_DIR"
fi

# 6. Start trading bots if they exist and aren't running
start_bot() {
    local script=$1
    local logfile=$2
    
    if [ -f "$WORKSPACE/$script" ]; then
        if ! pgrep -f "$script" > /dev/null 2>&1; then
            echo "Starting $script..."
            cd "$WORKSPACE" && nohup python3 -u "$script" >> "$WORKSPACE/logs/$logfile" 2>&1 &
            sleep 1
        else
            echo "$script already running"
        fi
    fi
}

# Only start bots if IG credentials are configured
if [ -n "$IG_USERNAME" ] && [ -n "$IG_API_KEY" ]; then
    echo "IG credentials found, starting trading bots..."
    start_bot "ig_alert_bot.py" "alert_bot.log"
    start_bot "ig_data_logger.py" "data_logger.log"
    # Small delay before starting trader to avoid API rate limits
    sleep 3
    start_bot "ig_demo_trader.py" "trader.log"
else
    echo "IG credentials not configured, skipping trading bots"
fi

echo "=== Workspace Bootstrap Complete ==="
