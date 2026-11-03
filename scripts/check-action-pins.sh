#!/bin/sh
# 外部の GitHub Action が、完全な commit の SHA (40 桁) で固定されているかを確かめる。
# タグやブランチで参照すると、参照先が書き換えられたときに、確かめていないコードが動くため。
set -eu
status=0
for file in $(find .github/workflows -name '*.yml' -o -name '*.yaml' 2>/dev/null); do
  grep -nE '^[[:space:]-]*uses:[[:space:]]*' "$file" | while IFS= read -r line; do
    ref=$(printf '%s\n' "$line" | sed -E 's/^[0-9]+:[[:space:]-]*uses:[[:space:]]*//; s/[[:space:]]+#.*$//; s/["'"'"']//g')
    case "$ref" in
      ./*|docker://*) continue ;;
    esac
    if ! printf '%s\n' "$ref" | grep -qE '@[0-9a-f]{40}$'; then
      echo "$file:${line%%:*}: SHA で固定していない: $ref"
      exit 1
    fi
  done || status=1
done
exit $status
