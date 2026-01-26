import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEV_VARS = resolve(process.cwd(), ".dev.vars");
const REQUIRED_KEY = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";

function loadDevVars(filePath: string) {
	try {
		const content = readFileSync(filePath, "utf-8");
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const eq = line.indexOf("=");
			if (eq === -1) continue;
			const key = line.slice(0, eq).trim();
			let value = line.slice(eq + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			if (!process.env[key]) {
				process.env[key] = value;
			}
		}
	} catch (error) {
		// ignore if missing
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
}

loadDevVars(DEV_VARS);

if (!process.env[REQUIRED_KEY]) {
	console.error(
		`Missing ${REQUIRED_KEY}. Set it in .dev.vars or export it before running.`,
	);
	process.exit(1);
}

const child = spawn("wrangler", ["dev"], {
	stdio: "inherit",
	env: process.env,
});

child.on("exit", (code) => {
	process.exit(code ?? 1);
});
