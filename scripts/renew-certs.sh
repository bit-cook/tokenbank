#!/usr/bin/env bash
# 续签 tokenbank.wink.run Let's Encrypt 证书（nginx HTTP-01 webroot），并 reload nginx。
# 生产机证书 lineage 在 nginx/certs/letsencrypt（不是系统 /etc/letsencrypt）。
# 首次签发用的是 standalone，续期必须改走 webroot：80 已被 nginx 占用。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${DOMAIN:-tokenbank.wink.run}"
LE="$ROOT/nginx/certs/letsencrypt"
DEST="$ROOT/nginx/certs"
LIVE="$LE/live/$DOMAIN"
WWW_VOL="${CERTBOT_WWW_VOLUME:-local-llm-proxy_certbot_www}"
NGINX_CTR="${NGINX_CONTAINER:-local-llm-proxy-nginx-1}"

if [[ ! -d "$LE/live/$DOMAIN" ]]; then
  echo "missing lineage: $LE/live/$DOMAIN" >&2
  exit 1
fi

docker run --rm \
  -v "$LE:/etc/letsencrypt" \
  -v "$WWW_VOL:/var/www/certbot" \
  certbot/certbot certonly \
    --webroot -w /var/www/certbot \
    --cert-name "$DOMAIN" \
    -d "$DOMAIN" \
    --non-interactive --agree-tos \
    --keep-until-expiring

cp -L "$LIVE/fullchain.pem" "$DEST/fullchain.pem"
cp -L "$LIVE/privkey.pem" "$DEST/privkey.pem"
chmod 644 "$DEST/fullchain.pem"
chmod 600 "$DEST/privkey.pem"
cp -L "$DEST/fullchain.pem" "$DEST/gateway-fullchain.pem"
cp -L "$DEST/privkey.pem" "$DEST/gateway-privkey.pem"
chmod 600 "$DEST/gateway-privkey.pem"

docker exec "$NGINX_CTR" nginx -s reload
openssl x509 -in "$DEST/fullchain.pem" -noout -subject -dates
echo "renew-certs: ok"
