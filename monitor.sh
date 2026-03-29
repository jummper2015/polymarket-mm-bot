cat > monitor.sh << 'SCRIPT'
#!/bin/bash
# Monitor del bot — ejecutar en otra terminal

while true; do
  clear
  echo "═══════════════════════════════════════════════"
  echo "  MM Bot Monitor — $(date)"
  echo "═══════════════════════════════════════════════"
  echo ""
  
  # Health check
  HEALTH=$(curl -s http://localhost:3100/health 2>/dev/null)
  if [ $? -eq 0 ]; then
    echo "✅ Bot ONLINE"
    echo "$HEALTH" | python3 -m json.tool 2>/dev/null
  else
    echo "❌ Bot OFFLINE"
  fi
  
  echo ""
  echo "─── Last 5 trades ───"
  tail -5 logs/trades-$(date +%Y-%m-%d).log 2>/dev/null || echo "(sin trades)"
  
  echo ""
  echo "─── Last 3 errors ───"
  grep "ERROR" logs/bot-$(date +%Y-%m-%d).log 2>/dev/null | tail -3 || echo "(sin errores)"
  
  echo ""
  echo "─── State file ───"
  ls -lh data/bot_state.json 2>/dev/null || echo "(no existe)"
  
  sleep 10
done
SCRIPT

chmod +x monitor.sh