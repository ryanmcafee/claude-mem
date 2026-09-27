# Architecture Decision Records

Every decision that crosses a service or trust boundary is recorded here before it is
considered made. A record is complete when a stranger can read the context, the options
considered, the decision, and its consequences, and defend the decision without the author
in the room.

Conventions:

- Files are `NNNN-kebab-case-title.md`, numbered in the order they are accepted.
- Status is one of `proposed`, `accepted`, `superseded by NNNN`, or `rejected`.
- Superseding replaces; records are never edited to hide a decision that was actually taken.
- A record that changes a wire contract or a schema names its compatibility tests.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-remote-client-mode-and-shared-scope.md) | Remote client mode, API-key tenant binding, and an opt-in shared scope | accepted |
