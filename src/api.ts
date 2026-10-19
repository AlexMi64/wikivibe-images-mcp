import type { Credentials } from "./credentials.js";

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;
/** Upstream 5xx means the provider is already struggling; retry once, slowly, then give up. */
const MAX_ATTEMPTS_UPSTREAM = 2;
const UPSTREAM_BACKOFF_MS = 12_000;
const RETRYABLE_STATUS: Record<number, true> = {
	408: true,
	425: true,
	429: true,
	500: true,
	502: true,
	503: true,
	504: true,
};
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
/** WikiVibe image endpoints are expensive; never run two calls at once from one process. */
const MIN_GAP_MS = 1_500;

export class WikiVibeError extends Error {
	readonly status: number;
	readonly hint?: string;
	readonly retryable: boolean;

	constructor(message: string, status: number, hint?: string, retryable = false) {
		super(message);
		this.name = "WikiVibeError";
		this.status = status;
		this.hint = hint;
		this.retryable = retryable;
	}
}

interface ErrorEnvelope {
	error?: { message?: unknown; type?: unknown; code?: unknown };
	message?: unknown;
}

function describeError(status: number, body: string, retryAfterMs: number | undefined): WikiVibeError {
	let message = body.trim().slice(0, 600);
	try {
		const parsed = JSON.parse(body) as ErrorEnvelope;
		const candidate = parsed.error?.message ?? parsed.message;
		if (typeof candidate === "string" && candidate.trim()) message = candidate.trim();
	} catch {
		// Non-JSON body: keep the trimmed text.
	}
	const retryable = RETRYABLE_STATUS[status] === true;
	if (status === 403 && /image generation/i.test(message)) {
		return new WikiVibeError(
			message,
			status,
			"Image generation is disabled for this API key's group. Enable allow_image_generation on the group in the WikiVibe dashboard.",
		);
	}
	if (status === 401) {
		return new WikiVibeError(message, status, "Check the API key: run `wikivibe login` again.");
	}
	if (status === 429) {
		const wait = retryAfterMs !== undefined ? ` Retry after ${Math.ceil(retryAfterMs / 1000)}s.` : "";
		return new WikiVibeError(message, status, `Rate limited by WikiVibe.${wait}`, true);
	}
	if (status === 502 || status === 503 || status === 504) {
		return new WikiVibeError(
			message,
			status,
			"The upstream image provider is briefly unavailable. Retry in a minute; do not send parallel requests.",
			true,
		);
	}
	return new WikiVibeError(message, status, undefined, retryable);
}

function retryAfterFrom(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/** Serializes every request and keeps a minimum gap, so the gateway never sees a burst. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(async () => {
		const wait = lastRequestAt + MIN_GAP_MS - Date.now();
		if (wait > 0) await sleep(wait);
		try {
			return await task();
		} finally {
			lastRequestAt = Date.now();
		}
	});
	queue = run.catch(() => undefined);
	return run;
}

async function once(credentials: Credentials, path: string, init: RequestInit): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${credentials.apiKey}`);
	if (!(init.body instanceof FormData) && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	let response: Response;
	try {
		response = await fetch(`${credentials.baseUrl}${path}`, {
			...init,
			headers,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		const cause =
			error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
		const reason = error instanceof Error ? `${error.message}${cause}` : String(error);
		throw new WikiVibeError(`Request to ${path} failed: ${reason}`, 0, undefined, true);
	}
	if (!response.ok) {
		throw describeError(response.status, await response.text(), retryAfterFrom(response));
	}
	return response;
}

async function call(credentials: Credentials, path: string, init: RequestInit): Promise<Response> {
	return await enqueue(async () => {
		let attempt = 0;
		for (;;) {
			try {
				return await once(credentials, path, init);
			} catch (error) {
				attempt += 1;
				const retryable = error instanceof WikiVibeError && error.retryable;
				const upstream = error instanceof WikiVibeError && error.status >= 500;
				const limit = upstream ? MAX_ATTEMPTS_UPSTREAM : MAX_ATTEMPTS;
				if (!retryable || attempt >= limit) throw error;
				const backoff = upstream
					? UPSTREAM_BACKOFF_MS
					: Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
				await sleep(backoff + Math.random() * 1_000);
			}
		}
	});
}

export async function postJson<T>(
	credentials: Credentials,
	path: string,
	body: unknown,
): Promise<T> {
	const response = await call(credentials, path, { method: "POST", body: JSON.stringify(body) });
	return (await response.json()) as T;
}

export async function postForm<T>(
	credentials: Credentials,
	path: string,
	form: FormData,
): Promise<T> {
	const response = await call(credentials, path, { method: "POST", body: form });
	return (await response.json()) as T;
}

export async function getJson<T>(credentials: Credentials, path: string): Promise<T> {
	const response = await call(credentials, path, { method: "GET" });
	return (await response.json()) as T;
}

export async function getBytes(
	credentials: Credentials,
	path: string,
): Promise<{ bytes: Buffer; contentType: string }> {
	const response = await call(credentials, path, { method: "GET" });
	return {
		bytes: Buffer.from(await response.arrayBuffer()),
		contentType: response.headers.get("content-type") ?? "application/octet-stream",
	};
}
