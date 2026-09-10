# Paperclip Agent Companies Exporter

The sanitized HQ exporter adapts Paperclip's Agent Companies package format at
commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` (MIT, Copyright 2025 Paperclip AI):

https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/docs/companies/companies-spec.md

It emits company, project, agent, and skill Markdown plus a hash/omission
manifest into an explicitly supplied empty output directory. Credentials,
runtime/session state, private memory, logs, outputs, absolute paths, unsupported
structured fields, and secret-shaped strings are omitted. Repository context
remains canonical. The linter from issue #86 is injected at the seam after that
dependency merges.

Central provenance registration is required during pre-merge refresh after #79.

## Rollback

Revert the PR. The exporter only ever writes into an output directory an
operator names, so reverting removes the command and leaves any previously
exported package where it is — delete it by hand if it is no longer wanted.
Nothing in HQ reads an exported package.
