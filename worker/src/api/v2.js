// Report API version 2: the part "report" (application/json) - "api_version", "title",
// "description", "build", "branch", "scenery", "vehicle", and the snapshot's sections "hardware"
// and "settings" as objects - then the file "attachments" (report.zip) and the file "screenshot"
// (screenshot.jpg, when attached). A client of version 2 names it in Accept
// (shared/negotiation.js) - a request that does not is taken as version 1.
//
// The whole request, from the part to the issue, is this file's own: a change here changes no
// other version's issues. test/api.test.js holds its issues as they are.

import { answer } from "../shared/http.js";
import { assetName, connect } from "../shared/github.js";

export const API_VERSION = 2;
const FIELDS = ["title", "description", "build", "branch", "scenery", "vehicle"];
// The snapshot's sections the report carries, shown in the issue rather than in its report.json
const SECTIONS = ["hardware", "settings"];
// GitHub refuses an issue body over 65536 characters; the description goes into it twice (as
// written and in report.json), the settings' table up to MAX_SETTINGS_TABLE_CHARS, everything else
// is short
const MAX_DESCRIPTION_CHARS = 25000;
const MAX_SETTINGS_TABLE_CHARS = 12000;
const MAX_TITLE_CHARS = 256;
const BYTES_PER_GIB = 1024 ** 3;

// A request of version 2: it has the part "report" - its "api_version" is checked by handle
export function isOf(form) {
    return form.has("report");
}

// The Worker's answer to a request of version 2 - null when the part "report" is not a JSON
// object of API_VERSION
export async function handle(form, env) {
    const sent = await sentReport(form);
    if (!sent) {
        return null;
    }
    const attachments = form.get("attachments");
    if (!(attachments instanceof File) || attachments.size === 0) {
        return answer(400, { error: "attachments missing" });
    }
    const report = {};
    for (const field of FIELDS) {
        report[field] = String(sent[field] ?? "").replace(/\r\n/g, "\n").trim();
    }
    if (!report.description) {
        return answer(400, { error: "description empty" });
    }
    if (report.description.length > MAX_DESCRIPTION_CHARS) {
        report.description = report.description.slice(0, MAX_DESCRIPTION_CHARS) + "\n[... truncated]";
    }
    // what is not an object is left out of the issue - the archive has it anyway
    const sections = {};
    for (const section of SECTIONS) {
        sections[section] = isObject(sent[section]) ? sent[section] : null;
    }
    const screenshot = form.get("screenshot");

    try {
        const github = await connect(env);
        const release = await github.monthRelease(new Date());
        const name = assetName(report.build);
        const assets = [await github.uploadAsset(release, `${name}.zip`, "application/zip", attachments)];
        let issue;
        try {
            if (screenshot instanceof File && screenshot.size > 0) {
                assets.push(await github.uploadAsset(release, `${name}.jpg`, "image/jpeg", screenshot));
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
}

// The part "report" as an object - null when it is not JSON of API_VERSION. The part is text, or a
// file when it was sent as one (curl -F report=@report.json)
async function sentReport(form) {
    const part = form.get("report");
    let report;
    try {
        report = JSON.parse(part instanceof File ? await part.text() : part);
    } catch {
        return null;
    }
    return isObject(report) && report.api_version === API_VERSION ? report : null;
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
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
        `| Branch | ${report.branch ? code(report.branch) : "-"} |`,
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
        ["`user://` available disk space", [hardware.disk_space_left >= 0 && gib(hardware.disk_space_left)]],
        ["GPU", [hardware.gpu, hardware.gpu_type]],
        ["GPU driver", [hardware.gpu_driver]],
        ["Rendering", [hardware.rendering_method, hardware.rendering_driver, hardware.graphics_api_version]],
        ["Screen", [hardware.screen_size && hardware.screen_size.join("x"), hardware.window_mode]],
        ["Godot", [hardware.godot]],
    ];
    return rows
        .map(([name, parts]) => [name, parts.filter(Boolean).map(String).join(", ")])
        .filter(([, value]) => value)
        .map(([name, value]) => `| ${name} | ${cell(value)} |`);
}

// Bytes as GiB, one decimal
function gib(bytes) {
    return `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`;
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

// Text in a table's cell: no line break or "|" of its own, and no "@name" notifying a GitHub user
function cell(text) {
    return String(text).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").replace(/@/g, "@\u200b");
}

// A text of the game's as an inline code span of a table cell: its fence longer than any run of
// backticks in it, so the text cannot close it and write markdown - or an "@name" - of its own
function code(text) {
    const value = cell(text);
    const fence = "`".repeat(longestBacktickRun(value) + 1);
    const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
    return `${fence}${padding}${value}${padding}${fence}`;
}

function longestBacktickRun(text) {
    return Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
}
