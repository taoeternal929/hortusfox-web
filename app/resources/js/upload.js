/**
 * upload.js
 *
 * Sends forms and requests that contain picked files with a request body
 * that is built in memory.
 *
 * On iOS 27 (seen in both Safari 27.2 and Chrome for iOS) a form that holds
 * a file chosen from a file input can be sent with an empty body
 * (Content-Length: 0). The server then receives neither the file nor any of
 * the other fields, and the request fails validation with "Invalid data
 * given". Requests whose body is already in memory are sent intact, so the
 * picked files are read into memory first and the multipart body is encoded
 * here.
 */

//Files larger than this in total are sent the regular way, to avoid holding
//very large uploads (such as backups) in memory twice
const MAX_BUFFERED_UPLOAD_SIZE = 256 * 1024 * 1024;

//Header that tells the server that the redirect after an upload is being
//followed by fetch(), see app/controller/_base.php
const UPLOAD_REDIRECT_HEADER = 'X-HortusFox-Upload-Redirect';

function selectedFileSize(formData)
{
    let total = 0;

    for (const [, value] of formData.entries()) {
        if (value instanceof Blob) {
            total += value.size;
        }
    }

    return total;
}

/**
 * Whether the data should be sent with a body built in memory
 *
 * @param {FormData} formData
 * @return {boolean}
 */
export function shouldBufferUpload(formData)
{
    const size = selectedFileSize(formData);

    return (size > 0) && (size <= MAX_BUFFERED_UPLOAD_SIZE);
}

function escapeHeaderValue(value)
{
    return String(value).replace(/\r\n|\r|\n/g, '\r\n').replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
}

function randomBoundary()
{
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);

    return '----HortusFoxFormBoundary' + Array.from(bytes, function(byte) {
        return byte.toString(16).padStart(2, '0');
    }).join('');
}

/**
 * Encode form data as multipart/form-data, reading all files into memory
 *
 * @param {FormData} formData
 * @return {Promise<{body: ArrayBuffer, contentType: string}>}
 */
export async function encodeMultipartFormData(formData)
{
    const boundary = randomBoundary();
    const encoder = new TextEncoder();
    const chunks = [];

    for (const [name, value] of formData.entries()) {
        let head = '--' + boundary + '\r\n' + 'Content-Disposition: form-data; name="' + escapeHeaderValue(name) + '"';

        if (value instanceof Blob) {
            const filename = (typeof value.name === 'string') ? value.name : 'blob';
            const type = (value.type || 'application/octet-stream').replace(/[\r\n]/g, '');

            chunks.push(encoder.encode(head + '; filename="' + escapeHeaderValue(filename) + '"\r\nContent-Type: ' + type + '\r\n\r\n'));

            const data = new Uint8Array(await value.arrayBuffer());
            if (data.byteLength !== value.size) {
                throw new Error('The selected file "' + filename + '" could not be read (' + data.byteLength + ' of ' + value.size + ' bytes)');
            }

            chunks.push(data);
        } else {
            chunks.push(encoder.encode(head + '\r\n\r\n' + String(value).replace(/\r\n|\r|\n/g, '\r\n')));
        }

        chunks.push(encoder.encode('\r\n'));
    }

    chunks.push(encoder.encode('--' + boundary + '--\r\n'));

    let length = 0;
    chunks.forEach(function(chunk) {
        length += chunk.byteLength;
    });

    const body = new Uint8Array(length);
    let offset = 0;
    chunks.forEach(function(chunk) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    });

    return {
        body: body.buffer,
        contentType: 'multipart/form-data; boundary=' + boundary
    };
}

function navigateTo(url)
{
    const target = new URL(url, window.location.href);
    const current = new URL(window.location.href);

    if ((target.origin === current.origin) && (target.pathname === current.pathname) && (target.search === current.search)) {
        window.location.reload();
    } else {
        window.location.href = target.href;
    }
}

/**
 * Whether the form contains picked files that should be sent with a body
 * built in memory
 *
 * @param {HTMLFormElement} form
 * @return {boolean}
 */
export function formNeedsBufferedUpload(form)
{
    if ((form.method || '').toLowerCase() !== 'post') {
        return false;
    }

    if (!form.querySelector('input[type="file"]')) {
        return false;
    }

    return shouldBufferUpload(new FormData(form));
}

/**
 * Submit a form with a body built in memory and then open the page the
 * server redirects to, as a regular form submission would.
 *
 * @param {HTMLFormElement} form
 * @return {Promise<void>}
 */
export async function submitFormBuffered(form)
{
    const encoded = await encodeMultipartFormData(new FormData(form));

    const headers = {
        'Content-Type': encoded.contentType
    };
    headers[UPLOAD_REDIRECT_HEADER] = '1';

    const response = await fetch(form.action, {
        method: 'POST',
        headers: headers,
        body: encoded.body,
        credentials: 'same-origin'
    });

    if (response.redirected) {
        navigateTo(response.url);
        return;
    }

    //No redirect, e.g. an error page: show it like a regular form submission would
    const html = await response.text();
    document.open();
    document.write(html);
    document.close();
}
