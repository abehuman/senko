import { Client, type ClientConfig, type QueryResult, type QueryResultRow } from "pg";
import type { CloudflareBindings } from "./types";

export const DATABASE_CONNECTION_TIMEOUT_MS = 10_000;
export const DATABASE_QUERY_TIMEOUT_MS = 5_000;

export type DatabaseConfigResult =
	| { connectionString: string; hashSecret: string; ok: true }
	| { message: string; ok: false };

export interface DatabaseClient {
	connect(): Promise<unknown>;
	end(): Promise<void>;
	query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export type DatabaseClientFactory = (config: ClientConfig) => DatabaseClient;

const defaultClientFactory: DatabaseClientFactory = (config) => new Client(config);

export function getDatabaseConfig(env: CloudflareBindings): DatabaseConfigResult {
	const connectionString = env.SENKO_DATABASE_URL?.trim();
	const hashSecret = env.SENKO_API_KEY_HASH_SECRET_V1?.trim();
	if (!connectionString || !hashSecret) {
		return {
			message:
				"Set the SENKO_DATABASE_URL and SENKO_API_KEY_HASH_SECRET_V1 Worker secrets before using database identity.",
			ok: false,
		};
	}
	if (new TextEncoder().encode(hashSecret).byteLength < 32) {
		return { message: "SENKO_API_KEY_HASH_SECRET_V1 must contain at least 32 bytes.", ok: false };
	}

	let url: URL;
	try {
		url = new URL(connectionString);
	} catch {
		return { message: "SENKO_DATABASE_URL must be a valid PostgreSQL connection URL.", ok: false };
	}
	if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || !url.username || !url.password || !url.hostname) {
		return { message: "SENKO_DATABASE_URL must include PostgreSQL credentials and a hostname.", ok: false };
	}
	if (url.pathname === "" || url.pathname === "/") {
		return { message: "SENKO_DATABASE_URL must include a database name.", ok: false };
	}
	if (url.searchParams.get("sslmode") !== "require" || url.searchParams.get("uselibpqcompat") !== "true") {
		return {
			message: "SENKO_DATABASE_URL must set uselibpqcompat=true and sslmode=require for the Railway TLS endpoint.",
			ok: false,
		};
	}
	return { connectionString, hashSecret, ok: true };
}

export async function withDatabaseClient<T>(
	connectionString: string,
	operation: (client: DatabaseClient) => Promise<T>,
	clientFactory: DatabaseClientFactory = defaultClientFactory,
): Promise<T> {
	const client = clientFactory({
		application_name: "senko-api-worker",
		connectionString,
		connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
		keepAlive: true,
		query_timeout: DATABASE_QUERY_TIMEOUT_MS,
		statement_timeout: DATABASE_QUERY_TIMEOUT_MS,
	});
	try {
		await client.connect();
		return await operation(client);
	} finally {
		await client.end().catch(() => undefined);
	}
}
