# Process Improvements

Recommendations about how the factory *works*: role prompts, routing, pipeline
gates, task intake, decision protocol, and evaluation criteria.

Maintained by the Learning / R&D Agent; promoted by the founder. A change to a
role prompt, `factory.config.json`, or `OPERATING_RULES.md` is scaffolded as a
low-risk factory task and goes through independent review and human merge — the
Learning Agent never edits those files directly.

Example of the kind of entry this file holds:

> Codex builders frequently fail because requirements are ambiguous.
> Recommendation: require the product stage to create executable acceptance
> tests before implementation, and add an `acceptance-tests-present` check to
> `requiredGates`.

See `README.md` for the entry format.

<!-- Learning Agent appends entries below this line. -->
