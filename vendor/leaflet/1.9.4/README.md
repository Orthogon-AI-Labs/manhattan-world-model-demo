# Leaflet 1.9.4 — vendored

Locally-served Leaflet 1.9.4 assets, replacing the `unpkg.com` URLs the pilot used to load. See `specs/CODEX-SPEC-015-Vendor-Leaflet-Library.md` for the rationale.

## Provenance

- **Version:** 1.9.4
- **Source:** `https://unpkg.com/leaflet@1.9.4/dist/`
- **Imported:** 2026-04-30
- **License:** BSD-2-Clause (preserved in `leaflet.js` header)

## Files

| File | Bytes | SHA-256 |
|---|---:|---|
| `leaflet.js` | 147,552 | `db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a` |
| `leaflet.css` | 14,806 | `a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6` |
| `images/marker-icon.png` | 1,466 | (binary, image asset) |
| `images/marker-icon-2x.png` | 2,464 | (binary, image asset) |
| `images/marker-shadow.png` | 618 | (binary, image asset) |
| `images/layers.png` | 696 | (binary, image asset) |
| `images/layers-2x.png` | 1,259 | (binary, image asset) |

The image PNGs are referenced by `leaflet.css` (`url(images/...)`) and by Leaflet's default `L.Icon`. Our pilot uses `L.divIcon` for project markers but keeping the defaults makes the layer control and any future default-marker usage Just Work without further wiring.

## Upgrading

To pick up a new Leaflet version:

1. Create `vendor/leaflet/<new-version>/` with the new files (re-run the same `curl -sLO` steps).
2. Update the two URLs in `prototype/codex-spec-007-pilot-right-rail/index.html` to point at the new directory.
3. Update `specs/CODEX-SPEC-015-Vendor-Leaflet-Library.md` with the new SHA-256 hashes and bump the version note.
4. Old version stays on disk as a rollback point until deliberately deleted.

No npm / no package.json — Leaflet is the only third-party JS dependency in the prototype, and it's vendored exactly once.
