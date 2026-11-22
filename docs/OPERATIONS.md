# Operations and edge cases

## Authentication / browser profile

- Profile missing: run `npm run auth:setup`; profile data stays under `.local/`.
- Profile corrupted or locked: close all Chromium processes using this profile, back up the folder, then rename it and run setup again.
- Session expired: sign in manually through the visible browser. Do not replay copied cookies or attempt session renewal outside supported interfaces.
- MFA / CAPTCHA / suspicious-login challenge: complete it manually; do not automate or bypass it.
- Browser update mismatch: run `npx playwright install chromium`.
- Concurrent runs: never launch two jobs against the same persistent profile; Chromium profile locks can corrupt state.
- Headless: not enabled for X website access. Do not treat headless mode as a way around platform controls.

## Import pipeline

- Duplicate IDs: ignored across prior output and current batch.
- Username case / leading @: normalized.
- Invalid timestamps or URLs: reported with row number and skipped.
- Disabled competitor: filtered out.
- Empty competitor configuration: ingestion stops rather than accidentally importing all accounts.
- Partial input: valid rows are ingested; invalid rows are summarized and cause a non-zero exit code.
- Schema drift: keep versioned fixture files and tests; don't silently coerce unknown fields.
- Large input: split files into bounded batches; rotate output files by date when scale requires it.
- Timestamp ambiguity: accept only parseable ISO-compatible source timestamps; retain original source data separately if auditability matters.
- Data loss: back up output files and use append-only ingestion; do not overwrite raw exports.

## Operational safeguards

- Use only sources and fields you are authorized to collect.
- Store raw input under local ignored folders and restrict filesystem access.
- Add retention limits and deletion workflows before production use.
- Record source, import time, and processing errors.
- Respect provider pagination, quotas, and permitted-use restrictions.
