# MaSzyna Reloaded - problem reports (`MaSzyna-Reloaded/reports`)

Problem reports sent from the game land here as issues (label `player-report`). Each report's
archive (`report.zip`: `snapshot.json`, and `screenshot.jpg`, `app.log` when attached) is an asset
of the month's release (`reports-YYYY-MM`), linked from the issue; the screenshot is an asset of
its own as well, shown in the issue with the build's branch, the hardware and the player's
settings.

`worker/` is the endpoint the game sends to - a Cloudflare Worker. What the game sends is
documented in maszyna-reloaded, `docs/bug-reports.md`; the Worker takes report API versions 1 and
2.

Each version is a module of its own in `worker/src/api/` - its fields, checks and issue, all of
it: a change to one version cannot change another's issues. `src/index.js` only picks the version;
`src/shared/` is what every version uses and that knows nothing of a report (GitHub, the answer).
A new version is a new module, put first in `API_VERSIONS`; an old one is not touched.

The version a request is of is told by the `Content-Type` of its parts:

| Parts | Version |
|---|---|
| `text/plain` fields (or fields without a `Content-Type`), no part `application/json` | 1 - the old format, with `api_version=1` or without one |
| a part `application/json` | 2 - the JSON format |
| a part `application/json; version=X` | X |

A version not offered, or a request not of the version it is told to be, is `400`. The Worker reads
the multipart body itself (`src/shared/multipart.js`): `request.formData()` drops the
`Content-Type` of a part without a filename, and the game's part `report` has none.

`npm test` (in `worker/`) sends a set of reports of every version through the Worker, GitHub
stood in for, and compares what it answers and sends to GitHub with `worker/test/expected/`. A
change meant to show in the issues: `UPDATE_EXPECTED=1 npm test`, then only that version's files
in `test/expected/` may change.

## Deploying the Worker

Needs Node.js 22 or newer (wrangler) and a free Cloudflare account.

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

Then send a report the game saved locally, with `screenshot.jpg` taken out of its `report.zip`
(endpoint `user://bug_reports`, on Linux
`~/.local/share/MaSzyna-Reloaded/bug_reports/<time>/`):

```bash
curl -F 'report=@report.json;type=application/json' \
     -F 'attachments=@report.zip;type=application/zip' \
     -F 'screenshot=@screenshot.jpg;type=image/jpeg' \
     http://localhost:8787/
```

The answer is `201 {"issue_url": ...}`; 400 for a request of another shape, 413 over 25 MB, 429
over 5 reports a minute from one address, 502 when GitHub refused (the game then keeps the form
open). CPU time per request is in the Cloudflare dashboard (Workers - Observability); the free
plan allows 10 ms.
