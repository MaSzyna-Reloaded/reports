// Reports through the Worker's fetch, GitHub answered by a stand-in that records what it is sent:
// the report as the game sends it, as the builds before the hardware and settings sent it, and the
// requests the Worker refuses. npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.js";

const ENDPOINT = "https://reports.test/";

const HARDWARE = {
    os: "Linux", distribution: "Fedora Linux 44", os_version: "6.17", architecture: "x86_64",
    cpu: "AMD Ryzen 7 5800X", cpu_threads: 16,
    ram: { physical: 34359738368, available: 17179869184 },
    disk_space_left: 107374182400,
    gpu: "Radeon RX 6800 | @team", gpu_type: "discrete", gpu_driver: "Mesa 25.2",
    rendering_method: "forward_plus", rendering_driver: "vulkan", graphics_api_version: "1.4",
    screen_size: [2560, 1440], window_mode: "fullscreen", godot: "4.5.1.stable",
};

const zip = () => new File(["PK zip"], "report.zip", { type: "application/zip" });
const jpeg = () => new File(["JPEG"], "screenshot.jpg", { type: "image/jpeg" });
const json = (name, value, type = "application/json") => new File([JSON.stringify(value)], `${name}.json`, { type });

// The form of a report: text fields, then the files
function form(fields, files = { attachments: zip() }) {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) {
        data.append(name, value);
    }
    for (const [name, file] of Object.entries(files)) {
        data.append(name, file);
    }
    return data;
}

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
function standInGitHub(refuseIssue) {
    const sent = { uploads: [], deleted: [], issue: null };
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
            sent.uploads.push({ extension: name.slice(name.lastIndexOf(".")), contentType: init.headers["Content-Type"] });
            const id = sent.uploads.length;
            return reply(201, { id, browser_download_url: `https://download.test/asset-${id}${name.slice(name.lastIndexOf("."))}` });
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

async function send(body, { refuseIssue = false } = {}) {
    const github = standInGitHub(refuseIssue);
    const realFetch = globalThis.fetch;
    const realError = console.error;
    globalThis.fetch = github.fetch;
    console.error = () => {};
    try {
        const response = await worker.fetch(new Request(ENDPOINT, { method: "POST", body }), env);
        return { status: response.status, answer: await response.json(), ...github.sent };
    } finally {
        globalThis.fetch = realFetch;
        console.error = realError;
    }
}

test("the game's report: its hardware and settings in the issue, its screenshot shown", async () => {
    const result = await send(form({
        title: "[0.5.0] Crash on load",
        description: "Crashed ```twice```.\r\n@someone",
        build: "0.5.0",
        branch: "dev/bug-report-hardware",
        scenery: "td.scn",
        vehicle: "EN57",
    }, {
        hardware: json("hardware", HARDWARE),
        settings: json("settings", { "display/vsync": true, "player|name": "a`b" }, "application/json; charset=utf-8"),
        attachments: zip(),
        screenshot: jpeg(),
    }));
    assert.equal(result.status, 201);
    assert.deepEqual(result.answer, { issue_url: "https://github.test/owner/reports/issues/1" });
    assert.deepEqual(result.uploads, [
        { extension: ".zip", contentType: "application/zip" },
        { extension: ".jpg", contentType: "image/jpeg" },
    ]);
    const { title, body, labels } = result.issue;
    assert.equal(title, "[0.5.0] Crash on load");
    assert.deepEqual(labels, ["player-report"]);
    assert.match(body, /^> Crashed ```twice```\.\n> @\u200bsomeone\n/);
    assert.match(body, /\| Branch \| <code>dev\\\/bug\\-report\\-hardware<\/code> \|/);
    assert.match(body, /\| RAM \| 32\\\.0 GiB\\, 16\\\.0 GiB available \|/);
    assert.match(body, /\| GPU \| Radeon RX 6800 \\\| \\@\u200bteam\\, discrete \|/);
    assert.match(body, /!\[screenshot\]\(https:\/\/download\.test\/asset-2\.jpg\)/);
    assert.match(body, /<details><summary>Settings<\/summary>/);
    assert.match(body, /\| <code>player\\\|name<\/code> \| \\"a\\`b\\" \|/);
});

test("an old build's report: text fields with api_version, no branch, hardware or screenshot", async () => {
    const result = await send(form({
        api_version: "1", title: "Old", description: "From an old build", build: "20261001-1200", scenery: "", vehicle: "",
    }));
    assert.equal(result.status, 201);
    assert.deepEqual(result.uploads, [{ extension: ".zip", contentType: "application/zip" }]);
    const { body } = result.issue;
    assert.doesNotMatch(body, /\| Branch \|/);
    assert.doesNotMatch(body, /\| OS \||Settings|!\[screenshot\]/);
    assert.doesNotMatch(body, /api_version/);
});

test("a JSON part is read by its Content-Type: not JSON, not an object or not application/json is left out", async () => {
    const result = await send(form({ description: "d" }, {
        hardware: new File(["{"], "hardware.json", { type: "application/json" }),
        settings: json("settings", { a: 1 }, "text/plain"),
        attachments: zip(),
    }));
    assert.equal(result.status, 201);
    assert.doesNotMatch(result.issue.body, /\| OS \||Settings/);
    const arrays = await send(form({ description: "d", hardware: JSON.stringify(HARDWARE) }, {
        settings: json("settings", [1, 2]), attachments: zip(),
    }));
    assert.doesNotMatch(arrays.issue.body, /\| OS \||Settings/);
});

test("backslashes in the game's texts are shown as they are and cannot end a cell", async () => {
    const result = await send(form({ description: "d", build: "b\\", scenery: "td\\x|y\\\\|z" }, {
        hardware: json("hardware", { gpu_driver: "C:\\drv.sys trail\\" }),
        attachments: zip(),
    }));
    const { body } = result.issue;
    assert.match(body, /\| Build \| <code>b\\\\<\/code> \|/);
    assert.match(body, /\| Scenery \| <code>td\\\\x\\\|y\\\\\\\\\\\|z<\/code> \|/);
    assert.match(body, /\| GPU driver \| C\\:\\\\drv\\\.sys trail\\\\ \|/);
});

test("the settings' table too long for the issue is left to the archive", async () => {
    const settings = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`group/setting_${i}`, "value ".repeat(5)]));
    const result = await send(form({ description: "d" }, { settings: json("settings", settings), attachments: zip() }));
    assert.match(result.issue.body, /Too many to show here/);
});

test("GitHub refusing the issue: 502 and no asset left behind", async () => {
    const result = await send(form({ description: "d" }, { attachments: zip(), screenshot: jpeg() }), { refuseIssue: true });
    assert.equal(result.status, 502);
    assert.deepEqual(result.deleted, [1, 2]);
});

test("refused: no attachments, an empty description, not multipart", async () => {
    assert.deepEqual(await send(form({ description: "d" }, {})).then((r) => [r.status, r.answer]),
        [400, { error: "attachments missing" }]);
    assert.deepEqual(await send(form({ description: "  " })).then((r) => [r.status, r.answer]),
        [400, { error: "description empty" }]);
    assert.equal((await send("{}")).status, 400);
});
