# vendored `ws`

This directory contains a verbatim copy of the npm package **`ws` 8.21.3**
(MIT), used as the WebSocket server implementation of `dsh-remote-mobile`.

- Upstream: https://github.com/websockets/ws
- License: MIT (see `LICENSE` in this directory)
- Copied files: `index.js`, `browser.js`, `wrapper.mjs`, `lib/`, `package.json`,
  `README.md`, `LICENSE`
- Why vendored: the plugin runs inside the DSH Host process and must work
  offline after installation; keeping the runtime dependency inside the bundle
  avoids a registry fetch during `install_bundle` and guarantees the same `ws`
  build everywhere.

No source modifications were made. To upgrade, replace this directory with the
matching upstream release and re-run the plugin test suite
(`docker run`-free: `node scripts/run-tests.mjs`).
