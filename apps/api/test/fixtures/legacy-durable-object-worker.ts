const STATE_KEY = "admission";

export class AdmissionController implements DurableObject {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST" || new URL(request.url).pathname !== "/seed") {
			return new Response("Not found", { status: 404 });
		}
		const legacyState: unknown = await request.json();
		await this.state.storage.put(STATE_KEY, legacyState);
		return new Response(null, { status: 204 });
	}
}

export default {
	fetch() {
		return new Response("Legacy Durable Object state test fixture", { status: 200 });
	},
};
