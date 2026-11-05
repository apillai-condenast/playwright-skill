# npx -y @playwright/mcp@0.0.84 \
# --executable-path "/Users/apillai/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
# --user-data-dir ./usr_data_dir \
# --isolated --port 8931 --host 127.0.0.1
npx -y @playwright/mcp@0.0.84 \
--executable-path "/Users/apillai/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
--user-data-dir ./usr_data_dir \
--viewport-size "1210,786" \
--snapshot-mode=none \
--port 8931 --host 127.0.0.1
