#!/usr/bin/env bash
# 每 5 分钟一次的守护任务（由 watchdog.sh 调用）：
#   1) 证书：剩余 <7 天 / 不被本 CA 签发 / SAN 缺当前 IP → 重签并重启（随时可做）
#   2) 客户端密钥：到期才轮换，且只在 03:00-05:00 窗口内执行（走 admin API，零停机，无需重启）
# 并发保护：flock；退出码恒为 0，避免拖垮 watchdog。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/data"
export PATH="$PATH:/data/data/com.termux/files/usr/bin"
LOG="$DATA/log/tls.log"
LOCK="$DATA/.run/guard.lock"
WINDOW_START="${WINDOW_START:-3}"
WINDOW_END="${WINDOW_END:-5}"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
probe_url() {
  node -e '
    const fs=require("fs"),path=require("path");
    const D=process.argv[1];
    try{
      const c=require(path.join(D,"crypt.js"));
      let r=fs.readFileSync(path.join(D,"config.json"),"utf8");
      if(c.isEncText(r))r=c.decryptText(r,c.loadPass());
      const j=JSON.parse(r),t=j.tls||(j.listen&&j.listen.tls)||{};
      const hp=(j.listen||{}).port||16384;
      if(t.enable){const p=(t.port!=null)?Number(t.port):hp;process.stdout.write("https://127.0.0.1:"+p+"/health")}
      else process.stdout.write("http://127.0.0.1:"+hp+"/health");
    }catch(e){process.stdout.write("")}
  ' "$1"
}


mkdir -p "$DATA/.run" "$DATA/log"
exec 9>"$LOCK"
if ! flock -n 9; then exit 0; fi

# ---- 1) 证书 ----
out="$(bash "$ROOT/tls/renew.sh" --no-restart 2>&1)"
rc=$?
first="$(printf '%s\n' "$out" | head -n 1)"
case "$first" in
  renewed)
    log "证书已重签，重启网关"
    if bash "$ROOT/agw.sh" restart >/dev/null 2>&1 9>&-; then   # 9>&- : 别把锁 fd 传给长命子进程
      sleep 3
      P="$(node -e 'try{const fs=require("fs"),c=require(process.argv[2]+"/crypt.js");let r=fs.readFileSync(process.argv[1],"utf8");if(c.isEncText(r))r=c.decryptText(r,c.loadPass());const j=JSON.parse(r).tls||{};process.stdout.write(String(j.enable&&j.port?j.port:""))}catch(e){}' "$DATA/config.json" "$ROOT")"
      if curl -sf -m 8 --cacert "$ROOT/tls/ca.pem" "$(probe_url "$ROOT")" >/dev/null 2>&1; then
        log "✓ 重启后 HTTPS :$P 健康"
        served="$(echo | openssl s_client -connect "127.0.0.1:$P" -servername localhost 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null)"
        onfile="$(openssl x509 -in "$DATA/cert.pem" -noout -fingerprint -sha256 2>/dev/null)"
        if [ -n "$served" ] && [ "$served" = "$onfile" ]; then log "✓ 服务端证书指纹与文件一致"
        else log "✗ 服务端证书与文件不一致（网关未加载新证书？served=${served:-?}）"; fi
      else
        log "✗ 重启后 HTTPS :${P:-?} 健康检查失败"
      fi
    else
      log "✗ 重启失败"
    fi
    ;;
  nochange) : ;;
  *)
    log "✗ 证书检查异常(rc=$rc): $(echo "$out" | tail -n 3 | tr '\n' ' ')"
    ;;
esac

# ---- 2) 客户端密钥轮换（夜间窗口）----
H=$(date +%H)
if [ "$H" -ge "$WINDOW_START" ] && [ "$H" -lt "$WINDOW_END" ]; then
  kout="$(node "$ROOT/ops/rotate-keys.js" --if-due 2>&1)"
  [ -n "$kout" ] && log "密钥轮换: $(echo "$kout" | tr '\n' ' ' | cut -c1-400)"
fi

bash "$ROOT/tls/cleanup.sh" sweep >/dev/null 2>&1   # 临时文件到期删除的兜底
date +%s > "$DATA/.run/guard.last"   # 每次运行都记时间戳，用于确认调度链

# ---- 3) 心跳（每小时最多一条，用于确认调度链活着）----
HB="$DATA/.run/guard.heartbeat"
now_s=$(date +%s)
last_s=$(cat "$HB" 2>/dev/null || echo 0)
if [ $((now_s - last_s)) -ge 3600 ]; then
  end="$(openssl x509 -in "$DATA/cert.pem" -noout -enddate 2>/dev/null | cut -d= -f2)"
  kd="$(node -e 'try{const s=require(process.argv[1]);const d=(new Date(s.lastRotate)).getTime();const left=Math.ceil(s.rotateDays-(Date.now()-d)/864e5);process.stdout.write(String(left))}catch(e){process.stdout.write("?")}' "$DATA/.keyrotation.json" 2>/dev/null)"
  log "heartbeat: 证书到期 ${end:-?} / 密钥下次轮换 ${kd:-?} 天后"
  echo "$now_s" > "$HB"
fi

exit 0
