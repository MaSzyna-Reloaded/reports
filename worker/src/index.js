// Opens a GitHub issue from a MaSzyna Reloaded problem report.
//
// The request is the game's report API - the contract is docs/bug-reports.md in maszyna-reloaded:
// one multipart/form-data POST. Here is only what comes before a version: the method, the size, the
// rate limit, the parts, which version it is - then the version's module in api/ answers it, from
// its fields to the issue. The report's zip and screenshot become assets of this month's release
// of REPORTS_REPO, the issue links the zip and shows the screenshot, and the answer is
// {"issue_url": ...}.
//
// The version is told by the parts' Content-Type (versionOf): the report as text/plain fields is
// the old format, version 1; as a part application/json the JSON format - of the version its
// parameter "version" names, version 2 without one.

import * as v1 from "./api/v1.js";
import * as v2 from "./api/v2.js";
import { answer } from "./shared/http.js";
import { formOf, mediaType, readParts } from "./shared/multipart.js";

const API_VERSIONS = [v2, v1];
// The report as text fields, no part application/json
const FIELDS_VERSION = v1;
// A part application/json without the parameter "version": the JSON format's first version
const JSON_VERSION = v2;
const JSON_MEDIA_TYPE = "application/json";
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
        const address = request.headers.get("CF-Connecting-IP") || "";
        const { success } = await env.REPORT_LIMITER.limit({ key: address });
        if (!success) {
            return answer(429, { error: "too many reports, try again later" });
        }

        const parts = await readParts(request);
        if (!parts) {
            return answer(400, { error: "not multipart/form-data" });
        }
        const version = versionOf(parts);
        const api = API_VERSIONS.find((candidate) => String(candidate.API_VERSION) === version);
        if (!api) {
            return answer(400, {
                error: `api version ${version} not offered - ${API_VERSIONS.map((offered) => offered.API_VERSION).join(", ")} are`,
            });
        }
        const form = formOf(parts);
        return (api.isOf(form) && await api.handle(form, env)) || answer(400, {
            error: `not a report of api version ${api.API_VERSION}`
                + (api === FIELDS_VERSION ? ` - its text fields with api_version ${api.API_VERSION}` : ""),
        });
    },
};

// The report API version the parts are of: the first part application/json - its "version", or
// JSON_VERSION -, FIELDS_VERSION without one
function versionOf(parts) {
    for (const part of parts) {
        const type = mediaType(part.contentType);
        if (type.type === JSON_MEDIA_TYPE) {
            return type.parameters.version ?? String(JSON_VERSION.API_VERSION);
        }
    }
    return String(FIELDS_VERSION.API_VERSION);
}
