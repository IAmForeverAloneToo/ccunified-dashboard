# Example payloads

Shared by the Worker tests (TypeScript) and the agent tests (Go).

- `valid/` — must be accepted by both.
- `invalid/` — must be rejected by both. Files named `rule-*.json` break rules
  that JSON Schema cannot express (uniqueness, date-range checks), so only the
  code-level validators catch them; every other invalid example must also fail
  validation against `../ingest.schema.json`.

Files starting with `v2-` (or `rule-v2-`) use upload format 2, which carries
usage from every tool ccusage reads; the others use format 1 (Claude Code only,
sent by ccunified 0.1), which the dashboard still accepts.
