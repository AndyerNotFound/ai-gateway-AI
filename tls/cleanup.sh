#!/usr/bin/env bash
# 临时文件定时清理：给导出到公共目录（如 /sdcard/Download）的证书设一个到期删除时间。
#   bash tls/cleanup.sh add <路径> <分钟>   安排删除（支持小数，如 0.5）
#   bash tls/cleanup.sh list                看还有哪些排着队
#   bash tls/cleanup.sh cancel <路径>       取消
#   bash tls/cleanup.sh sweep               把到期的删掉（guard 每 5 分钟兜底调用）
# 说明：后台会起一个精确计时器；Termux 被杀掉也不会漏 —— guard 会兜底扫描。
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
JOBDIR="$DIR/.run/cleanup"
LOG="$DIR/log/cleanup.log"
export PATH="$PATH:/data/data/com.termux/files/usr/bin"
mkdir -p "$JOBDIR" "$DIR/log"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
id_of() { printf '%s' "$1" | sha256sum | awk '{print substr($1,1,16)}'; }

add() {
  local p="$1" m="$2" id secs at
  [ -z "${p:-}" ] && { echo "✗ 缺少路径"; exit 1; }
  [ -e "$p" ] || { echo "✗ 文件不存在: $p"; exit 1; }
  id="$(id_of "$p")"
  secs="$(awk -v m="$m" 'BEGIN{printf "%d", m*60}')"
  [ "$secs" -lt 1 ] && secs=1
  at=$(( $(date +%s) + secs ))
  printf '%s\n%s\n' "$p" "$at" > "$JOBDIR/$id.job"
  log "安排删除 $p （${secs}s 后）"
  setsid nohup sh -c "sleep $secs; bash '$DIR/tls/cleanup.sh' sweep" >/dev/null 2>&1 9>&- &
  echo "$id"
}

sweep() {
  local now f p at removed=0
  now="$(date +%s)"
  for f in "$JOBDIR"/*.job; do
    [ -e "$f" ] || continue
    p=""; at=0
    { IFS= read -r p; IFS= read -r at; } < "$f"
    [ -z "$p" ] && { rm -f "$f"; continue; }
    if [ "${at:-0}" -le "$now" ]; then
      if [ -e "$p" ]; then rm -f "$p" && { log "已删除 $p"; removed=$((removed+1)); }; fi
      rm -f "$f"
    fi
  done
  echo "$removed"
}

list_jobs() {
  local f p at now left n=0
  now="$(date +%s)"
  for f in "$JOBDIR"/*.job; do
    [ -e "$f" ] || continue
    { IFS= read -r p; IFS= read -r at; } < "$f"
    left=$(( ${at:-0} - now )); [ $left -lt 0 ] && left=0
    printf '  %-52s %s 后删除\n' "$p" "${left}s"; n=$((n+1))
  done
  [ $n -eq 0 ] && echo "  （没有排队中的任务）"
}

cancel() {
  local p="$1" id; id="$(id_of "$p")"
  if [ -f "$JOBDIR/$id.job" ]; then rm -f "$JOBDIR/$id.job"; log "取消删除 $p"; echo "✓ 已取消"; else echo "（没有这个任务）"; fi
}

case "${1:-}" in
  add)    add "${2:-}" "${3:-5}" ;;
  sweep)  sweep ;;
  list)   list_jobs ;;
  cancel) cancel "${2:-}" ;;
  *)      echo "用法: cleanup.sh add <路径> <分钟> | list | cancel <路径> | sweep" ;;
esac
