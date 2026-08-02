# Contributing

Contributions are welcome.

1. Create a focused branch.
2. Add a failing behavior test first.
3. Implement the smallest change that passes it.
4. Run the release gate:

   ```bash
   npm run check
   npm run build
   npm run smoke
   npm pack --dry-run
   ```

5. Explain security-boundary changes explicitly in the pull request.

Never add real project refs, vault paths, database URLs, tokens, keys, or
captured command output to fixtures. Tests must use temporary local storage and
must not contact Supabase.

