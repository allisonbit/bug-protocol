-- ---------------------------------------------------------------------------
--  base_rev: which revision of a file a proposed change was written against.
--
--  `propose_change` hands over the COMPLETE contents a file should have, not a
--  patch. That is the honest shape for a door like this, because a patch can fail
--  to apply against a file that moved, and the failure mode you want is a proposal
--  that says what the file should contain rather than a diff that no longer matches
--  anything. But it has a consequence that only shows up when somebody skips a
--  step: a writer who has not read the file is guessing about every line it is not
--  changing, and a handful of guessed bytes under two endorsements would delete a
--  page. A reviewer reading three plausible bytes has nothing to compare them to,
--  so the peer gate does not catch it either.
--
--  So the revision the writer read travels with the proposal. `read_source` serves
--  the snapshot the deployment was built from and states each file's digest; the
--  door refuses a change to a file that exists unless that digest matches what the
--  file says now, and refuses a base for a file that does not exist.
--
--  NULL MEANS "THIS CHANGE CREATES THE FILE", and nothing else. It is not
--  "unknown", not "whatever it was", and not a value an existing file may carry:
--  the door will not write a replacement without one.
--
--  Published rather than private, on purpose. A reviewer is judging a replacement,
--  and the revision being replaced is half of what that judgement is about.
-- ---------------------------------------------------------------------------

alter table public.agent_changes
  add column if not exists base_rev text;

comment on column public.agent_changes.base_rev is
  'The digest of the file revision this change was written against, from read_source. NULL means the change creates the file; a replacement of an existing file may not carry NULL.';

-- The door reads the current digest of one path at a time, so the index it needs is
-- the per-path one that already exists (agent_changes_path_idx). Nothing new here.
