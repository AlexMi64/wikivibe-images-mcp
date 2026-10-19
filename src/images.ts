import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { getJson, postForm, postJson } from "./api.js";
import type { Credentials } from "./credentials.js";

export const DEFAULT_IMAGE_MODEL = process.env.WIKIVIBE_IMAGE_MODEL?.trim() || "gpt-image-2.5";

const MAX_IMAGES_PER_CALL = 4;

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
};

interface ImagesResponse {
	data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
	usage?: unknown;
}

export interface GeneratedImage {
	path: string;
	mimeType: string;
	bytes: number;
	base64: string;
}

export interface GenerateResult {
	model: string;
	images: GeneratedImage[];
	revisedPrompts: string[];
	usage?: unknown;
}

export interface ReferenceImage {
	path?: string;
	base64?: string;
	mimeType?: string;
}

function outputDir(): string {
	const configured = process.env.WIKIVIBE_OUTPUT_DIR?.trim();
	return configured ? resolve(configured) : join(tmpdir(), "wikivibe-images");
}

function slugify(prompt: string): string {
	const slug = prompt
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "image";
}

async function persistImage(
	bytes: Buffer,
	mimeType: string,
	prompt: string,
	index: number,
	outputPath: string | undefined,
): Promise<GeneratedImage> {
	const extension = MIME_EXTENSIONS[mimeType] ?? ".png";
	const directory = outputDir();
	await mkdir(directory, { recursive: true });
	const target =
		outputPath && index === 0
			? isAbsolute(outputPath)
				? outputPath
				: resolve(outputPath)
			: join(
					directory,
					`${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(prompt)}${index > 0 ? `-${index + 1}` : ""}${extname(outputPath ?? "") || extension}`,
				);
	await writeFile(target, bytes);
	return { path: target, mimeType, bytes: bytes.byteLength, base64: bytes.toString("base64") };
}

async function collectImages(
	response: ImagesResponse,
	prompt: string,
	outputPath: string | undefined,
): Promise<{ images: GeneratedImage[]; revisedPrompts: string[] }> {
	const images: GeneratedImage[] = [];
	const revisedPrompts: string[] = [];
	for (const [index, item] of (response.data ?? []).entries()) {
		if (item.revised_prompt) revisedPrompts.push(item.revised_prompt);
		if (item.b64_json) {
			const bytes = Buffer.from(item.b64_json, "base64");
			images.push(await persistImage(bytes, sniffMime(bytes), prompt, index, outputPath));
			continue;
		}
		if (item.url) {
			const downloaded = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
			if (!downloaded.ok) throw new Error(`Failed to download image: HTTP ${downloaded.status}`);
			const bytes = Buffer.from(await downloaded.arrayBuffer());
			const mimeType = downloaded.headers.get("content-type")?.split(";")[0] ?? sniffMime(bytes);
			images.push(await persistImage(bytes, mimeType, prompt, index, outputPath));
		}
	}
	return { images, revisedPrompts };
}

function sniffMime(bytes: Buffer): string {
	if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
	if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
		return "image/webp";
	}
	if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
	return "image/png";
}

export interface GenerateOptions {
	prompt: string;
	model?: string;
	size?: string;
	quality?: string;
	background?: string;
	/** Number of variations of the same prompt. Executed as sequential single-image requests. */
	n?: number;
	outputPath?: string;
	/** Reports progress: (done, total). */
	onProgress?: (done: number, total: number) => void;
}

interface SingleResult {
	images: GeneratedImage[];
	revisedPrompts: string[];
	usage?: unknown;
}

/**
 * The gateway forwards `n` inside the Responses `image_generation` tool, which upstream rejects
 * with `unknown_parameter: tools[0].n`. So variations are produced by repeated single requests,
 * which the request queue already serializes.
 */
async function generateOne(
	credentials: Credentials,
	options: GenerateOptions,
	model: string,
	index: number,
): Promise<SingleResult> {
	const body: Record<string, unknown> = { model, prompt: options.prompt, n: 1 };
	if (options.size) body.size = options.size;
	if (options.quality) body.quality = options.quality;
	if (options.background) body.background = options.background;
	const response = await postJson<ImagesResponse>(credentials, "/images/generations", body);
	const collected = await collectImages(
		response,
		options.prompt,
		index === 0 ? options.outputPath : undefined,
	);
	return { ...collected, usage: response.usage };
}

export async function generateImage(
	credentials: Credentials,
	options: GenerateOptions,
): Promise<GenerateResult> {
	const model = options.model?.trim() || DEFAULT_IMAGE_MODEL;
	const total = Math.min(Math.max(options.n ?? 1, 1), MAX_IMAGES_PER_CALL);
	const images: GeneratedImage[] = [];
	const revisedPrompts: string[] = [];
	let usage: unknown;
	for (let index = 0; index < total; index += 1) {
		const result = await generateOne(credentials, options, model, index);
		images.push(...result.images);
		revisedPrompts.push(...result.revisedPrompts);
		usage = result.usage ?? usage;
		options.onProgress?.(index + 1, total);
	}
	return { model, images, revisedPrompts, usage };
}

export interface BatchGenerateOptions {
	prompts: string[];
	model?: string;
	size?: string;
	quality?: string;
	outputPath?: string;
	onProgress?: (done: number, total: number) => void;
}

export interface BatchGenerateResult {
	model: string;
	images: GeneratedImage[];
	errors: Array<{ prompt: string; message: string }>;
}

/** Several different prompts in one call, one image each, strictly sequential. */
export async function generateImages(
	credentials: Credentials,
	options: BatchGenerateOptions,
): Promise<BatchGenerateResult> {
	const model = options.model?.trim() || DEFAULT_IMAGE_MODEL;
	const prompts = options.prompts.slice(0, MAX_IMAGES_PER_CALL);
	const images: GeneratedImage[] = [];
	const errors: BatchGenerateResult["errors"] = [];
	for (const [index, prompt] of prompts.entries()) {
		try {
			const result = await generateOne(
				credentials,
				{ prompt, size: options.size, quality: options.quality, outputPath: options.outputPath },
				model,
				images.length,
			);
			images.push(...result.images);
		} catch (error) {
			errors.push({ prompt, message: error instanceof Error ? error.message : String(error) });
		}
		options.onProgress?.(index + 1, prompts.length);
	}
	return { model, images, errors };
}

export interface EditOptions {
	prompt: string;
	images: ReferenceImage[];
	model?: string;
	size?: string;
	quality?: string;
	/** Number of edit variations. Executed as sequential single-image requests. */
	n?: number;
	outputPath?: string;
	onProgress?: (done: number, total: number) => void;
}

export async function editImage(credentials: Credentials, options: EditOptions): Promise<GenerateResult> {
	const total = Math.min(Math.max(options.n ?? 1, 1), MAX_IMAGES_PER_CALL);
	const images: GeneratedImage[] = [];
	const revisedPrompts: string[] = [];
	let usage: unknown;
	for (let index = 0; index < total; index += 1) {
		const result = await editOne(credentials, options, index);
		images.push(...result.images);
		revisedPrompts.push(...result.revisedPrompts);
		usage = result.usage ?? usage;
		options.onProgress?.(index + 1, total);
	}
	return {
		model: options.model?.trim() || DEFAULT_IMAGE_MODEL,
		images,
		revisedPrompts,
		usage,
	};
}

async function editOne(
	credentials: Credentials,
	options: EditOptions,
	index: number,
): Promise<SingleResult> {
	const model = options.model?.trim() || DEFAULT_IMAGE_MODEL;
	const form = new FormData();
	form.set("model", model);
	form.set("prompt", options.prompt);
	if (options.size) form.set("size", options.size);
	if (options.quality) form.set("quality", options.quality);
	for (const [index, reference] of options.images.entries()) {
		if (reference.path) {
			const bytes = await readFile(reference.path).catch(() => {
				throw new Error(`Reference image not found: ${reference.path}`);
			});
			form.append(
				"image[]",
				new Blob([bytes], { type: reference.mimeType ?? sniffMime(bytes) }),
				`image-${index + 1}${extname(reference.path) || ".png"}`,
			);
			continue;
		}
		if (reference.base64) {
			const bytes = Buffer.from(reference.base64.replace(/^data:[^;]+;base64,/, ""), "base64");
			const mimeType = reference.mimeType ?? sniffMime(bytes);
			form.append("image[]", new Blob([bytes], { type: mimeType }), `image-${index + 1}`);
		}
	}
	const response = await postForm<ImagesResponse>(credentials, "/images/edits", form);
	const collected = await collectImages(
		response,
		options.prompt,
		index === 0 ? options.outputPath : undefined,
	);
	return { ...collected, usage: response.usage };
}

interface ModelsResponse {
	data?: Array<{ id?: string }>;
}

export async function listImageModels(credentials: Credentials): Promise<string[]> {
	const response = await getJson<ModelsResponse>(credentials, "/models");
	return (response.data ?? [])
		.map((model) => model.id)
		.filter((id): id is string => typeof id === "string" && /image/i.test(id))
		.sort();
}
