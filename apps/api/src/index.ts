import { createApp } from "./app";
import { consoleOperationalLogger, emitOperationalEvent } from "./observability";
import type { CloudflareBindings } from "./types";
import { postgresUsageService } from "./usage";

export { AdmissionController } from "./admission";
export { ProviderPoolController } from "./provider-pool";

const app = createApp();

export default {
	fetch(request: Request, env: CloudflareBindings, executionCtx: ExecutionContext) {
		return app.fetch(request, env, executionCtx);
	},
	scheduled(_controller: ScheduledController, env: CloudflareBindings, executionCtx: ExecutionContext) {
		const reconciliation = postgresUsageService
			.reconcileExpired(env)
			.then((result) => {
				if (!result.ok) {
					emitOperationalEvent(consoleOperationalLogger, {
						event: "usage_reconciliation_completed",
						failure_category: "usage",
						outcome: "failed",
						terminal_reason: result.reason,
					});
					return;
				}
				emitOperationalEvent(consoleOperationalLogger, {
					candidates: result.value.candidates,
					event: "usage_reconciliation_completed",
					failed: result.value.failed,
					failure_category: result.value.failed > 0 ? "usage" : undefined,
					outcome: result.value.failed > 0 ? "failed" : "succeeded",
					settled: result.value.settled,
					skipped: result.value.skipped,
				});
			})
			.catch(() => {
				emitOperationalEvent(consoleOperationalLogger, {
					event: "usage_reconciliation_completed",
					failure_category: "usage",
					outcome: "failed",
					terminal_reason: "exception",
				});
			});
		executionCtx.waitUntil(reconciliation);
	},
};
