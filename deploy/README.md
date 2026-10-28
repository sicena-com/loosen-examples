# Deploying the hosted demo

The demo at <https://loosen.sicena.com/demo/> runs on CT 147 (the machine of the Loosen shop). This folder is everything needed to rebuild it; it is generic
(replace the host names and the `projects.json` entry for another machine) and contains no secret in the clear: the loosend admin key is in `../config/prod.secrets.env.sops`
(SOPS) and the licence key in `../config/prod.env` is public by design (bound to the host `loosen.sicena.com`).

**Decision (David): the demo's loosend admin key is SOPS-encrypted in this public repository, by design.** loosend listens on loopback only (127.0.0.1:8130), nothing outside the CT can use the key, and the demo catalogue is public data; moving the key out of the repository was considered (P1) and declined, so it stays as is.

```
browser --HTTPS--> david-iac proxy --> loosen shop (Go, CT 147 :8080) --/demo/ (prefix stripped, GET/HEAD, and POST explain only)--> front (127.0.0.1:8081)
                                                                                                   |-- static files  (allow-list of paths, www/)
                                                                                                   |-- /shop/        --> shop    (127.0.0.1:8124, cmd/shop)
                                                                                                   `-- /api/v1/catalogs/apartments/explain --> loosend 1.0.0 (127.0.0.1:8130)
```

* `cmd/front` is the only thing the shop talks to. It serves an allow-list of static paths (`www/` holds nothing else), proxies `/shop/`, and forwards exactly one
  loosend route; it has a body limit (8 KiB), a per-IP rate limit (120/min, burst 40; loosend has its own), `Cache-Control: no-cache` on every response and
  `/health` (needs `X-Health-Token`, probes loosend's health, one explain call and the shop).
* The shop (`~/dev/loosen`, `internal/web/demo.go`) proxies `/demo/` when `DEMO_UPSTREAM=http://127.0.0.1:8081` is set: no cookies or `Authorization` either way, the
  site's strict CSP is dropped for `/demo/` only (the example pages run inline scripts), and the demo stays public even while the shop is closed.
* Three systemd units: `loosen-examples` (front; deployed by `prod/bin/deploy.py`), `loosen-examples-loosend` and `loosen-examples-shop` (installed by
  `remote-setup.sh`). Starting the front restarts the other two, so a deployment reloads everything; loosend's `ExecStartPost` (`start-post.sh`) loads the catalog with
  `scripts/load-catalog.sh` and the admin key, so a restart never leaves it empty (snapshots in `shared/loosend-data` are only a bonus).
* `build.sh` compiles `front` and `shop`, downloads loosend with `scripts/fetch-loosend.sh` (checks the SHA-256 against the published `SHA256SUMS`) and generates
  `www/config.js` (licence, `LOOSEN_HOSTED`, `shop/`, `api`) from the generated `.env`.

```sh
./deploy.sh              # deploy.py loosen-examples prod: build, upload a release to /opt/loosen-examples/releases/, switch current, health checks, automatic rollback
./deploy.sh --status     # ./deploy.sh --rollback
BASE_URL=https://loosen.sicena.com/demo NODE_PATH=... node test/smoke.mjs     # test the live demo
```

Order when the shop changed too: deploy this demo first, then `~/dev/loosen`. To renew the licence key (valid until 2036) use the command in `config/prod.env`.
