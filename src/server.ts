import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MissingCredentialsError, resolveCredentials } from "./credentials.js";
import { DEFAULT_IMAGE_MODEL, editImage, generateImage, generateImages, listImageModels } from "./images.js";

const SERVER_INSTRUCTIONS = [
	"Use the wikivibe tools whenever the user asks to draw, render, generate, or edit an image.",
	"`generate_image` creates a new image from a prompt; `edit_image` changes existing images.",
	"Generated files are written to disk and returned as file paths; report the path to the user.",
	"Do not substitute another image provider: the user pays for WikiVibe credits.",
].join(" ");

const SIZE = z
	.enum(["1024x1024", "1536x1024", "1024x1536", "auto"])
	.optional()
	.describe("Output size. 1536x1024 is landscape, 1024x1536 is portrait.");

const QUALITY = z.enum(["low", "medium", "high", "auto"]).optional();

async function run<T>(operation: () => Promise<T>): Promise<
	{ ok: true; value: T } | { ok: false; text: string }
> {
	try {
		return { ok: true, value: await operation() };
	} catch (error) {
		if (error instanceof MissingCredentialsError) {
			return { ok: false, text: `${error.message}\n\nRun: npx -y wikivibe login` };
		}
		if (error instanceof Error) {
			const hint = "hint" in error && typeof error.hint === "string" ? `\n${error.hint}` : "";
			return { ok: false, text: `${error.message}${hint}` };
		}
		return { ok: false, text: String(error) };
	}
}

function summarize(
	model: string,
	images: Array<{ path: string; bytes: number; mimeType: string; base64: string }>,
	revisedPrompts: string[],
): { text: string; content: ContentBlock[] } {
	const lines = [`Generated ${images.length} image(s) with ${model}:`];
	for (const image of images) {
		lines.push(`  ${image.path} (${image.mimeType}, ${Math.round(image.bytes / 1024)} KB)`);
	}
	if (revisedPrompts.length > 0) lines.push(`Revised prompt: ${revisedPrompts.join(" | ")}`);
	const content: ContentBlock[] = [{ type: "text", text: lines.join("\n") }];
	for (const image of images) {
		content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
	}
	return { text: lines.join("\n"), content };
}

export function createServer(): McpServer {
	const server = new McpServer(
		{ name: "wikivibe", version: "0.1.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	server.registerTool(
		"generate_image",
		{
			title: "Generate image (WikiVibe)",
			description:
				"Generate images from text through WikiVibe. Pass `prompt` for one image, `prompts` for several different images, or `n` for variations of the same prompt. Images run sequentially; up to 4 per call.",
			inputSchema: {
				prompt: z
					.string()
					.optional()
					.describe("What to draw. Be specific about subject, style, lighting."),
				prompts: z
					.array(z.string().min(1))
					.min(1)
					.max(4)
					.optional()
					.describe("Several distinct prompts; one image each, generated sequentially."),
				model: z
					.string()
					.optional()
					.describe(`Image model id. Defaults to ${DEFAULT_IMAGE_MODEL}.`),
				size: SIZE,
				quality: QUALITY,
				n: z
					.number()
					.int()
					.min(1)
					.max(4)
					.optional()
					.describe("Variations of `prompt` (default 1). Ignored when `prompts` is used."),
				output_path: z.string().optional().describe("Exact file path for the first image."),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ prompt, prompts, model, size, quality, n, output_path }) => {
			if (!prompt && !prompts) {
				return {
					isError: true,
					content: [{ type: "text", text: "Provide `prompt` (one image) or `prompts` (several)." }],
				};
			}
			const result = await run(async () => {
				const credentials = await resolveCredentials();
				if (prompts) {
					return {
						kind: "batch" as const,
						value: await generateImages(credentials, {
							prompts,
							model,
							size,
							quality,
							outputPath: output_path,
						}),
					};
				}
				return {
					kind: "single" as const,
					value: await generateImage(credentials, {
						prompt: prompt as string,
						model,
						size,
						quality,
						n,
						outputPath: output_path,
					}),
				};
			});
			if (!result.ok) return { isError: true, content: [{ type: "text", text: result.text }] };
			if (result.value.kind === "batch") {
				const { model: used, images, errors } = result.value.value;
				const lines = [`Generated ${images.length} of ${prompts?.length ?? 0} image(s) with ${used}:`];
				for (const image of images) lines.push(`  ${image.path} (${Math.round(image.bytes / 1024)} KB)`);
				for (const failure of errors) lines.push(`  FAILED "${failure.prompt}": ${failure.message}`);
				return {
					...(errors.length > 0 && images.length === 0 ? { isError: true } : {}),
					content: [
						{ type: "text", text: lines.join("\n") },
						...images.map((image) => ({
							type: "image" as const,
							data: image.base64,
							mimeType: image.mimeType,
						})),
					],
				};
			}
			const summary = summarize(result.value.value.model, result.value.value.images, result.value.value.revisedPrompts);
			return { content: summary.content };
		},
	);

	server.registerTool(
		"edit_image",
		{
			title: "Edit image (WikiVibe)",
			description:
				"Edit one or more existing images with a prompt (inpainting, restyle, object changes). Reference images come from local file paths.",
			inputSchema: {
				prompt: z.string().min(1).describe("What to change. Name each input image by role."),
				images: z
					.array(z.string().min(1))
					.min(1)
					.max(4)
					.describe("Local file paths of the source images."),
				model: z.string().optional(),
				size: SIZE,
				quality: QUALITY,
				n: z.number().int().min(1).max(4).optional(),
				output_path: z.string().optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ prompt, images, model, size, quality, n, output_path }) => {
			const result = await run(async () => {
				const credentials = await resolveCredentials();
				return editImage(credentials, {
					prompt,
					model,
					size,
					quality,
					n,
					outputPath: output_path,
					images: images.map((path) => ({ path })),
				});
			});
			if (!result.ok) return { isError: true, content: [{ type: "text", text: result.text }] };
			const summary = summarize(result.value.model, result.value.images, result.value.revisedPrompts);
			return { content: summary.content };
		},
	);

	server.registerTool(
		"list_image_models",
		{
			title: "List image models (WikiVibe)",
			description: "List image-generation models available to the configured WikiVibe key.",
			inputSchema: {},
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			const result = await run(async () => listImageModels(await resolveCredentials()));
			if (!result.ok) return { isError: true, content: [{ type: "text", text: result.text }] };
			const text =
				result.value.length > 0
					? result.value.join("\n")
					: "No image models are visible to this key. Check the key's group permissions.";
			return { content: [{ type: "text", text }] };
		},
	);

	return server;
}

export async function serve(): Promise<void> {
	const server = createServer();
	await server.connect(new StdioServerTransport());
}
