// Content negotiation of the report API's version: a client names the version in Accept as
// MEDIA_TYPE with the parameter "version" (application/vnd.maszyna-reloaded.report+json;
// version=2), and the answer is of that type and version. A client that does not - every build of
// version 1, Godot sending "Accept: */*" - is of version 1 (index.js, LEGACY_VERSION).

export const MEDIA_TYPE = "application/vnd.maszyna-reloaded.report+json";

// The version Accept asks for, of those offered (newest first): { version } - the newest when
// MEDIA_TYPE comes without one -, { refused: [...] } when it names only versions not offered, or
// null when it does not name MEDIA_TYPE at all
export function negotiate(accept, offered) {
    const asked = (accept || "")
        .split(",")
        .map(mediaRange)
        .filter((range) => range.type === MEDIA_TYPE && range.q > 0)
        // the most preferred first; among equals in Accept's order
        .sort((a, b) => b.q - a.q);
    if (asked.length === 0) {
        return null;
    }
    for (const range of asked) {
        const version = range.version === undefined
            ? offered[0]
            : offered.find((candidate) => String(candidate) === range.version);
        if (version !== undefined) {
            return { version };
        }
    }
    return { refused: asked.map((range) => range.version) };
}

// The answer as of MEDIA_TYPE and the version - its body as it is
export function labelled(response, version) {
    const answer = new Response(response.body, response);
    answer.headers.set("Content-Type", `${MEDIA_TYPE}; version=${version}; charset=utf-8`);
    return answer;
}

// One media range of Accept: its type, lowercase, its "version" and its "q"
function mediaRange(text) {
    const [type, ...parameters] = text.split(";").map((part) => part.trim());
    const range = { type: type.toLowerCase(), version: undefined, q: 1 };
    for (const parameter of parameters) {
        const [name, value = ""] = parameter.split("=").map((part) => part.trim());
        if (name.toLowerCase() === "version") {
            range.version = value.replace(/^"(.*)"$/, "$1");
        } else if (name.toLowerCase() === "q") {
            range.q = Number(value) || 0;
        }
    }
    return range;
}
