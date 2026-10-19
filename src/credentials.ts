import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://api.wikivibe.ru/v1";

export interface Credentials {
	apiKey: string;
	baseUrl: string;
}

export class MissingCredentialsError extends Error {
	constructor() {
		super(
			"WikiVibe API key is not configured. Run `wikivibe login`, or set WIKIVIBE_API_KEY.",
		);
		this.name = "MissingCredentialsError";
	}
}

export function configDir(): string {
	const override = process.env.WIKIVIBE_CONFIG_DIR?.trim();
	return override ? override : join(homedir(), ".wikivibe");
}

export function credentialsPath(): string {
	return join(configDir(), "credentials.json");
}

interface StoredCredentials {
	apiKey?: unknown;
	baseUrl?: unknown;
}

export async function readStoredCredentials(): Promise<Partial<Credentials>> {
	let raw: string;
	try {
		raw = await readFile(credentialsPath(), "utf8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const stored = parsed as StoredCredentials;
	const result: Partial<Credentials> = {};
	if (typeof stored.apiKey === "string" && stored.apiKey.trim()) {
		result.apiKey = stored.apiKey.trim();
	}
	if (typeof stored.baseUrl === "string" && stored.baseUrl.trim()) {
		result.baseUrl = stored.baseUrl.trim();
	}
	return result;
}

export async function saveCredentials(credentials: Credentials): Promise<string> {
	const dir = configDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = credentialsPath();
	await writeFile(
		path,
		`${JSON.stringify({ apiKey: credentials.apiKey, baseUrl: credentials.baseUrl }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	await chmod(path, 0o600);
	return path;
}

export async function resolveCredentials(): Promise<Credentials> {
	const stored = await readStoredCredentials();
	const apiKey = (process.env.WIKIVIBE_API_KEY ?? "").trim() || stored.apiKey || "";
	const rawBase = (process.env.WIKIVIBE_BASE_URL ?? "").trim() || stored.baseUrl || DEFAULT_BASE_URL;
	if (!apiKey) throw new MissingCredentialsError();
	return { apiKey, baseUrl: rawBase.replace(/\/+$/, "") };
}

/** Best-effort import of a key already present in an OMP `.env` file. */
export async function importKeyFromOmpEnv(): Promise<string | undefined> {
	const candidates = [
		join(homedir(), ".omp", ".env"),
		join(process.cwd(), ".env"),
	];
	for (const path of candidates) {
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			const match = /^\s*(?:export\s+)?WIKIVIBE_API_KEY\s*=\s*(.*)$/.exec(line);
			if (!match) continue;
			const value = match[1].trim().replace(/^["']|["']$/g, "");
			if (value) return value;
		}
	}
	return undefined;
}
