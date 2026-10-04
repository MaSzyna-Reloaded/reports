// Opens a GitHub issue from a MaSzyna Reloaded problem report.
//
// The request is the game's report API, version API_VERSION - the contract is
// docs/bug-reports.md in MaSzyna-API-wrapper: one multipart/form-data POST with the text fields
// "api_version", "title", "description", "build", "scenery", "vehicle" and the file
// "attachments" (report.zip). The zip becomes an asset of this month's release of REPORTS_REPO,
// the issue links it, and the answer is {"issue_url": ...}.

const API_VERSION = "1";
const FIELDS = ["title", "description", "build", "scenery", "vehicle"];
const GITHUB_API = "https://api.github.com";
const GITHUB_UPLOADS = "https://uploads.github.com";
const USER_AGENT = "maszyna-reloaded-reports";
const ISSUE_LABEL = "player-report";
// GitHub accepts an app's JWT for 10 minutes at most; issued a minute back against clock drift
const APP_JWT_LIFETIME_SECONDS = 540;
const APP_JWT_CLOCK_DRIFT_SECONDS = 60;
// The archive: a snapshot of a few MB and a log of up to 4 MB pack small, a JPEG of a few
// hundred kB - docs/bug-reports.md, "Limit abuse"
const MAX_REQUEST_BYTES = 25 * 1024 * 1024;
// GitHub refuses an issue body over 65536 characters; the description goes into it twice (as
// written and in report.json), everything else is short
const MAX_DESCRIPTION_CHARS = 25000;
const MAX_TITLE_CHARS = 256;
const HTTP_NOT_FOUND = 404;
// What GitHub answers when a release with the tag was created in the meantime
const HTTP_UNPROCESSABLE = 422;

export default {
    async fetch(request, env) {
        if (request.method !== "POST") {
            return answer(405, { error: "POST only" });
        }
        if (Number(request.headers.get("Content-Length") || 0) > MAX_REQUEST_BYTES) {
            return answer(413, { error: "report too large" });
        }
        const address = request.headers.get("CF-Connecting-IP") || "";
        const { success } = await env.REPORT_LIMITER.limit({ key: address });
        if (!success) {
            return answer(429, { error: "too many reports, try again later" });
        }

        let form;
        try {
            form = await request.formData();
        } catch {
            return answer(400, { error: "not multipart/form-data" });
        }
        if (form.get("api_version") !== API_VERSION) {
            return answer(400, { error: `unknown api_version, expected ${API_VERSION}` });
        }
        const attachments = form.get("attachments");
        if (!(attachments instanceof File) || attachments.size === 0) {
            return answer(400, { error: "attachments missing" });
        }
        const report = {};
        for (const field of FIELDS) {
            report[field] = String(form.get(field) || "").replace(/\r\n/g, "\n").trim();
        }
        if (!report.description) {
            return answer(400, { error: "description empty" });
        }
        if (report.description.length > MAX_DESCRIPTION_CHARS) {
            report.description = report.description.slice(0, MAX_DESCRIPTION_CHARS) + "\n[... truncated]";
        }

        try {
            const github = new GitHub(await installationToken(env), env.REPORTS_REPO);
            const release = await github.monthRelease(new Date());
            const asset = await github.uploadAsset(release, assetName(report.build), attachments);
            let issue;
            try {
                issue = await github.createIssue(
                    report.title.slice(0, MAX_TITLE_CHARS) || report.description.split("\n")[0],
                    issueBody(report, asset.browser_download_url));
            } catch (error) {
                // no zip without an issue that links it
                await github.deleteAsset(asset);
                throw error;
            }
            return answer(201, { issue_url: issue.html_url });
        } catch (error) {
            console.error(String(error));
            // the game keeps the form open, so the player can send it again
            return answer(502, { error: "the issue could not be opened" });
        }
    },
};

// A token of the GitHub App's installation on REPORTS_REPO, valid for an hour: the app signs a
// JWT with its private key and exchanges it - the issues are then the app's ("<app>[bot]")
async function installationToken(env) {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({
        iat: now - APP_JWT_CLOCK_DRIFT_SECONDS,
        exp: now + APP_JWT_LIFETIME_SECONDS,
        iss: env.GITHUB_APP_ID,
    }))}`;
    // GITHUB_APP_PRIVATE_KEY: the app's key as PKCS#8 PEM - GitHub gives PKCS#1, Web Crypto takes
    // only PKCS#8 (openssl pkcs8 -topk8 -nocrypt)
    const der = Uint8Array.from(
        atob(env.GITHUB_APP_PRIVATE_KEY.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
        "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    const response = await fetch(
        `${GITHUB_API}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
            method: "POST",
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${unsigned}.${base64Url(signature)}`,
                "User-Agent": USER_AGENT,
            },
        });
    if (!response.ok) {
        throw new Error(`installation token: HTTP ${response.status} ${await response.text()}`);
    }
    return (await response.json()).token;
}

// Base64url of a string (UTF-8) or of bytes
function base64Url(data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function answer(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
    });
}

// <build>_<UTC time>_<random>.zip - unique within the release
function assetName(build) {
    const safeBuild = build.replace(/[^A-Za-z0-9._-]/g, "") || "unknown";
    const time = new Date().toISOString().replace(/[:.]/g, "-");
    return `${safeBuild}_${time}_${crypto.randomUUID().slice(0, 8)}.zip`;
}

function issueBody(report, archiveUrl) {
    // A public issue: an "@name" in what the player wrote would notify that GitHub user
    const quoted = report.description
        .replace(/@/g, "@​")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    const json = JSON.stringify(report, null, 2);
    const fence = "`".repeat(Math.max(3, longestBacktickRun(json) + 1));
    return [
        quoted,
        "",
        "| | |",
        "|---|---|",
        `| Build | \`${report.build}\` |`,
        `| Scenery | ${report.scenery ? `\`${report.scenery}\`` : "-"} |`,
        `| Vehicle | ${report.vehicle ? `\`${report.vehicle}\`` : "-"} |`,
        "",
        `**Attachments:** [report.zip](${archiveUrl}) - \`snapshot.json\`, and \`screenshot.jpg\`, \`app.log\` when attached`,
        "",
        "<details><summary>report.json</summary>",
        "",
        `${fence}json`,
        json,
        fence,
        "",
        "</details>",
    ].join("\n");
}

function longestBacktickRun(text) {
    return Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
}

class GitHub {
    constructor(token, repo) {
        this.token = token;
        this.repo = repo;
    }

    call(url, init = {}) {
        return fetch(url, {
            ...init,
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${this.token}`,
                "User-Agent": USER_AGENT,
                "X-GitHub-Api-Version": "2022-11-28",
                ...init.headers,
            },
        });
    }

    async json(response, what) {
        if (!response.ok) {
            throw new Error(`${what}: HTTP ${response.status} ${await response.text()}`);
        }
        return response.json();
    }

    // One release per month (reports-YYYY-MM), created by its first report - a release holds a
    // limited number of assets
    async monthRelease(now) {
        const tag = `reports-${now.toISOString().slice(0, 7)}`;
        const url = `${GITHUB_API}/repos/${this.repo}/releases/tags/${tag}`;
        const found = await this.call(url);
        if (found.status !== HTTP_NOT_FOUND) {
            return this.json(found, "release");
        }
        const created = await this.call(`${GITHUB_API}/repos/${this.repo}/releases`, {
            method: "POST",
            body: JSON.stringify({
                tag_name: tag,
                name: `Problem reports ${tag.slice("reports-".length)}`,
                body: "Archives of the problem reports sent from the game this month.",
            }),
        });
        if (created.status === HTTP_UNPROCESSABLE) {
            // another report created it between the two calls
            return this.json(await this.call(url), "release");
        }
        return this.json(created, "release create");
    }

    async uploadAsset(release, name, file) {
        const url = `${GITHUB_UPLOADS}/repos/${this.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
        return this.json(await this.call(url, {
            method: "POST",
            headers: { "Content-Type": "application/zip" },
            // a Blob, not a stream: GitHub wants the Content-Length
            body: file,
        }), "asset upload");
    }

    async deleteAsset(asset) {
        await this.call(`${GITHUB_API}/repos/${this.repo}/releases/assets/${asset.id}`, { method: "DELETE" });
    }

    async createIssue(title, body) {
        return this.json(await this.call(`${GITHUB_API}/repos/${this.repo}/issues`, {
            method: "POST",
            body: JSON.stringify({ title, body, labels: [ISSUE_LABEL] }),
        }), "issue create");
    }
}
