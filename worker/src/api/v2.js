// Report API version 2: the part "report" (application/json) - "api_version", "title",
// "description", "build", "branch", "scenery", "vehicle", and the snapshot's sections "hardware"
// and "settings" as objects - then the file "attachments" (report.zip) and the file "screenshot"
// (screenshot.jpg, when attached).

export const API_VERSION = 2;

// A request of version 2: it has the part "report" - its "api_version" is checked by read
export function isOf(form) {
    return form.has("report");
}

// The report as every version gives it to index.js: its values, the archive and the screenshot -
// null when the part "report" is not a JSON object of API_VERSION. The part is text, or a file
// when it was sent as one (curl -F report=@report.json)
export async function read(form) {
    const part = form.get("report");
    let values;
    try {
        values = JSON.parse(part instanceof File ? await part.text() : part);
    } catch {
        return null;
    }
    if (values === null || typeof values !== "object" || Array.isArray(values)
        || values.api_version !== API_VERSION) {
        return null;
    }
    return {
        values,
        attachments: form.get("attachments"),
        screenshot: form.get("screenshot"),
    };
}
