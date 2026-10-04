# MaSzyna Reloaded - problem reports (`MaSzyna-Reloaded/reports`)

Problem reports sent from the game land here as issues (label `player-report`). Each report's
archive (`report.zip`: `snapshot.json`, and `screenshot.jpg`, `app.log` when attached) is an asset
of the month's release (`reports-YYYY-MM`), linked from the issue.

`worker/` is the endpoint the game sends to - a Cloudflare Worker. What the game sends is
documented in MaSzyna-API-wrapper, `docs/bug-reports.md`.

## Deploying the Worker

Needs Node.js 20 or newer and a free Cloudflare account.

1. A fine-grained personal access token (GitHub, Settings - Developer settings), **only this
   repository**, permissions `Issues: Read and write` and `Contents: Read and write` (release
   assets). It expires - note the date and renew it before then.
2. ```bash
   cd worker
   npm install
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler deploy
   ```
   The deploy prints the address (`https://maszyna-reloaded-reports.<account>.workers.dev`); it
   goes into the game's Project Setting `maszyna/bugtracking/endpoint`.

The repository must have at least one commit - a release's tag is made on the default branch.

## Testing locally

```bash
cd worker
echo 'GITHUB_TOKEN=<token>' > .dev.vars   # ignored by git
npx wrangler dev
```

Then send a report the game saved locally (endpoint `user://bug_reports`, on Linux
`~/.local/share/MaSzyna-Reloaded/bug_reports/<time>/`):

```bash
curl -F api_version=1 -F 'title=[test] a title' -F 'description=a test' -F build=test \
     -F scenery= -F vehicle= \
     -F 'attachments=@report.zip;type=application/zip' \
     http://localhost:8787/
```

The answer is `201 {"issue_url": ...}`; 400 for a request of another shape, 413 over 25 MB, 429
over 5 reports a minute from one address, 502 when GitHub refused (the game then keeps the form
open). CPU time per request is in the Cloudflare dashboard (Workers - Observability); the free
plan allows 10 ms.
