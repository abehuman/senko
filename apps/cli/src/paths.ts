import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function xdgHome(envValue: string | undefined, fallback: string): string {
	return envValue && isAbsolute(envValue) ? envValue : fallback;
}

export function getConfigHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return xdgHome(env.XDG_CONFIG_HOME, join(home, ".config"));
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(getConfigHome(env, home), "senko", "config.json");
}

export function getStateHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return xdgHome(env.XDG_STATE_HOME, join(home, ".local", "state"));
}

export function getSessionsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(getStateHome(env, home), "senko", "sessions");
}
