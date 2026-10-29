# TODO

Last update: 29 October 2026. The shop is in `~/dev/loosen/TODO.md`, the product in `~/dev/cbte2/TODO.md`.

1. **Decide whether the demo's form labels are translated.** On a translated demo page (`?lang=ar` etc.) the widget panel is in that language but the host form
   labels stay English (the host's own text), except in `examples/francais.html`. It is deliberate for now: the guide, the docs and the demo are English only.
   Translating the labels would mean a per-page label table in `assets/` and changing the smoke test (`test/smoke.mjs`).
2. **Re-vendor the widget when `cbte2/widget` changes** (`scripts/sync-widget.sh`, then redeploy the demo: `deploy/README.md`); the examples use widget 0.5.1.
3. Optional: run the smoke test on a Windows machine (the `run-loosend.sh` path without Docker is documented as manual there).

## Decisions (do not reopen)

* The demo's `loosend` admin key is SOPS-encrypted in this public repository by design (loopback-only, public demo data; moving it out was considered and declined).
* The second example language is French. The demo works with a production licence for the host `loosen.sicena.com` only.
