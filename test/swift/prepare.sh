#!/bin/sh
# Fills Sources/ for the Swift package beside this script: the SQLite amalgamation
# curlew-sqlite pins (fetched and checked against the pin's SHA-256 by curlew-sqlite's own
# script), its C shim and identity check, and the Swift the generator emits for the
# example spec.
#
#   prepare.sh <curlew-sqlite checkout>
#
# The checkout is only read; everything is written under this directory.
set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: prepare.sh <curlew-sqlite checkout>" >&2
    exit 2
fi
engine=$(cd "$1" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
c_target="$here/Sources/CurlewSQLite"
swift_target="$here/Sources/ExampleStore"

rm -rf "$here/Sources"
mkdir -p "$c_target/include" "$swift_target"

lock="$engine/CurlewSQLite.lock.json"
url=$(plutil -extract archive.url raw -o - "$lock")
sha256=$(plutil -extract archive.sha256 raw -o - "$lock")
prefix=$(plutil -extract archive.strip_prefix raw -o - "$lock")
(cd "$c_target" && /bin/sh "$engine/ios/fetch-amalgamation.sh" "$url" "$sha256" "$prefix")
mv "$c_target/$prefix/sqlite3.c" "$c_target/sqlite3.c"
mv "$c_target/$prefix/sqlite3.h" "$c_target/include/sqlite3.h"
rmdir "$c_target/$prefix"
cp "$engine/ios/CurlewSQLiteShim.c" "$c_target/"
cp "$engine/ios/CurlewSQLiteShim.h" "$c_target/include/"
cp "$lock" "$c_target/"

# In the pod the identity check is Swift inside the CurlewSQLite module. A Swift package
# target is C or Swift, not both, so here it compiles into the module the generated Swift
# is in, which resolves the same unqualified name.
cp "$engine/ios/CurlewSQLiteProviderIdentity.swift" "$swift_target/"

bun --no-install "$root/src/cli.ts" "$root/example/spec.json" \
    --kotlin-package org.example.reader.storage \
    --database-file-name reader.sqlite3 \
    --kotlin-out "$here/.build-generated/LocalSQLiteGenerated.kt" \
    --swift-out "$swift_target/LocalSQLiteGenerated.swift" \
    --dart-out "$here/.build-generated/local_sqlite_channel.dart"
