// A multipart/form-data body read by the Worker itself: request.formData() keeps the Content-Type
// of a part only when it has a filename, and the game sends the report's part without one - the
// part's Content-Type is what says the report API version (index.js).

const CRLF = "\r\n";
// RFC 7578: a part without a Content-Type is text
const DEFAULT_CONTENT_TYPE = "text/plain";

// The parts of a multipart/form-data body: { name, filename, contentType, data } in their order -
// filename undefined for a part without one, data the part's bytes. Null when the request is not
// multipart/form-data or its body is not one
export async function readParts(request) {
    const type = mediaType(request.headers.get("Content-Type") || "");
    if (type.type !== "multipart/form-data" || !type.parameters.boundary) {
        return null;
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const delimiter = ascii(`${CRLF}--${type.parameters.boundary}`);
    // the first delimiter may open the body without the line break before it
    const opening = delimiter.subarray(CRLF.length);
    let at;
    if (startsWith(bytes, opening, 0)) {
        at = opening.length;
    } else {
        const first = indexOf(bytes, delimiter, 0);
        if (first < 0) {
            return null;
        }
        at = first + delimiter.length;
    }
    const parts = [];
    for (;;) {
        if (startsWith(bytes, ascii("--"), at)) {
            return parts;
        }
        // the rest of the delimiter's line - transport padding - then the part's headers
        const lineEnd = indexOf(bytes, ascii(CRLF), at);
        if (lineEnd < 0) {
            return null;
        }
        const headersStart = lineEnd + CRLF.length;
        let contentStart;
        let headers;
        if (startsWith(bytes, ascii(CRLF), headersStart)) {
            headers = "";
            contentStart = headersStart + CRLF.length;
        } else {
            const headersEnd = indexOf(bytes, ascii(CRLF + CRLF), headersStart);
            if (headersEnd < 0) {
                return null;
            }
            headers = new TextDecoder().decode(bytes.subarray(headersStart, headersEnd));
            contentStart = headersEnd + 2 * CRLF.length;
        }
        const contentEnd = indexOf(bytes, delimiter, contentStart);
        if (contentEnd < 0) {
            return null;
        }
        const part = partOf(headers, bytes.subarray(contentStart, contentEnd));
        if (!part) {
            return null;
        }
        parts.push(part);
        at = contentEnd + delimiter.length;
    }
}

// The parts as FormData, as request.formData() gives them: a part with a filename a File of its
// Content-Type, any other its text (UTF-8)
export function formOf(parts) {
    const form = new FormData();
    for (const part of parts) {
        if (part.filename === undefined) {
            form.append(part.name, new TextDecoder().decode(part.data));
        } else {
            form.append(part.name, new File([part.data], part.filename, { type: part.contentType }));
        }
    }
    return form;
}

// A media type - "application/json; version=2" - as its type and parameters, lowercase but for the
// parameters' values, a quoted value unquoted
export function mediaType(text) {
    const [type, ...rest] = splitParameters(text);
    const parameters = {};
    for (const parameter of rest) {
        const equals = parameter.indexOf("=");
        if (equals > 0) {
            parameters[parameter.slice(0, equals).trim().toLowerCase()] = unquote(parameter.slice(equals + 1).trim());
        }
    }
    return { type: type.trim().toLowerCase(), parameters };
}

function partOf(headers, data) {
    let disposition = null;
    let contentType = DEFAULT_CONTENT_TYPE;
    for (const line of headers.split(CRLF)) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "content-disposition") {
            disposition = mediaType(value);
        } else if (name === "content-type") {
            contentType = value;
        }
    }
    if (!disposition || disposition.type !== "form-data" || disposition.parameters.name === undefined) {
        return null;
    }
    return { name: disposition.parameters.name, filename: disposition.parameters.filename, contentType, data };
}

// The text split at the semicolons that are not in a quoted string
function splitParameters(text) {
    const pieces = [""];
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (c === ";" && !quoted) {
            pieces.push("");
            continue;
        }
        if (c === "\"") {
            quoted = !quoted;
        } else if (c === "\\" && quoted && i + 1 < text.length) {
            pieces[pieces.length - 1] += c;
            i += 1;
            pieces[pieces.length - 1] += text[i];
            continue;
        }
        pieces[pieces.length - 1] += c;
    }
    return pieces;
}

function unquote(value) {
    return value.startsWith("\"") && value.endsWith("\"") && value.length > 1
        ? value.slice(1, -1).replace(/\\(.)/g, "$1")
        : value;
}

function ascii(text) {
    return new TextEncoder().encode(text);
}

function startsWith(bytes, pattern, at) {
    if (at < 0 || at + pattern.length > bytes.length) {
        return false;
    }
    for (let i = 0; i < pattern.length; i += 1) {
        if (bytes[at + i] !== pattern[i]) {
            return false;
        }
    }
    return true;
}

// Where the pattern is in the bytes from "from" on, or -1: the native indexOf finds its first byte,
// so a zip of 25 MB is not walked byte by byte in JavaScript
function indexOf(bytes, pattern, from) {
    for (let at = bytes.indexOf(pattern[0], from); at >= 0; at = bytes.indexOf(pattern[0], at + 1)) {
        if (startsWith(bytes, pattern, at)) {
            return at;
        }
    }
    return -1;
}
