import type {
	HttpHandlerOptions,
	HttpRequest,
	HttpResponse,
} from '@smithy/types';
import { requestUrl } from 'obsidian';

/**
 * AWS SDK HTTP handler that uses Obsidian's requestUrl.
 * Bypasses browser CORS restrictions that break fetch() to R2/S3 endpoints.
 */
export class ObsidianHttpHandler {
	async handle(
		request: HttpRequest,
		options?: HttpHandlerOptions,
	): Promise<{ response: HttpResponse }> {
		if (options?.abortSignal?.aborted) {
			const abortError = new Error('Request aborted');
			abortError.name = 'AbortError';
			throw abortError;
		}

		const url = buildRequestUrl(request);
		const headers = flattenHeaders(request.headers);
		const body = await serializeBody(request.body);

		const result = await requestUrl({
			url,
			method: request.method,
			headers,
			body,
			throw: false,
		});

		return {
			response: {
				statusCode: result.status,
				headers: normalizeResponseHeaders(result.headers),
				// AWS SDK browser deserializer expects a ReadableStream with getReader().
				body: arrayBufferToReadableStream(result.arrayBuffer),
			},
		};
	}

	destroy(): void {
		// no-op
	}

	updateHttpClientConfig(): void {
		// no-op
	}

	httpHandlerConfigs(): Record<string, never> {
		return {};
	}
}

function buildRequestUrl(request: HttpRequest): string {
	const protocol = (request.protocol ?? 'https:').replace(/:?$/, ':');
	const port =
		request.port !== undefined &&
		!(
			(protocol === 'https:' && request.port === 443) ||
			(protocol === 'http:' && request.port === 80)
		)
			? `:${request.port}`
			: '';

	const path = request.path?.startsWith('/')
		? request.path
		: `/${request.path ?? ''}`;

	const query = encodeQuery(request.query);
	return `${protocol}//${request.hostname}${port}${path}${query}`;
}

function encodeQuery(
	query: HttpRequest['query'],
): string {
	if (!query) {
		return '';
	}

	const parts: string[] = [];
	for (const [key, value] of Object.entries(query)) {
		const encodedKey = encodeURIComponent(key);
		if (value === undefined) {
			continue;
		}
		if (value === null) {
			parts.push(encodedKey);
			continue;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				parts.push(`${encodedKey}=${encodeURIComponent(item)}`);
			}
			continue;
		}
		parts.push(`${encodedKey}=${encodeURIComponent(value)}`);
	}

	return parts.length > 0 ? `?${parts.join('&')}` : '';
}

function flattenHeaders(
	headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
	const result: Record<string, string> = {};
	if (!headers) {
		return result;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined || value === null) {
			continue;
		}
		// Host is set by the HTTP stack; duplicating it can break signing hosts.
		if (key.toLowerCase() === 'host') {
			continue;
		}
		result[key] = String(value);
	}
	return result;
}

function normalizeResponseHeaders(
	headers: Record<string, string>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		result[key.toLowerCase()] = value;
	}
	return result;
}

async function serializeBody(
	body: unknown,
): Promise<string | ArrayBuffer | undefined> {
	if (body === undefined || body === null) {
		return undefined;
	}
	if (typeof body === 'string') {
		return body;
	}
	if (body instanceof ArrayBuffer) {
		return body;
	}
	if (ArrayBuffer.isView(body)) {
		return copyArrayBufferView(body);
	}
	if (typeof Blob !== 'undefined' && body instanceof Blob) {
		return await body.arrayBuffer();
	}
	if (
		typeof (body as { transformToByteArray?: () => Promise<Uint8Array> })
			.transformToByteArray === 'function'
	) {
		const bytes = await (
			body as { transformToByteArray: () => Promise<Uint8Array> }
		).transformToByteArray();
		return copyArrayBufferView(bytes);
	}
	if (
		typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ===
		'function'
	) {
		const chunks: Uint8Array[] = [];
		let total = 0;
		for await (const chunk of body as AsyncIterable<Uint8Array>) {
			chunks.push(chunk);
			total += chunk.byteLength;
		}
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return merged.buffer;
	}

	throw new Error('Unsupported request body type for S3 request.');
}

function copyArrayBufferView(view: ArrayBufferView): ArrayBuffer {
	const copy = new Uint8Array(view.byteLength);
	copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	return copy.buffer;
}

function arrayBufferToReadableStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(buffer));
			controller.close();
		},
	});
}
