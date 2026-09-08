import { type AgentExecutionGovernor, createRequestDeadline } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { sleep } from "../utils/sleep.js";
import { waitWithAbort } from "../utils/wait-with-abort.js";
import type { SettingsManager } from "./settings-manager.js";

/**
 * The single retry policy (permanent kinds, Retry-After-aware capped delays),
 * shared by the AgentSession auto-retry loop and the one-shot completion
 * consumers (side questions, compaction, refinement, session summaries).
 */
export interface ProviderRetryPolicy {
	execution?: { governor: AgentExecutionGovernor; model: Model<Api> };
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	/** Max server-requested retry delay before giving up; 0 disables the cap. */
	maxRetryDelayMs: number;
}

export function providerRetryPolicy(
	settingsManager: SettingsManager,
	governor?: AgentExecutionGovernor,
	model?: Model<Api>,
): ProviderRetryPolicy {
	return {
		...(governor && model ? { execution: { governor, model } } : {}),
		...settingsManager.getRetrySettings(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	};
}

/** Local listener/lifecycle crashes are not provider failures; never retry them. */
export function isAgentLifecycleFailure(message: AssistantMessage): boolean {
	return message.diagnostics?.some((diagnostic) => diagnostic.type === "agent_lifecycle_failure") ?? false;
}

/** The faux test provider's queue running dry is deterministic; retrying it only stalls tests. */
export function isFauxProviderQueueExhausted(message: AssistantMessage): boolean {
	return message.provider === "faux" && message.errorMessage === "No more faux responses queued";
}

export function providerStreamFailureDetails(message: AssistantMessage): Record<string, unknown> | undefined {
	const failure = message.diagnostics?.find((diagnostic) => diagnostic.type === "provider_stream_failure");
	const details = failure?.details;
	if (!details || typeof details !== "object") {
		return undefined;
	}
	return details;
}

export function providerStreamFailureKind(message: AssistantMessage): string | undefined {
	const kind = providerStreamFailureDetails(message)?.kind;
	return typeof kind === "string" ? kind : undefined;
}

export function providerStreamFailureRetryAfterMs(message: AssistantMessage): number | undefined {
	const value = providerStreamFailureDetails(message)?.retryAfterMs;
	return typeof value === "number" && value >= 0 ? value : undefined;
}

/** Deterministic rejections never retry; auth gets one retry before it can be marked stale. */
export function isPermanentProviderFailureKind(kind: string | undefined, retriesPerformed: number): boolean {
	if (kind === "timeout" || kind === "invalid_request" || kind === "refusal" || kind === "permission") {
		return true;
	}
	return retriesPerformed > 0 && kind === "auth";
}

export type ProviderRetryDelay = { kind: "wait"; delayMs: number } | { kind: "exceeds-cap"; retryAfterMs: number };

/** Node caps timers at 2^31-1 ms; longer delays overflow setTimeout and fire after ~1ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Delay before retry `attempt` (1-based), honoring a server-requested wait. */
export function providerRetryDelay(
	attempt: number,
	retryAfterMs: number | undefined,
	policy: Pick<ProviderRetryPolicy, "baseDelayMs" | "maxRetryDelayMs">,
): ProviderRetryDelay {
	if (retryAfterMs !== undefined && policy.maxRetryDelayMs > 0 && retryAfterMs > policy.maxRetryDelayMs) {
		return { kind: "exceeds-cap", retryAfterMs };
	}
	return {
		kind: "wait",
		delayMs: Math.min(Math.max(policy.baseDelayMs * 2 ** (attempt - 1), retryAfterMs ?? 0), MAX_TIMER_DELAY_MS),
	};
}

/**
 * One-shot completion with the shared retry policy, for consumers outside the
 * AgentSession auto-retry loop (provider SDKs never retry internally).
 */
export async function completeWithProviderRetry(
	attemptCompletion: (signal?: AbortSignal) => Promise<AssistantMessage>,
	options?: { policy?: ProviderRetryPolicy; signal?: AbortSignal; providerTimeoutMs?: number },
): Promise<AssistantMessage> {
	const policy = options?.policy ?? DEFAULT_PROVIDER_RETRY_POLICY;
	const maxRetries = policy.enabled ? policy.maxRetries : 0;
	let retriesPerformed = 0;
	const execution = policy.execution;
	const signals = [options?.signal, execution?.governor.signal].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
	for (;;) {
		signal?.throwIfAborted();
		const reservation = await execution?.governor.beforeModel({ model: execution.model, context: { messages: [] } });
		const deadline = createRequestDeadline(signal, options?.providerTimeoutMs);
		let message: AssistantMessage;
		try {
			signal?.throwIfAborted();
			message = await waitWithAbort(attemptCompletion(deadline.signal), deadline.signal);
			await reservation?.settle(message);
		} catch (error) {
			await reservation?.settle();
			throw error;
		} finally {
			deadline.dispose();
		}
		if (message.stopReason !== "error") {
			return message;
		}
		if (signal?.aborted) {
			// A cancel that raced the failure is an abort, not a provider failure.
			return { ...message, stopReason: "aborted" };
		}
		if (retriesPerformed >= maxRetries || isAgentLifecycleFailure(message) || isFauxProviderQueueExhausted(message)) {
			return message;
		}
		const kind = providerStreamFailureKind(message);
		if (isPermanentProviderFailureKind(kind, retriesPerformed)) {
			return message;
		}
		const delay = providerRetryDelay(retriesPerformed + 1, providerStreamFailureRetryAfterMs(message), policy);
		if (delay.kind === "exceeds-cap") {
			return message;
		}
		try {
			await sleep(delay.delayMs, signal);
		} catch {
			return { ...message, stopReason: "aborted" };
		}
		retriesPerformed++;
	}
}

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxRetryDelayMs: 60000,
};
