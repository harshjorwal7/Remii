# Agent Notes

- Composio search and all other Composio tools are already configured for every user (workbench, sandbox, tool search, and the rest). Do not re-add or re-wire them per user; assume the per-user session path in `server/src/plugins/composio-adapter.ts` is live.
- Multiple agents are working in this repo concurrently. Before editing, check `git status`/file mtime and scope changes narrowly; do not revert or overwrite other agents' edits.
