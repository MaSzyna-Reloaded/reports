// Opens a GitHub issue from a MaSzyna Reloaded problem report.
//
// The request is the game's report API - the contract is docs/bug-reports.md in maszyna-reloaded:
// one multipart/form-data POST. Here is only what comes before a version: the method, the size, the
// rate limit, the form, which version it is - then the version's module in api/ answers it, from
// its fields to the issue. The report's zip and screenshot become assets of this month's release
// of REPORTS_REPO, the issue links the zip and shows the screenshot, and the answer is
// {"issue_url": ...}.
//
// The version is the one Accept names (shared/negotiation.js) - without one, LEGACY_VERSION, as
// every build of version 1 sends nothing of it. The request then must be of that version.

import * as v1 from "./api/v1.js";
import * as v2 from "./api/v2.js";
import { answer } from "./shared/http.js";
import { MEDIA_TYPE, labelled, negotiate } from "./shared/negotiation.js";

// Newest first: Accept's MEDIA_TYPE without a version is the newest
const API_VERSIONS = [v2, v1];
// The version of a request that names none in Accept
const LEGACY_VERSION = v1;
const OFFERED = API_VERSIONS.map((version) => version.API_VERSION);
// The archive: a snapshot of a few MB and a log of up to 4 MB pack small, a JPEG of a few
// hundred kB - docs/bug-reports.md, "Limit abuse"
const MAX_REQUEST_BYTES = 25 * 1024 * 1024;

export default {
    async fetch(request, env) {
        if (request.method !== "POST") {
            return answer(405, { error: "POST only" });
        }
        if (Number(request.headers.get("Content-Length") || 0) > MAX_REQUEST_BYTES) {
            return answer(413, { error: "report too large" });
        }
        // before the rate limit and the form: a client of no version offered is told at once
        const negotiated = negotiate(request.headers.get("Accept"), OFFERED);
        if (negotiated?.refused) {
            return answer(406, {
                error: `api version ${negotiated.refused.join(", ")} not offered`,
                offered: OFFERED.map((version) => `${MEDIA_TYPE}; version=${version}`),
            });
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
        if (negotiated) {
            const api = API_VERSIONS.find((version) => version.API_VERSION === negotiated.version);
            const answered = api.isOf(form) && await api.handle(form, env);
            return labelled(answered || answer(400, {
                error: `not a report of api version ${api.API_VERSION}, which Accept names`,
            }), api.API_VERSION);
        }
        // the answer as it has always been to a client that names no version
        const answered = LEGACY_VERSION.isOf(form) && await LEGACY_VERSION.handle(form, env);
        return answered || answer(400, {
            error: `unknown api_version, expected ${LEGACY_VERSION.API_VERSION} - or a version named in Accept: ${MEDIA_TYPE}; version=<n>`,
        });
    },
};
