# Legacy one-shot patch scripts

These are the migration/patch scripts that were used to build up the project by
rewriting source files with regex replacements. They are kept only for reference.

**Do not run them.** Each one overwrites files under `local-agent/src/` or
`desktop/` with hardcoded content that is now out of date; running any of them
will revert current fixes. They are safe to delete once you no longer want the
history.
