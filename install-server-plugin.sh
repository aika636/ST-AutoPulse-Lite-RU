#!/data/data/com.termux/files/usr/bin/env bash
#
# ST-AutoPulse — установка/обновление серверного плагина (Termux / любой Node-хост).
#
# Запуск одной строкой:
#   curl -fsSL https://raw.githubusercontent.com/aika636/ST-AutoPulse-Lite-RU/main/install-server-plugin.sh | bash
#
# Если SillyTavern установлен НЕ в ~/SillyTavern, передайте путь:
#   curl -fsSL .../install-server-plugin.sh | bash -s -- /путь/к/SillyTavern
#
set -u

REPO_RAW="https://raw.githubusercontent.com/aika636/ST-AutoPulse-Lite-RU/main"
PLUGIN_SRC="$REPO_RAW/server-plugin/index.js"
PLUGIN_ID="autopulse"

# ── цвета (если терминал поддерживает) ───────────────────────────────
if [ -t 1 ]; then B="\033[1m"; G="\033[32m"; Y="\033[33m"; R="\033[31m"; N="\033[0m"; else B=""; G=""; Y=""; R=""; N=""; fi
say()  { printf "${B}»${N} %s\n" "$*"; }
ok()   { printf "${G}✓${N} %s\n" "$*"; }
warn() { printf "${Y}!${N} %s\n" "$*"; }
die()  { printf "${R}✗ %s${N}\n" "$*" >&2; exit 1; }

# ── 0. наличие curl ──────────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || die "Не найден curl. В Termux: pkg install curl"

# ── 1. определить папку SillyTavern ──────────────────────────────────
ST_DIR="${1:-${ST_DIR:-}}"
if [ -z "$ST_DIR" ]; then
    for d in "$HOME/SillyTavern" "$HOME/sillytavern" "$PWD"; do
        if [ -f "$d/server.js" ] || [ -f "$d/config.yaml" ]; then ST_DIR="$d"; break; fi
    done
fi
[ -n "$ST_DIR" ] || die "Не нашёл папку SillyTavern. Укажите путь: ... | bash -s -- /путь/к/SillyTavern"
ST_DIR="$(cd "$ST_DIR" 2>/dev/null && pwd)" || die "Папка не существует: $ST_DIR"
{ [ -f "$ST_DIR/server.js" ] || [ -f "$ST_DIR/config.yaml" ]; } || die "В $ST_DIR не похоже на SillyTavern (нет server.js/config.yaml)"
ok "SillyTavern: $ST_DIR"

# ── 2. скачать index.js плагина в plugins/autopulse/ ─────────────────
PLUGIN_DIR="$ST_DIR/plugins/$PLUGIN_ID"
mkdir -p "$PLUGIN_DIR" || die "Не удалось создать $PLUGIN_DIR"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
say "Скачиваю серверный плагин…"
curl -fsSL "$PLUGIN_SRC" -o "$TMP" || die "Не удалось скачать $PLUGIN_SRC"
# минимальная проверка, что это тот самый файл
grep -q "id: '$PLUGIN_ID'" "$TMP" || die "Скачанный файл не похож на плагин AutoPulse (проверьте ветку/URL)"
cp "$TMP" "$PLUGIN_DIR/index.js" || die "Не удалось записать $PLUGIN_DIR/index.js"
ok "Плагин установлен: $PLUGIN_DIR/index.js"

# ── 3. включить enableServerPlugins в config.yaml ────────────────────
CONFIG="$ST_DIR/config.yaml"
if [ ! -f "$CONFIG" ]; then
    warn "config.yaml ещё нет — он создаётся при первом запуске SillyTavern."
    warn "Запустите ST один раз, затем прогоните этот скрипт снова, чтобы включить плагины."
else
    cp "$CONFIG" "$CONFIG.autopulse.bak" 2>/dev/null && ok "Бэкап конфига: $CONFIG.autopulse.bak"
    if grep -qE '^[[:space:]]*enableServerPlugins[[:space:]]*:' "$CONFIG"; then
        sed -i -E 's/^([[:space:]]*)enableServerPlugins[[:space:]]*:.*/\1enableServerPlugins: true/' "$CONFIG"
    else
        printf '\nenableServerPlugins: true\n' >> "$CONFIG"
    fi
    if grep -qE '^[[:space:]]*enableServerPlugins[[:space:]]*:[[:space:]]*true' "$CONFIG"; then
        ok "enableServerPlugins: true"
    else
        warn "Не удалось подтвердить enableServerPlugins — проверьте $CONFIG вручную."
    fi
fi

# ── 4. итог и как проверить ──────────────────────────────────────────
PORT="$(grep -E '^[[:space:]]*port[[:space:]]*:' "$CONFIG" 2>/dev/null | head -1 | grep -oE '[0-9]+' || true)"
[ -n "$PORT" ] || PORT=8000
printf "\n${G}${B}Готово.${N} Осталось перезапустить SillyTavern:\n"
printf "   1) В сессии Termux нажмите Ctrl+C, чтобы остановить ST\n"
printf "   2) Запустите снова:  cd %s && ./start.sh\n" "$ST_DIR"
printf "   3) Проверка (после запуска):\n"
printf "      curl http://127.0.0.1:%s/api/plugins/%s/status\n" "$PORT" "$PLUGIN_ID"
printf "      → должен вернуться JSON, а не 404\n\n"
printf "${Y}Termux-совет:${N} включите «Acquire wakelock» и отключите оптимизацию батареи для\n"
printf "Termux, иначе Android усыпит процесс и серверные таймеры остановятся.\n"
