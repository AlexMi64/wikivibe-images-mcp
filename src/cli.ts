#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	configDir,
	credentialsPath,
	DEFAULT_BASE_URL,
	importKeyFromOmpEnv,
	resolveCredentials,
	saveCredentials,
} from "./credentials.js";
import { generateImage, listImageModels } from "./images.js";
import { serve } from "./server.js";

type ClientId = "omp" | "claude" | "codex" | "cursor" | "opencode";

const CLIENT_ALIASES: Record<string, ClientId> = {
	omp: "omp",
	"oh-my-pi": "omp",
	pi: "omp",
	claude: "claude",
	"claude-code": "claude",
	codex: "codex",
	cursor: "cursor",
	opencode: "opencode",
	orca: "opencode",
};

/**
 * Clients must not depend on the checkout path or the npx cache, both of which move.
 * Copy the running bundle into ~/.wikivibe/bin and point every client at that copy.
 */
async function installStableCopy(): Promise<string> {
	const target = join(configDir(), "bin", "wikivibe-images-mcp.js");
	await mkdir(join(configDir(), "bin"), { recursive: true, mode: 0o700 });
	await copyFile(fileURLToPath(import.meta.url), target);
	await chmod(target, 0o755);
	return target;
}

function printHelp(): void {
	console.log(`wikivibe — WikiVibe image generation for coding agents

Usage:
  wikivibe-images                     Run the MCP server over stdio (what clients call)
  wikivibe-images mcp                 Same, explicit
  wikivibe-images login [--key KEY]   Save an API key to ${credentialsPath()}
  wikivibe-images status              Show the resolved key, base URL, and image models
  wikivibe-images models              List image models
  wikivibe-images image <prompt>      Generate an image from the shell
  wikivibe-images setup [clients]     Register the MCP server in agent configs
                                      clients: omp, claude, codex, cursor, opencode, all

Environment:
  WIKIVIBE_API_KEY     Overrides the stored key
  WIKIVIBE_BASE_URL    Defaults to ${DEFAULT_BASE_URL}
  WIKIVIBE_IMAGE_MODEL Default image model
  WIKIVIBE_OUTPUT_DIR  Where generated files are written`);
}

async function promptHidden(question: string): Promise<string> {
	process.stderr.write(question);
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
		process.stderr.write("\n");
		return Buffer.concat(chunks).toString("utf8").trim();
	}
	return await new Promise<string>((resolvePromise) => {
		const stdin = process.stdin;
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		let value = "";
		const onData = (char: string) => {
			if (char === "\r" || char === "\n") {
				stdin.setRawMode(false);
				stdin.pause();
				stdin.off("data", onData);
				process.stderr.write("\n");
				resolvePromise(value.trim());
				return;
			}
			if (char === "\u0003") {
				stdin.setRawMode(false);
				process.stderr.write("\n");
				process.exit(130);
			}
			if (char === "\u007f") {
				value = value.slice(0, -1);
				return;
			}
			value += char;
		};
		stdin.on("data", onData);
	});
}

async function login(argv: string[]): Promise<void> {
	const flagIndex = argv.indexOf("--key");
	let key = flagIndex >= 0 ? argv[flagIndex + 1]?.trim() : undefined;
	if (!key) key = await promptHidden("WikiVibe API key: ");
	if (!key) {
		console.error("No key provided.");
		process.exitCode = 1;
		return;
	}
	const baseUrl = (process.env.WIKIVIBE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	let models: string[];
	try {
		models = await listImageModels({ apiKey: key, baseUrl });
	} catch (error) {
		console.error(`Key check failed: ${error instanceof Error ? error.message : String(error)}`);
		console.error("Nothing was saved.");
		process.exitCode = 1;
		return;
	}
	const path = await saveCredentials({ apiKey: key, baseUrl });
	console.log(`Saved ${path} (mode 600).`);
	console.log(
		models.length > 0
			? `Image models: ${models.join(", ")}`
			: "Warning: this key sees no image models; image generation may be disabled for its group.",
	);
}

async function status(): Promise<void> {
	const credentials = await resolveCredentials();
	const masked = `${credentials.apiKey.slice(0, 6)}…${credentials.apiKey.slice(-4)}`;
	console.log(`Key:      ${masked}`);
	console.log(`Base URL: ${credentials.baseUrl}`);
	console.log(`Stored:   ${credentialsPath()}${existsSync(credentialsPath()) ? "" : " (absent, using env)"}`);
	const models = await listImageModels(credentials);
	console.log(`Models:   ${models.length > 0 ? models.join(", ") : "none visible"}`);
}

async function image(argv: string[]): Promise<void> {
	const prompt = argv.join(" ").trim();
	if (!prompt) {
		console.error('Usage: wikivibe-images image "<prompt>"');
		process.exitCode = 1;
		return;
	}
	const result = await generateImage(await resolveCredentials(), { prompt });
	for (const generated of result.images) console.log(generated.path);
}

interface McpServerEntry {
	command: string;
	args: string[];
	timeout?: number;
}

/** Image generation takes 25-45 s per image; up to 4 per call plus retries. */
const MCP_TIMEOUT_MS = 300_000;
const MCP_TOOL_TIMEOUT_SEC = 300;

async function mergeJsonConfig(path: string, serversKey: string, value: unknown): Promise<string> {
	let root: Record<string, unknown> = {};
	if (existsSync(path)) {
		const raw = await readFile(path, "utf8");
		const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			root = parsed as Record<string, unknown>;
		}
	}
	const current = root[serversKey];
	const servers =
		current && typeof current === "object" && !Array.isArray(current)
			? (current as Record<string, unknown>)
			: {};
	servers.wikivibe = value;
	root[serversKey] = servers;
	await writeFile(path, `${JSON.stringify(root, null, 2)}\n`);
	return path;
}

async function patchCodexTimeout(): Promise<void> {
	const path = join(homedir(), ".codex", "config.toml");
	const current = await readFile(path, "utf8");
	const block = /\[mcp_servers\.wikivibe\][\s\S]*?(?=\n\[|$)/.exec(current);
	if (!block) return;
	if (/tool_timeout_sec\s*=/.test(block[0])) return;
	const patched = `${block[0].replace(/\s+$/, "")}\ntool_timeout_sec = ${MCP_TOOL_TIMEOUT_SEC}`;
	await writeFile(path, current.replace(block[0], patched));
}

function runCli(command: string, args: string[]): boolean {
	const result = spawnSync(command, args, { stdio: "ignore" });
	return result.status === 0;
}

async function setupOne(client: ClientId, entry: McpServerEntry): Promise<string> {
	switch (client) {
		case "claude":
			if (runCli("claude", ["mcp", "add", "--scope", "user", "wikivibe", "--", entry.command, ...entry.args])) {
				return "~/.claude.json (via `claude mcp add`)";
			}
			break;
		case "codex":
			if (runCli("codex", ["mcp", "add", "wikivibe", "--", entry.command, ...entry.args])) {
				// `codex mcp add` cannot set tool_timeout_sec, and the 60 s default is too short.
				await patchCodexTimeout();
				return "~/.codex/config.toml (via `codex mcp add`)";
			}
			break;
	}
	switch (client) {
		case "omp":
			return await mergeJsonConfig(join(homedir(), ".omp", "agent", "mcp.json"), "mcpServers", {
				command: entry.command,
				args: entry.args,
				timeout: MCP_TIMEOUT_MS,
			});
		case "cursor":
			return await mergeJsonConfig(join(homedir(), ".cursor", "mcp.json"), "mcpServers", entry);
		case "claude":
			return await mergeJsonConfig(join(homedir(), ".claude.json"), "mcpServers", entry);
		case "opencode":
			return await mergeJsonConfig(join(homedir(), ".config", "opencode", "opencode.json"), "mcp", {
				type: "local",
				command: [entry.command, ...entry.args],
				enabled: true,
			});
		case "codex": {
			const path = join(homedir(), ".codex", "config.toml");
			const block = [
				"[mcp_servers.wikivibe]",
				`command = ${JSON.stringify(entry.command)}`,
				`args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
				`tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SEC}`,
				"",
			].join("\n");
			const current = existsSync(path) ? await readFile(path, "utf8") : "";
			const replaced = /\[mcp_servers\.wikivibe\]/.test(current)
				? current.replace(/\[mcp_servers\.wikivibe\][^\[]*/, `${block}\n`)
				: `${current.replace(/\s*$/, "")}\n\n${block}`;
			await writeFile(path, replaced);
			return path;
		}
	}
}

async function setup(argv: string[]): Promise<void> {
	const requested = argv.filter((arg) => !arg.startsWith("-"));
	const clients: ClientId[] =
		requested.length === 0 || requested.includes("all")
			? ["omp", "claude", "codex", "cursor", "opencode"]
			: requested.map((name) => {
					const mapped = CLIENT_ALIASES[name.toLowerCase()];
					if (!mapped) throw new Error(`Unknown client: ${name}`);
					return mapped;
				});
	const script = await installStableCopy();
	const entry = { command: process.execPath, args: [script, "mcp"] };
	for (const client of clients) {
		try {
			const path = await setupOne(client, entry);
			console.log(`✓ ${client}: ${path}`);
		} catch (error) {
			console.error(`✗ ${client}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	console.log("\nRestart the agents to pick up the server. No API key goes into these files.");
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	switch (command) {
		case undefined:
		case "mcp":
			await serve();
			return;
		case "login":
			await login(rest);
			return;
		case "status":
			await status();
			return;
		case "models": {
			const models = await listImageModels(await resolveCredentials());
			console.log(models.length > 0 ? models.join("\n") : "No image models visible.");
			return;
		}
		case "image":
			await image(rest);
			return;
		case "setup":
			await setup(rest);
			return;
		case "import":
			return await importFlow();
		case "-h":
		case "--help":
		case "help":
			printHelp();
			return;
		default:
			console.error(`Unknown command: ${command}\n`);
			printHelp();
			process.exitCode = 1;
	}
}

async function importFlow(): Promise<void> {
	const key = await importKeyFromOmpEnv();
	if (!key) {
		console.error("No WIKIVIBE_API_KEY found in ~/.omp/.env or ./.env");
		process.exitCode = 1;
		return;
	}
	const path = await saveCredentials({ apiKey: key, baseUrl: DEFAULT_BASE_URL });
	console.log(`Imported key into ${path}.`);
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
