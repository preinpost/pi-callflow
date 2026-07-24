# [0.4.0](https://github.com/preinpost/pi-callflow/compare/v0.3.0...v0.4.0) (2026-07-24)


### Features

* **web:** PNG export button and light theme ([30adf57](https://github.com/preinpost/pi-callflow/commit/30adf570670aba53bd31e38de7cd30ea4c098900))

# [0.3.0](https://github.com/preinpost/pi-callflow/compare/v0.2.1...v0.3.0) (2026-07-24)


### Features

* **core:** add summary pane to Call Flow window ([72b961a](https://github.com/preinpost/pi-callflow/commit/72b961aa66d5ac12e173c5ee27ce7d22b4b0765e))

## [0.2.1](https://github.com/preinpost/pi-callflow/compare/v0.2.0...v0.2.1) (2026-07-24)


### Bug Fixes

* **core:** tolerate loose groups + newlines so validation never hard-fails ([5c9c0a6](https://github.com/preinpost/pi-callflow/commit/5c9c0a6176e8e4a56a18dbbed98bd61e46e0e184))

# [0.2.0](https://github.com/preinpost/pi-callflow/compare/v0.1.7...v0.2.0) (2026-07-24)


### Bug Fixes

* **pi:** escape semicolons in Mermaid sequence message text ([02f3e9a](https://github.com/preinpost/pi-callflow/commit/02f3e9aa0cd0ca9b537c11cc870f6e00828f46eb))


### Features

* **pi:** generate flowchart from structured nodes/edges too ([5204e7a](https://github.com/preinpost/pi-callflow/commit/5204e7a3ba5e5a6d80d97df9ce061d0fa80dac09))
* **pi:** generate Mermaid sequence from structured steps instead of raw string ([7bad0c4](https://github.com/preinpost/pi-callflow/commit/7bad0c47238b655330cc1949d1ad5faef488510d))
* **web): friendly render-error fallback; test(core:** structured Mermaid builder unit tests ([9695db9](https://github.com/preinpost/pi-callflow/commit/9695db97cee8c90701c9d9226f1e9f4bf1d4024e)), closes [#59](https://github.com/preinpost/pi-callflow/issues/59)

## [0.1.7](https://github.com/preinpost/pi-callflow/compare/v0.1.6...v0.1.7) (2026-07-24)


### Bug Fixes

* **pi:** sanitize Mermaid sequence input to avoid parse errors with parens/angle brackets ([a92d4b9](https://github.com/preinpost/pi-callflow/commit/a92d4b9a017b5d6ccf6a04b2484fd47495bcfa43))
