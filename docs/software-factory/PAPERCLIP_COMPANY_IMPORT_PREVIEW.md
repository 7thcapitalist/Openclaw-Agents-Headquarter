# Agent Companies import preview

Adapted from Paperclip's `company-portability` and `company-import-transfers`
services at pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT.
See `factory/third-party/provenance.json`. Issue #124.

```
package -> lint -> parse -> normalize -> sanitized preview -> proposed diff
```

## Every step is read-only

This module opens files under the package directory and reads HQ's registries.
It writes **nothing** — not a registry, not a prompt, not configuration, not
runtime state — and exports **no function that could**. A test asserts the
entire export surface is `previewAgentCompanyImport`, because an import module
that can apply is one that will eventually apply something nobody reviewed.

What comes out is a **proposal**. Turning it into reality is an ordinary pull
request against `factory/agents.json` and `factory/projects.json`, reviewed and
merged by a human like any other change. That is the point of keeping HQ's
registries in Git. There is deliberately no `--apply`.

## Lint gates the diff

A package that fails `lintAgentCompanyPackage` is **not parsed at all**.
Producing a diff from content already known to be malformed or secret-bearing
would put exactly the wrong thing in front of a reviewer. The findings are still
returned in full — they are the useful part.

## The diff

| Bucket | Meaning |
| --- | --- |
| `added` | No agent/project with that id or key exists in HQ |
| `changed` | Exists, with **field-level** current-vs-proposed values |
| `unchanged` | Exists and matches |
| `conflicts` | Something that cannot be applied coherently |

Changes are field-level rather than whole-record, so a reviewer sees *"role:
Review → Independent review"* rather than "reviewer differs".

**Reporting lines are checked.** A `reportsTo` naming something that exists in
neither the package nor HQ is a conflict, not an imported dangling reference —
it is the part of a company package most likely to break quietly. A parent
supplied by the package itself, or `founder`, is fine.

## What is read, and what is not

- Only known fields are extracted. Unrecognised frontmatter keys never reach the
  diff, so a package cannot smuggle arbitrary keys into something a human is
  meant to trust.
- **A symlink is never followed.** A symlinked `COMPANY.md` pointing at
  `~/.ssh` would otherwise be read and diffed.
- Files over 1MB are skipped; text is scrubbed, stripped of `<`/`>`, and bounded
  to 500 characters.
- An HQ registry that cannot be read makes every package entry look **new** —
  the safe direction for a preview, which over-reports additions rather than
  silently claiming something already exists.

## Using it

```
npm run company:preview-import -- ./some-company-package
```

Exit code 1 means the package was rejected by linting; 2 means the preview
itself could not run. The full report prints either way.

## Rollback

Revert the PR. Nothing was ever written, so there is nothing to undo.
