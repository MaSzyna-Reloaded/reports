// Report API version 1 - builds before the report went as one JSON part: the text fields
// "api_version", "title", "description", "build", "scenery", "vehicle" and the file "attachments"
// (report.zip). No screenshot, branch, hardware or settings. Its builds name no version in Accept:
// a request that names none is taken as this one.
//
// Frozen: the builds that send it are out, so nothing here changes with a newer version - the
// whole request, from the fields to the issue, is this file's own. test/api.test.js holds its
// issues as they are.

import { answer } from "../shared/http.js";
import { assetName, connect } from "../shared/github.js";

export const API_VERSION = "1";
// "branch" is no field of version 1: in the issue "-", in its report.json "" - as it has been
const FIELDS = ["title", "description", "build", "branch", "scenery", "vehicle"];
// GitHub refuses an issue body over 65536 characters; the description goes into it twice (as
// written and in report.json), everything else is short
const MAX_DESCRIPTION_CHARS = 25000;
const MAX_TITLE_CHARS = 256;

// A request of version 1: its "api_version" is API_VERSION, or it has none - a report of fields
// that does not say its version is of the first one
export function isOf(form) {
    return !form.has("report") && [API_VERSION, null].includes(form.get("api_version"));
}

// The Worker's answer to a request of version 1
export async function handle(form, env) {
    const attachments = form.get("attachments");
    if (!(attachments instanceof File) || attachments.size === 0) {
        return answer(400, { error: "attachments missing" });
    }
    // each field's first value
    const report = {};
    for (const field of FIELDS) {
        report[field] = String(form.get(field) ?? "").replace(/\r\n/g, "\n").trim();
    }
    if (!report.description) {
        return answer(400, { error: "description empty" });
    }
    if (report.description.length > MAX_DESCRIPTION_CHARS) {
        report.description = report.description.slice(0, MAX_DESCRIPTION_CHARS) + "\n[... truncated]";
    }

    try {
        const github = await connect(env);
        const release = await github.monthRelease(new Date());
        const asset = await github.uploadAsset(release, `${assetName(report.build)}.zip`, "application/zip", attachments);
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
        `| Build | ${code(report.build)} |`,
        "| Branch | - |",
        `| Scenery | ${report.scenery ? code(report.scenery) : "-"} |`,
        `| Vehicle | ${report.vehicle ? code(report.vehicle) : "-"} |`,
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
