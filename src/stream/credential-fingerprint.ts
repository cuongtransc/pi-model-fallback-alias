import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Reader = (path: string) => string;

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

/**
 * Identify the credential pi holds for a provider. `access` and `expires`
 * rotate on every token refresh, so they are left out. Only the hash leaves.
 */
export function credentialFingerprint(
	provider: string,
	agentDir: string,
	readFile: Reader = (path) => readFileSync(path, "utf8"),
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
	if (auth === undefined && apiKey === undefined) return "none";
	const text = JSON.stringify(canonical({ auth, apiKey }));
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
