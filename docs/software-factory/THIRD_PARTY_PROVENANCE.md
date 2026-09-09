# Third-Party Code Provenance

Every copied, adapted, inspired-by, or reference-only third-party artifact is
recorded in `factory/third-party/provenance.json`. The manifest pins upstream
repositories to full commits and points to preserved license notices.

## Classifications

- `copied`: substantially identical source or fixture content.
- `adapted`: source structure or implementation was modified for HQ.
- `inspired`: behavior or design was reimplemented without copying source.
- `reference`: the local artifact analyzes upstream material without its code.

Before committing a third-party-derived artifact, add one manifest entry per
local file with its exact upstream path and adaptation notes. Preserve the
upstream license notice and separately review bundled assets and dependencies.
Run `npm run check:provenance` and `npm run test:factory`.

The manifest must never contain credentials, private runtime paths, moving
branch references, or personal/generated OpenClaw data. Validation is a
compliance record, not a security or quality endorsement.
