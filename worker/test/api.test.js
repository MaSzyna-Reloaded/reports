// Every report API version, end to end: a request through the Worker's fetch, GitHub answered by a
// stand-in. What the Worker answers and what it sends to GitHub - the issue's title, body and
// labels, the assets' types - must equal test/expected/<case>.json: a change to one version that
// would change another's issues fails here.
//
// npm test; UPDATE_EXPECTED=1 npm test writes test/expected/ anew - for a change meant to be seen,
// in the version it is meant for only.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";

const worker = (await import(process.env.WORKER_ENTRY || "../src/index.js")).default;
const EXPECTED = new URL("./expected/", import.meta.url);
const ENDPOINT = "https://reports.test/";
// The game's boundary: MaSzynaReport and a number
const BOUNDARY = "MaSzynaReport1849302847";

const ZIP = "PK zip";
const JPEG = "JPEG";

// A part of a request: its name, its content (text or bytes), its Content-Type - none when null,
// as curl -F sends a text field - and its filename, none when undefined
const part = (name, content, type, filename) => ({ name, content, type, filename });
const zip = (content = ZIP) => part("attachments", content, "application/zip", "report.zip");
const jpeg = () => part("screenshot", JPEG, "image/jpeg", "screenshot.jpg");

// The multipart/form-data request of the parts, as the game builds it (bug_report_sender.gd)
function multipart(parts) {
    const chunks = [];
    for (const { name, content, type, filename } of parts) {
        const disposition = `form-data; name="${name}"${filename === undefined ? "" : `; filename="${filename}"`}`;
        chunks.push(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n`
            + (type === null ? "" : `Content-Type: ${type}\r\n`) + "\r\n");
        chunks.push(content, "\r\n");
    }
    chunks.push(`--${BOUNDARY}--\r\n`);
    return { body: new Blob(chunks), contentType: `multipart/form-data; boundary=${BOUNDARY}` };
}

// Version 1: the fields as the game sends them, text/plain - a fieldType of null as curl -F, an
// apiVersion of null leaves the field out
function v1Form(fields, { attachments = zip(), apiVersion = "1", fieldType = "text/plain; charset=utf-8" } = {}) {
    const values = apiVersion === null ? fields : { api_version: apiVersion, ...fields };
    return multipart([
        ...Object.entries(values).map(([name, value]) => part(name, value, fieldType)),
        ...(attachments ? [attachments] : []),
    ]);
}

// Version 2: the part "report" as the game sends it - application/json, no filename
function v2Form(report, { type = "application/json", filename, screenshot = false, attachments = zip() } = {}) {
    const content = typeof report === "string" ? report : JSON.stringify({ api_version: 2, ...report });
    return multipart([
        part("report", content, type, filename),
        attachments,
        ...(screenshot ? [jpeg()] : []),
    ]);
}

const HARDWARE = {
    os: "Linux", distribution: "Fedora Linux 44", os_version: "6.17", architecture: "x86_64",
    cpu: "AMD Ryzen 7 5800X", cpu_threads: 16,
    ram: { physical: 34359738368, available: 17179869184 },
    disk_space_left: 107374182400,
    gpu: "Radeon RX 6800 | @team", gpu_type: "discrete", gpu_driver: "Mesa 25.2",
    rendering_method: "forward_plus", rendering_driver: "vulkan", graphics_api_version: "1.4",
    screen_size: [2560, 1440], window_mode: "fullscreen", godot: "4.5.1.stable",
};

const CASES = {
    // Version 1: text/plain fields
    "v1-full": () => v1Form({
        title: "Train stops at @signal",
        description: "It stopped.\r\nThen `nothing` happened, @maintainer.\r\n",
        build: "0.4.2+abc 1",
        scenery: "td.scn | `x`",
        vehicle: "EU07-424",
    }),
    "v1-minimal": () => v1Form({ description: "Only this." }),
    "v1-utf8": () => v1Form({ title: "Pociąg źle hamuje", description: "Żółć – na „stacji”." }),
    "v1-curl": () => v1Form({ title: "From curl", description: "d" }, { fieldType: null }),
    "v1-without-api-version": () => v1Form(
        { title: "No version", description: "Sent without api_version.", build: "0.3" }, { apiVersion: null }),
    "v1-description-empty": () => v1Form({ title: "x", description: "  " }),
    "v1-attachments-missing": () => v1Form({ description: "d" }, { attachments: null }),
    "v1-github-refuses": () => v1Form({ description: "d" }),
    "unknown-version": () => v1Form({ description: "d" }, { apiVersion: "7" }),
    // Version 2: a part application/json
    "v2-full": () => v2Form({
        title: "Crash on load",
        description: "Crashed ```twice```.\n@someone",
        build: "0.5.0",
        branch: "dev/bug-report-hardware",
        scenery: "td.scn",
        vehicle: "EN57",
        hardware: HARDWARE,
        settings: { "display/vsync": true, "audio/volume": 0.8, "player|name": "a`b" },
    }, { screenshot: true }),
    "v2-minimal": () => v2Form({ description: "Only this." }),
    "v2-sections-not-objects": () => v2Form({ description: "d", hardware: "fast", settings: [1, 2] }),
    "v2-settings-too-many": () => v2Form({
        description: "d",
        settings: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`group/setting_${i}`, "value ".repeat(5)])),
    }),
    "v2-github-refuses": () => v2Form({ description: "d" }, { screenshot: true }),
    "v2-wrong-version": () => v2Form(JSON.stringify({ api_version: 1, description: "d" })),
    "v2-not-json": () => v2Form("{"),
    // curl -F 'report=@report.json;type=application/json'
    "v2-curl": () => v2Form({ description: "From curl" }, { filename: "report.json" }),
    "v2-zip-near-boundary": () => v2Form(
        { description: "d" }, { attachments: zip(`PK\r\n--${BOUNDARY.slice(0, -1)}\r\n--\r\n\r\nzip`) }),
    // The JSON format's version in the part's Content-Type
    "json-version-2": () => v2Form({ description: "d" }, { type: "application/json; version=2" }),
    "json-version-2-charset": () => v2Form({ description: "d" }, { type: "Application/JSON; charset=utf-8; Version=\"2\"" }),
    "json-charset-only": () => v2Form({ description: "d" }, { type: "application/json; charset=utf-8" }),
    "json-version-not-offered": () => v2Form({ api_version: 9, description: "d" }, { type: "application/json; version=9" }),
    "json-version-1": () => v2Form({ description: "d" }, { type: "application/json; version=1" }),
    // Not a body of parts
    "not-multipart": () => ({ body: "{}", contentType: "application/json" }),
    "multipart-cut": () => {
        const { contentType } = v1Form({ description: "d" });
        return { body: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="description"\r\n\r\nd`, contentType };
    },
};

// A key of the GitHub App's, made for the test - the stand-in does not check the JWT
async function appKey() {
    const { privateKey } = await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true, ["sign"]);
    const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");
    return `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n`;
}

const env = {
    REPORTS_REPO: "owner/reports",
    GITHUB_APP_ID: "1",
    GITHUB_APP_INSTALLATION_ID: "2",
    GITHUB_APP_PRIVATE_KEY: await appKey(),
    REPORT_LIMITER: { limit: async () => ({ success: true }) },
};

// GitHub as the Worker sees it, recording what was sent; refuseIssue: the issue cannot be created
function standInGitHub({ refuseIssue }) {
    const sent = { uploads: [], deleted: [], issue: null };
    let assetId = 0;
    const fetch = async (url, init = {}) => {
        const { pathname, searchParams } = new URL(url);
        const reply = (status, body) => new Response(JSON.stringify(body), { status });
        if (pathname.endsWith("/access_tokens")) {
            return reply(201, { token: "installation-token" });
        }
        if (pathname.includes("/releases/tags/")) {
            return reply(200, { id: 10 });
        }
        if (pathname.endsWith("/assets") && init.method === "POST") {
            const name = searchParams.get("name");
            const extension = name.slice(name.lastIndexOf("."));
            sent.uploads.push({ extension, contentType: init.headers["Content-Type"], size: init.body.size });
            assetId += 1;
            return reply(201, { id: assetId, browser_download_url: `https://download.test/asset-${assetId}${extension}` });
        }
        if (pathname.includes("/releases/assets/") && init.method === "DELETE") {
            sent.deleted.push(Number(pathname.split("/").pop()));
            return new Response(null, { status: 204 });
        }
        if (pathname.endsWith("/issues") && init.method === "POST") {
            if (refuseIssue) {
                return reply(500, { message: "refused" });
            }
            sent.issue = JSON.parse(init.body);
            return reply(201, { html_url: "https://github.test/owner/reports/issues/1" });
        }
        throw new Error(`unexpected request: ${init.method || "GET"} ${url}`);
    };
    return { sent, fetch };
}

async function send(name) {
    const github = standInGitHub({ refuseIssue: name.endsWith("-github-refuses") });
    const realFetch = globalThis.fetch;
    const realError = console.error;
    globalThis.fetch = github.fetch;
    console.error = () => {};
    const { body, contentType } = CASES[name]();
    try {
        const response = await worker.fetch(new Request(ENDPOINT, {
            method: "POST",
            body,
            headers: { "Content-Type": contentType },
        }), env);
        return {
            status: response.status,
            contentType: response.headers.get("Content-Type"),
            answer: await response.json(),
            ...github.sent,
        };
    } finally {
        globalThis.fetch = realFetch;
        console.error = realError;
    }
}

for (const name of Object.keys(CASES)) {
    test(name, async () => {
        const result = await send(name);
        const file = new URL(`${name}.json`, EXPECTED);
        if (process.env.UPDATE_EXPECTED) {
            await writeFile(file, JSON.stringify(result, null, 2) + "\n");
            return;
        }
        assert.deepEqual(result, JSON.parse(await readFile(file, "utf8")));
    });
}
