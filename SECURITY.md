# Security policy

Report suspected vulnerabilities privately using
[GitHub private vulnerability reporting](https://github.com/curlewlabs-com/sqlite-store-gen/security/advisories/new).
Include the affected release or commit, reproduction steps and the observed
impact. Keep credentials, account identifiers and personal data out of public
issues.

Curlew Labs maintains this repository; Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) is the release
and security contact through GitHub. Reports are reviewed on a best-effort basis
without a guaranteed response time. Fixes target the latest release; older
release lines have no promised backport window.

## Trust boundary

The generator runs at build time on a spec you wrote, and treats it as source
code: table and column names, brands, checks and doc text are written into the
generated Kotlin, Swift and SQL as given. Review a spec change the way you
review code. The option values the command line takes are checked against the
shapes they are written into. At run time, the generated code binds every value
as a statement parameter; no value from your app or its users is ever
interpolated into SQL.
