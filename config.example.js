// Copy this file to config.js (git-ignored; serve.sh does it for you) and paste your licence key.
// A free 30-day trial key: https://loosen.sicena.com/trial
// Without a key every example still works; the widget just shows a small "Unlicensed copy" note.
window.LOOSEN_LICENCE = null;        // e.g. "LSN1.eyJ2Ijox....", a string between quotes

// Server mode only (examples/server.html). These are the defaults of scripts/run-loosend.sh; the query string overrides them
// (server.html?endpoint=...&catalog=...&key=...).
window.LOOSEN_SERVER = {endpoint: "http://localhost:8130", catalog: "apartments", key: "examples-read-key"};

// Server-rendered shop (cmd/shop) default address, used by the landing page link.
window.LOOSEN_SHOP = "http://localhost:8124/";

// The hosted demo (https://loosen.sicena.com/demo/) generates its own config.js at deploy time with a licence key, window.LOOSEN_HOSTED = true and
// RELATIVE addresses: LOOSEN_SHOP = "shop/" and LOOSEN_SERVER.endpoint = "api". Relative values are resolved against the root of the examples,
// so the same pages work at "/" (locally) and under "/demo/" (hosted). See deploy/README.md.
