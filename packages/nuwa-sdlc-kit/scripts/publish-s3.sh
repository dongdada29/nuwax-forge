#!/usr/bin/env bash
# 把 kit 打包发布到 Nuwax S3（MinIO，与 nuwa-cli / nuwa-browser 同仓同布局）
# 用法:
#   bash scripts/publish-s3.sh [--dry-run]
#   # 有 ~/.aws [default]（MinIO 凭证）可直接跑；或：
#   set -a; source /path/to/.env; set +a; bash scripts/publish-s3.sh
# 环境（与 nuwa-cli 同名同义，全部可缺省）:
#   NUWAX_S3_ENDPOINT          默认 https://s3.nuwax.com:9443
#   NUWAX_S3_REGION            默认 us-east-1
#   NUWAX_S3_BUCKET            默认 nuwax-packages
#   NUWAX_S3_PREFIX            默认 agent-engines/nuwa-sdlc-kit
#   NUWAX_S3_NO_VERIFY_SSL     自签端点设 1
#   NUWAX_S3_ACCESS_KEY_ID / NUWAX_S3_SECRET_ACCESS_KEY   （无 ~/.aws profile 时用；值不落日志）
# 产物: {PREFIX}/install.sh + latest.json + nuwa-sdlc-kit-<ver>.tar.gz（latest.json 带 sha256）
set -eu

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

command -v aws >/dev/null 2>&1 || { echo "❌ 需要 aws cli (brew install awscli)" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ 需要 node >= 18" >&2; exit 1; }
command -v shasum >/dev/null 2>&1 || { echo "❌ 需要 shasum" >&2; exit 1; }

VER="$(tr -d '[:space:]' < kit/VERSION)"
TARBALL="nuwa-sdlc-kit-${VER}.tar.gz"

# NUWAX_S3_* 凭证映射到 AWS_*（不回显值）；两者都没有则回落 ~/.aws profile
[ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${NUWAX_S3_ACCESS_KEY_ID:-}" ] && export AWS_ACCESS_KEY_ID="$NUWAX_S3_ACCESS_KEY_ID"
[ -z "${AWS_SECRET_ACCESS_KEY:-}" ] && [ -n "${NUWAX_S3_SECRET_ACCESS_KEY:-}" ] && export AWS_SECRET_ACCESS_KEY="$NUWAX_S3_SECRET_ACCESS_KEY"

ENDPOINT="${NUWAX_S3_ENDPOINT:-https://s3.nuwax.com:9443}"
REGION="${NUWAX_S3_REGION:-us-east-1}"
BUCKET="${NUWAX_S3_BUCKET:-nuwax-packages}"
PREFIX="${NUWAX_S3_PREFIX:-agent-engines/nuwa-sdlc-kit}"
AWS_ARGS=(--endpoint-url "$ENDPOINT" --region "$REGION")
[ "${NUWAX_S3_NO_VERIFY_SSL:-0}" = "1" ] && AWS_ARGS+=(--no-verify-ssl)

# 防呆：前缀不含本包名，大概率 source 了别的包的 .env（曾把 kit 传进 nuwa-cli 前缀）
if [[ "$PREFIX" != *nuwa-sdlc-kit* && "${FORCE_PREFIX:-0}" != "1" ]]; then
  echo "❌ PREFIX=$PREFIX 不含 nuwa-sdlc-kit，疑似指错包。确要发布到该前缀请 FORCE_PREFIX=1" >&2
  exit 1
fi

echo "→ 打包 v${VER} → $TARBALL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -czf "$TMP/$TARBALL" -C . kit cli.mjs install.sh README.md package.json
SHA="$(shasum -a 256 "$TMP/$TARBALL" | cut -d' ' -f1)"
node -e '
const fs = require("fs");
const [ver, tb, sha] = process.argv.slice(1);
fs.writeFileSync(process.argv[4] + "/latest.json", JSON.stringify({ version: ver, tarball: tb, sha256: sha }, null, 2) + "\n");
' "$VER" "$TARBALL" "$SHA" "$TMP"

BASE="s3://$BUCKET/$PREFIX"
IMMUTABLE=(--cache-control "public, max-age=31536000, immutable")
FRESH=(--cache-control "public, max-age=60, must-revalidate")
up() {
  if [ "$DRY_RUN" = "1" ]; then echo "  [dry] s3 cp $1 → $2"; return; fi
  aws s3 cp "$1" "$2" "${AWS_ARGS[@]}" "${@:3}" >/dev/null
}

echo "→ 上传 $BASE/（endpoint=${ENDPOINT}）"
up "$TMP/$TARBALL"    "$BASE/$TARBALL"    "${IMMUTABLE[@]}"
up install.sh         "$BASE/install.sh"  "${FRESH[@]}"
up "$TMP/latest.json" "$BASE/latest.json" "${FRESH[@]}"

# 介绍页与使用文档（如存在；随版本独立更新，短缓存）
if [ -f site/index.html ]; then
  echo "→ 介绍页 (site/index.html)…"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry] s3 cp site/index.html → $BASE/site/index.html"
  else
    aws s3 cp site/index.html "$BASE/site/index.html" "${AWS_ARGS[@]}" \
      --cache-control "public, max-age=300" --content-type "text/html; charset=utf-8" >/dev/null
  fi
fi
if [ -f README.md ]; then
  echo "→ 使用文档 (docs/README.md)…"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry] s3 cp README.md → $BASE/docs/README.md"
  else
    aws s3 cp README.md "$BASE/docs/README.md" "${AWS_ARGS[@]}" \
      --cache-control "public, max-age=300" --content-type "text/markdown; charset=utf-8" >/dev/null
  fi
fi

echo "✅ v${VER} 发布完成"
echo "   一键装: curl -fsSLk $ENDPOINT/$BUCKET/$PREFIX/install.sh | bash"
echo "   介绍页: $ENDPOINT/$BUCKET/$PREFIX/site/index.html"
echo "   使用文档: $ENDPOINT/$BUCKET/$PREFIX/docs/README.md"
