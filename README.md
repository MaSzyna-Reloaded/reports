# MaSzyna Reloaded - problem reports (`MaSzyna-Reloaded/reports`)

Problem reports sent from the game land here as issues (label `player-report`). Each report's
archive (`report.zip`: `snapshot.json`, and `screenshot.jpg`, `app.log` when attached) is an asset
of the month's release (`reports-YYYY-MM`), linked from the issue; the screenshot is an asset of
its own as well, shown in the issue with the build's branch, the hardware and the player's
settings.

`worker/` is the endpoint the game sends to - a Cloudflare Worker. What the game sends is
documented in maszyna-reloaded, `docs/bug-reports.md`: one `multipart/form-data` POST whose parts
the Worker reads by their `Content-Type` - text fields `text/plain`, the hardware and the settings
`application/json`, the archive `application/zip`, the screenshot `image/jpeg`. There is no API
version: a part a build does not send is left out of the issue, so older builds' reports are
taken as they are.

`npm test` (in `worker/`) sends reports through the Worker, GitHub stood in for.

## Deploying the Worker

Needs Node.js 20 or newer and a free Cloudflare account.

1. A GitHub App of the organisation, without a webhook, with the repository permissions
   `Contents: Read and write` (release assets) and `Issues: Read and write`, installed on this
   repository only. Its App ID and the installation's ID go into `worker/wrangler.toml`
   (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`); the issues are opened as `<app>[bot]`.
   Its private key (Generate a private key) is PKCS#1, Web Crypto takes PKCS#8:
   ```bash
   openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
   ```
2. ```bash
   cd worker
   npm install
   npx wrangler login
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem
   npx wrangler deploy
   ```
   The deploy prints the address (`https://maszyna-reloaded-reports.<account>.workers.dev`); it
   goes into the game's Project Setting `maszyna/bugtracking/endpoint`.

The repository must have at least one commit - a release's tag is made on the default branch.

## Testing locally

```bash
cd worker
# .dev.vars (ignored by git): GITHUB_APP_PRIVATE_KEY="<the PKCS#8 PEM, newlines as \n>"
npx wrangler dev
```

Then send a report the game saved locally (endpoint `user://bug_reports`, on Linux
`~/.local/share/MaSzyna-Reloaded/bug_reports/<time>/`), with `screenshot.jpg` taken out of its
`report.zip`:

```bash
curl -F 'title=[test] a title' -F 'description=a test' -F build=test -F branch=main \
     -F 'hardware=@hardware.json;type=application/json' \
     -F 'settings=@settings.json;type=application/json' \
     -F 'attachments=@report.zip;type=application/zip' \
     -F 'screenshot=@screenshot.jpg;type=image/jpeg' \
     http://localhost:8787/
```

The answer is `201 {"issue_url": ...}`; 400 for a request of another shape, 413 over 25 MB, 429
over 5 reports a minute from one address, 502 when GitHub refused (the game then keeps the form
open). CPU time per request is in the Cloudflare dashboard (Workers - Observability); the free
plan allows 10 ms.
