#!/bin/sh
# Writes the Kotlin the generator emits for the example spec into the example module,
# importing curlew-sqlite's binding from the package that library publishes it in.
#
#   prepare.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$here/example/build/generated-sources"

rm -rf "$out"
bun --no-install "$root/src/cli.ts" "$root/example/spec.json" \
    --kotlin-package org.example.reader.storage \
    --database-file-name reader.sqlite3 \
    --kotlin-out "$out/kotlin/org/example/reader/storage/LocalSQLiteGenerated.kt" \
    --swift-out "$out/swift/LocalSQLiteGenerated.swift" \
    --dart-out "$out/dart/local_sqlite_channel.dart"
