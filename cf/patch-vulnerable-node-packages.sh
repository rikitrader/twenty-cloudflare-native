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
  tar 7.5.19 \
  e0b7845a5f7ab709d2d90ec1cf8306aa06b32ea3be84937adc66715e822a8754f75707980fdf7b81b53522d36c41a7eaa974d7779585c8575178bb70bd104d8b \
  /app/node_modules/tar
patch_package \
  axios 1.18.0 \
  137d8dce960aa7ef96ed745ee76ac78975767a1c66877c1b7603bb30778533ebeac4b0581f3b74125922226b4e071b4e9b2a74ca80bc0bab8449557ce18dbf87 \
  /app/node_modules/axios
patch_package \
  brace-expansion 2.1.2 \
  c3925970a81d8433a03b09bc1fe2a06e8b28a4732e19c97aa9bba5c23b73dd233b23b3f7c96d5e023ccc3cbac813e350f6f8e000d28759e3079eb4f43975b5a0 \
  /app/node_modules/brace-expansion
# brace-expansion@2 is CommonJS and requires balanced-match@1's callable
# export. The image also carries balanced-match@4 at the root for the modern
# brace-expansion tree, whose ESM namespace object is not call-compatible.
# Keep the two dependency generations isolated exactly as npm would.
mkdir -p /app/node_modules/brace-expansion/node_modules/balanced-match
patch_package \
  balanced-match 1.0.2 \
  de849e50ed13315ebb84dd4099b5ec2b8c9aa94eed8e21e56f144364ea47d0a5bdf82797e1b440697d009f1b74b71d8cae94695b041a3f02252121098585393f \
  /app/node_modules/brace-expansion/node_modules/balanced-match
patch_package \
  brace-expansion 5.0.7 \
  ee8172ef4dddc5f637fcd2f10b57e1d925024341fdae6018fb91290d57d78d44d3b3e1c4c11da761aa8bbfe196713b2e9b0c4f7e2cfa0b308d9305f0054c2a08 \
  /app/node_modules/minimatch/node_modules/brace-expansion
patch_package \
  js-yaml 4.3.0 \
  d6d77bf3c6809e7679aaced5d90211975a308ed6296cab7be3d637c5abaa420c0820617fc575b3d70313101c793b72cade55cb56ea973dd3f18f6068147696f5 \
  /app/node_modules/js-yaml
patch_package \
  linkify-it 5.0.2 \
  38d4e6da308c0156638106bf172d6449c5ecb8ea05e4d3d3b28141744d4a548676bc087fafdf81aa8fb48c83420589dabd33d0673dfc43315399eefd10da0ddd \
  /app/node_modules/linkify-it
