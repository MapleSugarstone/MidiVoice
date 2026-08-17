#!/usr/bin/env bash
# Start MidiVoice on macOS or Linux. Windows users: double-click
# "Start MidiVoice.bat" instead.
set -e

cd "$(dirname "$0")"

echo
echo "  =============================="
echo "    MidiVoice - starting up"
echo "  =============================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed, and MidiVoice needs it to run."
  echo "  Install the LTS version from https://nodejs.org/ then run this again."
  echo
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run - installing dependencies."
  echo "  This takes a minute or two and only happens once."
  echo
  npm install --no-fund --no-audit
  echo
fi

echo "  Starting the server. Your browser should open on its own."
echo "  If it doesn't, go to:  http://localhost:5273"
echo
echo "  Keep this terminal open while you work. Ctrl+C stops MidiVoice."
echo

npm run dev
