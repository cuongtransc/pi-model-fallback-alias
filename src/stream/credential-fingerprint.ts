import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";

type Reader = (path: string) => string;
type Env = Readonly<Record<string, string | undefined>>;

// pi's config-value template: "$NAME" and "${NAME}" read the environment; "$$" and "$!" are escapes.
const ENV_REFERENCE = /\$(?:\$|!|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string, readFile: Reader): unknown {
	try {
		return JSON.parse(readFile(path));
	} catch {
		return undefined;
	}
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key]);
		return sorted;
	}
	return value;
}

/** Values of the env vars a models.json apiKey references; a "!command" key is hashed as text. */
function referencedEnv(apiKey: string, env: Env): Record<string, string | undefined> | undefined {
	if (apiKey.startsWith("!")) return undefined;
	const values: Record<string, string | undefined> = {};
	for (const [, braced, bare] of apiKey.matchAll(ENV_REFERENCE)) {
		const name = braced ?? bare;
		if (name !== undefined) values[name] = env[name] || undefined;
	}
	return Object.keys(values).length > 0 ? values : undefined;
}

/**
 * Identify the credential pi uses for a provider, in pi's order: the auth.json
 * entry, else the models.json apiKey (with the env vars it references), else
 * the provider's env key. `access` and `expires` rotate on every token
 * refresh, so they are left out. Only the hash leaves.
 */
export function credentialFingerprint(
	provider: string,
	agentDir: string,
	readFile: Reader = (path) => readFileSync(path, "utf8"),
	env: Env = process.env,
): string {
	const authFile = readJson(join(agentDir, "auth.json"), readFile);
	const entry = isRecord(authFile) ? authFile[provider] : undefined;
	let auth: unknown;
	if (isRecord(entry)) {
		const { access: _access, expires: _expires, ...stable } = entry;
		auth = stable;
	}
	const modelsFile = readJson(join(agentDir, "models.json"), readFile);
	const providers = isRecord(modelsFile) ? modelsFile.providers : undefined;
	const config = isRecord(providers) ? providers[provider] : undefined;
	const apiKey = isRecord(config) && typeof config.apiKey === "string" ? config.apiKey : undefined;
	const apiKeyEnv = apiKey === undefined ? undefined : referencedEnv(apiKey, env);
	const envKey = auth === undefined && apiKey === undefined ? getEnvApiKey(provider, env as Record<string, string>) : undefined;
	if (auth === undefined && apiKey === undefined && envKey === undefined) return "none";
	const text = JSON.stringify(canonical({ auth, apiKey, apiKeyEnv, envKey }));
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
