# Setting up the Mehfil Bridge

The Mehfil Bridge is an optional LAN relay that lets devices sync even when they're not online at the same time. It runs on any machine that stays on — a desktop, home server, or Raspberry Pi — and buffers the last 24 hours of workspace messages in memory.

## What it does

- Announces itself on your LAN via mDNS (`_mehfil._tcp.local`, port 8765) so Mehfil finds it automatically.
- Stores incoming envelopes for 24 hours so offline devices can catch up.
- Provides a WebSocket `/signal` endpoint for WebRTC offer/answer/ICE exchange between peers on the same LAN.
- Identifies itself with an Ed25519 fingerprint that Mehfil pins on first connect, preventing impersonation.

The bridge stores **only ciphertext** — it never holds keys and cannot read messages.

## Install

### macOS (Homebrew)

```bash
brew install naklitechie/tap/mehfil-bridge
mehfil-bridge
```

### macOS / Linux (manual)

1. Download the binary for your platform from [Releases](https://github.com/NakliTechie/mehfil-bridge/releases):
   - `mehfil-bridge-darwin-arm64` (Apple Silicon)
   - `mehfil-bridge-darwin-amd64` (Intel Mac)
   - `mehfil-bridge-linux-amd64`
   - `mehfil-bridge-linux-arm64` (Raspberry Pi)

2. Make it executable and move to PATH:

```bash
chmod +x mehfil-bridge-darwin-arm64
sudo mv mehfil-bridge-darwin-arm64 /usr/local/bin/mehfil-bridge
```

3. Run it:

```bash
mehfil-bridge
```

### Windows

Download `mehfil-bridge-windows-amd64.exe` from [Releases](https://github.com/NakliTechie/mehfil-bridge/releases), rename it to `mehfil-bridge.exe`, and run it from a terminal.

## First run

On startup the bridge prints its fingerprint:

```
Mehfil Bridge listening on :8765
Bridge fingerprint: a3f8 92c1 5b04 e7d2
Announcing via mDNS: _mehfil._tcp.local
```

**Write down the fingerprint.** Mehfil will ask you to confirm it the first time you connect a workspace to this bridge.

The keypair is stored at `~/.mehfil-bridge/key` (mode 0600). The fingerprint stays the same across restarts as long as this file is not deleted.

## Connect a workspace

1. Open Mehfil and go to the workspace you want to connect.
2. Settings → Workspace → LAN Bridge → **+ Add bridge**.
3. Click **Auto-detect** — Mehfil tries `http://mehfil.local:8765` then `http://localhost:8765`.
4. If auto-detect finds the bridge, it fills in the URL. Click **Add bridge**.
5. Mehfil fetches the bridge fingerprint and shows a confirmation modal. **Compare the fingerprint to the one printed in your terminal.** Click "Matches ✓ — trust bridge" only if they match.
6. The fingerprint is pinned. Future connections are verified automatically.

If auto-detect fails (e.g. mDNS isn't working on your network), enter the bridge's IP address manually: `http://192.168.1.x:8765`.

## Run as a background service

### macOS (launchd)

```bash
cat > ~/Library/LaunchAgents/com.naklitechie.mehfil-bridge.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>              <string>com.naklitechie.mehfil-bridge</string>
  <key>ProgramArguments</key>  <array><string>/usr/local/bin/mehfil-bridge</string></array>
  <key>RunAtLoad</key>          <true/>
  <key>KeepAlive</key>          <true/>
  <key>StandardOutPath</key>   <string>/tmp/mehfil-bridge.log</string>
  <key>StandardErrorPath</key> <string>/tmp/mehfil-bridge.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.naklitechie.mehfil-bridge.plist
```

Check the fingerprint in the log:

```bash
cat /tmp/mehfil-bridge.log
```

### Linux (systemd)

```ini
# /etc/systemd/system/mehfil-bridge.service
[Unit]
Description=Mehfil Bridge
After=network.target

[Service]
ExecStart=/usr/local/bin/mehfil-bridge
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now mehfil-bridge
sudo journalctl -u mehfil-bridge -f  # view fingerprint + logs
```

## Firewall

The bridge listens on TCP port **8765**. If your machine has a firewall, allow inbound connections on that port from your LAN subnet.

## Security notes

- The bridge uses **fingerprint pinning** — Mehfil refuses to connect if the fingerprint changes unexpectedly. If you intentionally replace the bridge (new machine), remove the old bridge in Settings → Workspace → LAN Bridge and add the new one.
- The bridge stores only encrypted envelopes in memory. Nothing is written to disk. Restarting the bridge clears all buffered messages.
- The bridge trusts all devices on the same LAN to push envelopes. It does not verify signatures (that is the recipient client's job). Do not run the bridge on an untrusted network.
