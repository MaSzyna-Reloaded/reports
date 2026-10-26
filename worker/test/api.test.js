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
const MEDIA_TYPE = "application/vnd.maszyna-reloaded.report+json";

const zip = () => new File(["PK zip"], "report.zip", { type: "application/zip" });
const jpeg = () => new File(["JPEG"], "screenshot.jpg", { type: "image/jpeg" });
const json = (value) => new File([JSON.stringify(value)], "report.json", { type: "application/json" });

function v1Form(fields, files = { attachments: zip() }) {
    const form = new FormData();
    form.set("api_version", "1");
    for (const [name, value] of Object.entries({ ...fields, ...files })) {
        form.set(name, value);
    }
    return form;
}

// A client of version 2 names it in Accept
const ACCEPT_V2 = `${MEDIA_TYPE}; version=2`;

function v2Parts(report, files = { attachments: zip() }) {
    const form = new FormData();
    form.set("report", json({ api_version: 2, ...report }));
    for (const [name, value] of Object.entries(files)) {
        form.set(name, value);
    }
    return form;
}

function v2Form(report, files) {
    return { form: v2Parts(report, files), accept: ACCEPT_V2 };
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
    "v1-full": () => v1Form({
        title: "Train stops at @signal",
        description: "It stopped.\r\nThen `nothing` happened, @maintainer.\r\n",
        build: "0.4.2+abc 1",
        scenery: "td.scn | `x`",
        vehicle: "EU07-424",
    }),
    "v1-minimal": () => v1Form({ description: "Only this." }),
    "v1-description-empty": () => v1Form({ title: "x", description: "  " }),
    "v1-attachments-missing": () => v1Form({ description: "d" }, {}),
    "v2-full": () => v2Form({
        title: "Crash on load",
        description: "Crashed ```twice```.\n@someone",
        build: "0.5.0",
        branch: "dev/bug-report-hardware",
        scenery: "td.scn",
        vehicle: "EN57",
        hardware: HARDWARE,
        settings: { "display/vsync": true, "audio/volume": 0.8, "player|name": "a`b" },
    }, { attachments: zip(), screenshot: jpeg() }),
    "v2-minimal": () => v2Form({ description: "Only this." }),
    "v2-sections-not-objects": () => v2Form({ description: "d", hardware: "fast", settings: [1, 2] }),
    "v2-settings-too-many": () => v2Form({
        description: "d",
        settings: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`group/setting_${i}`, "value ".repeat(5)])),
    }),
    "v2-wrong-version": () => {
        const form = new FormData();
        form.set("report", JSON.stringify({ api_version: 1, description: "d" }));
        form.set("attachments", zip());
        return { form, accept: ACCEPT_V2 };
    },
    "v2-not-json": () => {
        const form = new FormData();
        form.set("report", "{");
        form.set("attachments", zip());
        return { form, accept: ACCEPT_V2 };
    },
    "unknown-version": () => {
        const form = new FormData();
        form.set("api_version", "7");
        form.set("description", "d");
        form.set("attachments", zip());
        return form;
    },
    "v1-github-refuses": () => v1Form({ description: "d" }),
    "v2-github-refuses": () => v2Form({ description: "d" }, { attachments: zip(), screenshot: jpeg() }),
    "v1-without-api-version": () => {
        const form = v1Form({ title: "No version", description: "Sent without api_version.", build: "0.3" });
        form.delete("api_version");
        return form;
    },
    // Content negotiation: the version Accept names
    "accept-v1": () => ({ form: v1Form({ description: "d" }), accept: `${MEDIA_TYPE}; version=1` }),
    "accept-newest": () => ({ form: v2Parts({ description: "d" }), accept: `${MEDIA_TYPE}, application/json;q=0.5` }),
    "accept-preferred": () => ({
        form: v1Form({ description: "d" }),
        accept: `${MEDIA_TYPE}; version=9, ${MEDIA_TYPE}; version=2; q=0.2, ${MEDIA_TYPE}; version="1"; q=0.8`,
    }),
    "accept-not-offered": () => ({ form: v2Parts({ description: "d" }), accept: `${MEDIA_TYPE}; version=9` }),
    "accept-v2-report-v1": () => ({ form: v1Form({ description: "d" }), accept: `${MEDIA_TYPE}; version=2` }),
    "accept-v1-report-v2": () => ({ form: v2Parts({ description: "d" }), accept: `${MEDIA_TYPE}; version=1` }),
    // No version in Accept is version 1: what a build of version 1 sends, and a report of version 2
    // that does not name its version
    "accept-anything": () => ({ form: v1Form({ description: "d" }), accept: "*/*" }),
    "v2-without-accept": () => v2Parts({ description: "d" }),
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
    // a case is the form, or { form, accept } for a client that names its version
    const made = CASES[name]();
    const { form, accept } = made instanceof FormData ? { form: made } : made;
    try {
        const response = await worker.fetch(new Request(ENDPOINT, {
            method: "POST",
            body: form,
            headers: accept ? { Accept: accept } : {},
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
