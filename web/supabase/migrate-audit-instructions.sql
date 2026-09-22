-- Widen the audits kind constraint to admit instruction documents.
--
-- WHY THIS IS A MIGRATION AND NOT A CODE CHANGE. The kind column was constrained to the
-- two shapes the engine could read when the table was created. Adding a third shape to the
-- code alone fails at insert, which is exactly what happened the first time an AGENTS.md
-- was submitted: the engine produced a verdict and the record was refused by a check
-- constraint, so the audit existed nowhere. A verdict that cannot be recorded is a verdict
-- nobody can check, and the constraint is the thing that decides what can.

alter table audits drop constraint if exists audits_kind_check;

alter table audits
  add constraint audits_kind_check
  check (kind in ('skill', 'mcp-server', 'instructions'));

comment on constraint audits_kind_check on audits is
  'The three shapes this deployment reads: a SKILL.md, an MCP server card or tool catalogue, and an agent instruction document such as AGENTS.md, CLAUDE.md or a rules directory. The third was added once the engine could read it, because a conventions file steers an agent exactly as a skill does and is often edited in a pull request nobody reads.';
