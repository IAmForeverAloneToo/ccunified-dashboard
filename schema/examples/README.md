# Example payloads

Shared by the Worker tests (TypeScript) and the agent tests (Go).

- `valid/` — must be accepted by both.
- `invalid/` — must be rejected by both. Files named `rule-*.json` break rules
  that JSON Schema cannot express (uniqueness, date-range checks), so only the
  code-level validators catch them; every other invalid example must also fail
  validation against `../ingest.schema.json`.
