#!/usr/bin/env bash
# nuwa-sdlc-kit 一键安装（Nuwax S3 / MinIO 分发版；bucket 公开可读，匿名 curl 即可）
# 用法：
#   curl -fsSLk https://s3.nuwax.com:9443/nuwax-packages/agent-engines/nuwa-sdlc-kit/install.sh | bash
#   # 传参给 init：curl ... | bash -s -- init --name myrepo --test 'pnpm test'
# 环境变量：
#   NUWA_SDLK_S3_BASE   版本清单与制品的公开基址（默认指向 nuwax-packages，自签端点自动回退 -k）
#   NUWA_SDLK_HOME      kit 运行时安装位置（默认 ~/.nuwa-sdlc-kit）
set -eu

BASE="${NUWA_SDLK_S3_BASE:-https://s3.nuwax.com:9443/nuwax-packages/agent-engines/nuwa-sdlc-kit}"
HOME_DIR="${NUWA_SDLK_HOME:-$HOME/.nuwa-sdlc-kit}"

# 取 URL 到文件：先正常 TLS，失败回退 -k（自签 MinIO 端点）
fetch() { curl -fsSL "$1" -o "$2" 2>/dev/null || curl -fsSLk "$1" -o "$2"; }

command -v node >/dev/null 2>&1 || { echo "❌ 需要 node >= 18" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ 拉取版本清单 $BASE/latest.json"
fetch "$BASE/latest.json" "$TMP/latest.json"

VER="$(node -e 'process.stdout.write(require("'"$TMP"'/latest.json").version)')"
TARBALL="$(node -e 'process.stdout.write(require("'"$TMP"'/latest.json").tarball)')"
SHA="$(node -e 'process.stdout.write(require("'"$TMP"'/latest.json").sha256)')"

echo "→ 下载 nuwa-sdlc-kit $VER"
fetch "$BASE/$TARBALL" "$TMP/kit.tar.gz"
echo "$SHA  $TMP/kit.tar.gz" | shasum -a 256 -c - >/dev/null
echo "→ 校验通过"

DEST="$HOME_DIR/$VER"
mkdir -p "$DEST"
tar -xzf "$TMP/kit.tar.gz" -C "$DEST"

BIN="$HOME/.local/bin/nuwa-sdlc"
mkdir -p "$HOME/.local/bin"
ln -sf "$DEST/cli.mjs" "$BIN"
chmod +x "$DEST/cli.mjs" 2>/dev/null || true

echo "✅ nuwa-sdlc-kit $VER 就绪：$BIN"
echo "   在目标仓库执行: nuwa-sdlc init --name <repo> --test '<cmd>'"
