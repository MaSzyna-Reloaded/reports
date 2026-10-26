// Report API version 1 - builds before the report went as one JSON part: the text fields
// "api_version", "title", "description", "build", "scenery", "vehicle" and the file "attachments".
// No screenshot, branch, hardware or settings.

export const API_VERSION = "1";
const FIELDS = ["title", "description", "build", "scenery", "vehicle"];

// A request of version 1: its "api_version" is API_VERSION
export function isOf(form) {
    return form.get("api_version") === API_VERSION;
}

// The report as every version gives it to index.js: its values, the archive and the screenshot -
// each field's first value, no sections, no screenshot
export async function read(form) {
    return {
        values: Object.fromEntries(FIELDS.map((field) => [field, form.get(field)])),
        attachments: form.get("attachments"),
        screenshot: null,
    };
}
