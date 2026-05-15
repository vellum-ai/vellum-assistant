#!/bin/sh
set -eu

ALLOW_HOSTS="${ALLOW_HOSTS:-}"
if [ -z "$ALLOW_HOSTS" ]; then
  echo "ALLOW_HOSTS is required" >&2
  exit 64
fi

iptables -F OUTPUT
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

OLD_IFS="$IFS"
IFS=','
for host in $ALLOW_HOSTS; do
  IFS="$OLD_IFS"
  host=$(printf '%s' "$host" | tr -d '[:space:]')
  [ -n "$host" ] || continue

  getent ahostsv4 "$host" | awk '{print $1}' | sort -u | while read -r ip; do
    [ -n "$ip" ] || continue
    iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$ip" --dport 80 -j ACCEPT
  done
  IFS=','
done
IFS="$OLD_IFS"
