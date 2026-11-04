// Opens a GitHub issue from a MaSzyna Reloaded problem report.
//
// The request is the game's report - the contract is docs/bug-reports.md in maszyna-reloaded: one
// multipart/form-data POST whose parts are told apart by their name and read by their Content-Type.
// There is no API version: a part a build does not send is left out of the issue, a part the
// Worker does not know is ignored, so every build's report is taken.
//   text/plain        "title", "description", "build", "branch", "scenery", "vehicle" (the old
//                     builds' "api_version" is ignored); a public release is named by its tag
//                     in "build" alone, with no "branch"
//   application/json  "hardware", "settings" - objects, shown in the issue; sent as files
//                     (filename="hardware.json"), as request.formData() keeps a part's
//                     Content-Type only then
//   application/zip   "attachments" (report.zip) - required
//   image/jpeg        "screenshot", when attached
// The zip and the screenshot become assets of this month's release of REPORTS_REPO, the issue links
// the zip and shows the screenshot, and the answer is {"issue_url": ...}.

const FIELDS = ["title", "description", "build", "branch", "scenery", "vehicle"];
// The JSON parts, objects - anything else in them is left out of the issue; the archive has it
const JSON_PARTS = ["hardware", "settings"];
const JSON_TYPE = "application/json";
// The screenshot's types, by the asset's extension
const SCREENSHOT_TYPES = { "image/jpeg": "jpg", "image/png": "png" };
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
// written and in report.json), the settings' table up to MAX_SETTINGS_TABLE_CHARS, everything else
// is short
const MAX_DESCRIPTION_CHARS = 25000;
const MAX_SETTINGS_TABLE_CHARS = 12000;
const MAX_TITLE_CHARS = 256;
const BYTES_PER_GIB = 1024 ** 3;
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
        const attachments = form.get("attachments");
        if (!(attachments instanceof File) || attachments.size === 0) {
            return answer(400, { error: "attachments missing" });
        }
        const report = {};
        for (const field of FIELDS) {
            report[field] = await text(form.get(field));
        }
        if (!report.description) {
            return answer(400, { error: "description empty" });
        }
        if (report.description.length > MAX_DESCRIPTION_CHARS) {
            report.description = report.description.slice(0, MAX_DESCRIPTION_CHARS) + "\n[... truncated]";
        }
        const sections = {};
        for (const name of JSON_PARTS) {
            sections[name] = await jsonObject(form.get(name));
        }
        const screenshot = form.get("screenshot");
        const screenshotExtension = screenshot instanceof File && screenshot.size > 0
            ? SCREENSHOT_TYPES[mediaType(screenshot.type)]
            : undefined;

        try {
            const github = new GitHub(await installationToken(env), env.REPORTS_REPO);
            const release = await github.monthRelease(new Date());
            const name = assetName(report.build);
            const assets = [await github.uploadAsset(release, `${name}.zip`, "application/zip", attachments)];
            let issue;
            try {
                if (screenshotExtension) {
                    assets.push(await github.uploadAsset(
                        release, `${name}.${screenshotExtension}`, mediaType(screenshot.type), screenshot));
                }
                issue = await github.createIssue(
                    report.title.slice(0, MAX_TITLE_CHARS) || report.description.split("\n")[0],
                    issueBody(report, sections, assets[0].browser_download_url, assets[1]?.browser_download_url));
            } catch (error) {
                // no asset without an issue that links it
                for (const asset of assets) {
                    await github.deleteAsset(asset);
                }
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

// A text part as text - a file's content too (curl -F title=@title.txt) -, "" when it is missing
async function text(part) {
    const value = part instanceof File ? await part.text() : (part ?? "");
    return String(value).replace(/\r\n/g, "\n").trim();
}

// A JSON part as an object - null when it is missing, not of JSON_TYPE or not a JSON object
async function jsonObject(part) {
    if (!(part instanceof File) || mediaType(part.type) !== JSON_TYPE) {
        return null;
    }
    try {
        const value = JSON.parse(await part.text());
        return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

// A Content-Type without its parameters, lowercase: "application/json; charset=utf-8" is
// "application/json"
function mediaType(contentType) {
    return String(contentType).split(";")[0].trim().toLowerCase();
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

function answer(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
    });
}

// <build>_<UTC time>_<random> - unique within the release; a report's assets share it
function assetName(build) {
    const safeBuild = build.replace(/[^A-Za-z0-9._-]/g, "") || "unknown";
    const time = new Date().toISOString().replace(/[:.]/g, "-");
    return `${safeBuild}_${time}_${crypto.randomUUID().slice(0, 8)}`;
}

function issueBody(report, sections, archiveUrl, screenshotUrl) {
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
        `| Build | ${code(report.build)} |`,
        ...(report.branch ? [`| Branch | ${code(report.branch)} |`] : []),
        `| Scenery | ${report.scenery ? code(report.scenery) : "-"} |`,
        `| Vehicle | ${report.vehicle ? code(report.vehicle) : "-"} |`,
        ...hardwareRows(sections.hardware),
        "",
        ...(screenshotUrl ? [`![screenshot](${screenshotUrl})`, ""] : []),
        `**Attachments:** [report.zip](${archiveUrl}) - \`snapshot.json\`, and \`screenshot.jpg\`, \`app.log\` when attached`,
        "",
        ...settingsDetails(sections.settings),
        "<details><summary>report.json</summary>",
        "",
        `${fence}json`,
        json,
        fence,
        "",
        "</details>",
    ].join("\n");
}

// The rows of the report's table that say what the game ran on - none for a report without them
function hardwareRows(hardware) {
    if (!hardware) {
        return [];
    }
    const ram = hardware.ram && hardware.ram.physical ? [
        gib(hardware.ram.physical),
        hardware.ram.available > 0 && `${gib(hardware.ram.available)} available`,
    ] : [];
    const rows = [
        ["OS", [hardware.distribution || hardware.os, hardware.os_version, hardware.architecture]],
        ["CPU", [hardware.cpu, hardware.cpu_threads && `${hardware.cpu_threads} threads`]],
        ["RAM", ram],
        ["<code>user://</code> available disk space", [hardware.disk_space_left >= 0 && gib(hardware.disk_space_left)]],
        ["GPU", [hardware.gpu, hardware.gpu_type]],
        ["GPU driver", [hardware.gpu_driver]],
        ["Rendering", [hardware.rendering_method, hardware.rendering_driver, hardware.graphics_api_version]],
        ["Screen", [Array.isArray(hardware.screen_size) && hardware.screen_size.join("x"), hardware.window_mode]],
        ["Godot", [hardware.godot]],
    ];
    return rows
        .map(([name, parts]) => [name, parts.filter(Boolean).map(String).join(", ")])
        .filter(([, value]) => value)
        .map(([name, value]) => `| ${name} | ${cell(value)} |`);
}

// Bytes as GiB, one decimal
function gib(bytes) {
    return `${(Number(bytes) / BYTES_PER_GIB).toFixed(1)} GiB`;
}

// The player's settings as a folded table, by their names - left out when they would take more of
// the body than MAX_SETTINGS_TABLE_CHARS
function settingsDetails(settings) {
    if (!settings) {
        return [];
    }
    const table = [
        "| Setting | Value |",
        "|---|---|",
        ...Object.entries(settings).map(([name, value]) => `| ${code(name)} | ${cell(JSON.stringify(value))} |`),
    ].join("\n");
    return [
        "<details><summary>Settings</summary>",
        "",
        table.length > MAX_SETTINGS_TABLE_CHARS ? "Too many to show here - `snapshot.json` in report.zip has them." : table,
        "",
        "</details>",
        "",
    ];
}

// A text of the game's in a table's cell, shown as it is: every ASCII punctuation character
// backslash-escaped - the backslash itself as well, so a "\" before a "|" cannot unescape it and
// end the cell -, no line break of its own, and no "@name" notifying a GitHub user
function cell(text) {
    return String(text)
        .replace(/\r?\n/g, " ")
        .replace(/[!-/:-@[-`{-~]/g, "\\$&")
        .replace(/@/g, "@​");
}

// The same text in monospace: <code> rather than a code span, whose backslashes are its own text -
// in it the escapes of cell() would show; between the tags they are read as escapes
function code(text) {
    return `<code>${cell(text)}</code>`;
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
