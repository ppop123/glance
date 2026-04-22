# fanyi-asr-worker

MLX Whisper subprocess. Runs on the Mac mini (`192.168.50.8`) or anywhere with Apple Silicon + `uv`.

## Install (on mac mini)

```bash
ssh wangyan@192.168.50.8
mkdir -p ~/fanyi-asr && cd ~/fanyi-asr
# copy pyproject.toml and worker.py from this directory
uv sync
# first run will download ~1.5 GB model into ~/.cache/huggingface
WHISPER_MODEL=mlx-community/whisper-large-v3-turbo \
  uv run uvicorn worker:app --host 0.0.0.0 --port 8788
```

## Run as a LaunchAgent (optional)

```bash
cat > ~/Library/LaunchAgents/com.fanyi.asr.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.fanyi.asr</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/uv</string>
    <string>run</string>
    <string>--directory</string>
    <string>/Users/wangyan/fanyi-asr</string>
    <string>uvicorn</string>
    <string>worker:app</string>
    <string>--host</string><string>0.0.0.0</string>
    <string>--port</string><string>8788</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/fanyi-asr.log</string>
  <key>StandardErrorPath</key><string>/tmp/fanyi-asr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WHISPER_MODEL</key><string>mlx-community/whisper-large-v3-turbo</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload ~/Library/LaunchAgents/com.fanyi.asr.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/com.fanyi.asr.plist
```

## Test

```bash
curl -F "file=@sample.mp3" -F "language=en" http://192.168.50.8:8788/transcribe
```
