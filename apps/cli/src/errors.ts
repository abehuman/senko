export class SenkoError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1, options?: ErrorOptions) {
		super(message, options);
		this.name = "SenkoError";
		this.exitCode = exitCode;
	}
}

export class UsageError extends SenkoError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, 2, options);
		this.name = "UsageError";
	}
}
