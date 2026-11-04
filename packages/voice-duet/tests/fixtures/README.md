`upstream-excerpts.json` contains source excerpts from YuMS/dsh-duet v0.1.10,
commit 143de3f30c61d323568b3863d2e5badeb47123e7, Copyright 2026 YuMS.
Apache-2.0; see ../../LICENSE and ../../NOTICE.

The endpoint HTTP/recommendation/connection functions and settings validation
function retain upstream bodies. Imports have been reduced to their dependencies.
The proxy excerpt retains its signature and validation statements, then returns a
sentinel instead of registering a socket server; version compatibility is stubbed.
These are local unit fixtures, not a substitute for the optional full-upstream test.
