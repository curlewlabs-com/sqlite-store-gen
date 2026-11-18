# Contributing

Thanks for your interest in improving `sqlite-store-gen`. The bar for a change
is whether it keeps the Kotlin and Swift storage layers it emits typed, closed
(no SQL text reaches them at run time) and identical in behavior on both
platforms, and keeps a spec it cannot generate correctly from generating at all.
Bug fixes, sharper spec errors, and clearer docs are all welcome.

Use [Bun](https://bun.sh) 1.4.4. Keep changes on a branch and open a pull
request that says what behavior changes and how you verified it.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

A change to what the generator emits should also pass the native checks the
README's Development section describes, which CI runs on every pull request.

## Maintainership and review

Curlew Labs maintains this project. Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) reviews changes
and approves the releases that [need approval](#releases). Use issues for
reproducible defects and proposals; use
[private vulnerability reporting](SECURITY.md) for security concerns.

Changes land through pull requests with passing CI and maintainer review. A
change to what a spec emits changes code an app has already shipped, so say in
the pull request what an app regenerating with it would see differ. Every
dependency is pinned to an exact version.

## Before a large change

Open an issue describing the problem first. The README's "What the generated
layer guarantees" carries the invariants: no SQL text at run time, a typed value
per column, a verified engine and connection profile on every open, a
version-gated schema, and corruption classified but never acted on. A feature
belongs here only if it stays useful with the example app swapped for another. A
short discussion up front saves rework.

## Releases

A patch or minor release needs no approval: whoever cuts it follows the steps
below in order, on a `main` commit whose required checks have passed. A major
version, a 1.0, or a minor before 1.0 that changes an interface consumers use
needs the maintainer's explicit approval before its tag is pushed.

1. Set `version` in `package.json` on `main`.
2. Push the tag `vX.Y.Z` at that commit. The Release workflow runs CI, packs the
   tarball and opens a draft release with it attached.
3. Check the draft, then publish it. Releases are immutable: a published
   release's tag and assets cannot be changed, so a fix is a new version.

## License

By submitting a contribution for inclusion in this project, you agree that it is
licensed under the MIT and Apache-2.0 licenses, as the README's License section
describes, without any additional terms or conditions.
