// GitHub for every report API version: the app's token, the month's release, its assets and the
// issues. Nothing here knows what a report holds or how its issue looks - that is each version's
// own, in api/; what changes here changes every version, test/api.test.js shows it.

const GITHUB_API = "https://api.github.com";
const GITHUB_UPLOADS = "https://uploads.github.com";
const USER_AGENT = "maszyna-reloaded-reports";
const ISSUE_LABEL = "player-report";
// GitHub accepts an app's JWT for 10 minutes at most; issued a minute back against clock drift
const APP_JWT_LIFETIME_SECONDS = 540;
const APP_JWT_CLOCK_DRIFT_SECONDS = 60;
const HTTP_NOT_FOUND = 404;
// What GitHub answers when a release with the tag was created in the meantime
const HTTP_UNPROCESSABLE = 422;

// GitHub as the app's installation on REPORTS_REPO
export async function connect(env) {
    return new GitHub(await installationToken(env), env.REPORTS_REPO);
}

// <build>_<UTC time>_<random> - unique within the release; a report's assets share it
export function assetName(build) {
    const safeBuild = build.replace(/[^A-Za-z0-9._-]/g, "") || "unknown";
    const time = new Date().toISOString().replace(/[:.]/g, "-");
    return `${safeBuild}_${time}_${crypto.randomUUID().slice(0, 8)}`;
}

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

    async uploadAsset(release, name, contentType, file) {
        const url = `${GITHUB_UPLOADS}/repos/${this.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
        return this.json(await this.call(url, {
            method: "POST",
            headers: { "Content-Type": contentType },
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
