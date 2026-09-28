#!/bin/zsh
# Mantém o bot rodando: se o processo cair, reinicia em 5s.
# Iniciar:  nohup ./scripts/run-bot.sh >/dev/null 2>&1 &
# Parar:    pkill -f run-bot.sh; pkill -f "src/index.js"
cd "$(dirname "$0")/.."
while true; do
  node --env-file=.env --no-warnings src/index.js >> data/bot.log 2>&1
  echo "$(date '+%H:%M:%S') 🔁 bot saiu (código $?) — reiniciando em 5s" >> data/bot.log
  sleep 5
done
