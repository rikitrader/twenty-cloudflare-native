#!/bin/sh
set -eu

patch_package() {
  package_name="$1"
  version="$2"
  sha512="$3"
  target="$4"

  case "$target" in
    /app/node_modules/*) ;;
    *)
      echo "refusing unsafe package target: $target" >&2
      exit 1
      ;;
  esac
  test -d "$target"

  archive="$(mktemp)"
  curl --fail --silent --show-error --location \
    "https://registry.npmjs.org/${package_name}/-/${package_name}-${version}.tgz" \
    --output "$archive"
  printf '%s  %s\n' "$sha512" "$archive" | sha512sum -c -s

  find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  tar -xzf "$archive" --strip-components=1 -C "$target"
  rm "$archive"

  installed="$(
    node -e 'process.stdout.write(require(process.argv[1]).version)' \
      "$target/package.json"
  )"
  test "$installed" = "$version"
  chown -R 1000:1000 "$target"
  echo "patched ${package_name}@${version} at ${target}"
}

patch_package \
  tar 7.5.20 \
  f457322b83c0ebe59bce54ccf568509babc1e56edc3fb75488fb2fd60ed80f01109d0d421a92b730694a93f213556324d3990766e061995862bfc2d9a32fcf15 \
  /app/node_modules/tar
patch_package \
  axios 1.18.0 \
  137d8dce960aa7ef96ed745ee76ac78975767a1c66877c1b7603bb30778533ebeac4b0581f3b74125922226b4e071b4e9b2a74ca80bc0bab8449557ce18dbf87 \
  /app/node_modules/axios
patch_package \
  brace-expansion 5.0.8 \
  259c83caadc3e005227ca4cf381ec310b7fa5ec07759d3ee3710ada1bd6f1573ec49785d0221c1589fed27c1c073d687f3804afb924564b36424ac771bd93342 \
  /app/node_modules/brace-expansion
cp /cf/brace-expansion-v5-cjs-compat.cjs \
  /app/node_modules/brace-expansion/compat.cjs
node -e '
  const fs = require("node:fs");
  const target = "/app/node_modules/brace-expansion/package.json";
  const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
  manifest.main = "./compat.cjs";
  manifest.exports["."].require.default = "./compat.cjs";
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
'
chown -R 1000:1000 /app/node_modules/brace-expansion
patch_package \
  brace-expansion 5.0.8 \
  259c83caadc3e005227ca4cf381ec310b7fa5ec07759d3ee3710ada1bd6f1573ec49785d0221c1589fed27c1c073d687f3804afb924564b36424ac771bd93342 \
  /app/node_modules/minimatch/node_modules/brace-expansion
patch_package \
  js-yaml 4.3.0 \
  d6d77bf3c6809e7679aaced5d90211975a308ed6296cab7be3d637c5abaa420c0820617fc575b3d70313101c793b72cade55cb56ea973dd3f18f6068147696f5 \
  /app/node_modules/js-yaml
patch_package \
  linkify-it 5.0.2 \
  38d4e6da308c0156638106bf172d6449c5ecb8ea05e4d3d3b28141744d4a548676bc087fafdf81aa8fb48c83420589dabd33d0673dfc43315399eefd10da0ddd \
  /app/node_modules/linkify-it
