import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentExecutionGovernor, ModelExecutionReservation } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { realpathIfPresentSync, writeFileAtomicSync } from "../utils/atomic-file.js";

export interface ExecutionBudgetLimits {
	maxModelRequests?: number;
	maxToolCalls?: number;
	maxTokens?: number;
	maxCost?: number;
	/** Host-supplied worst-case charge, including provider-specific pricing tiers. */
	maxCostPerModelRequest?: number;
	timeoutMs?: number;
}

type Allowance = { tokens: number; cost: number };
export interface ExecutionBudgetState {
	version: 1;
	id: string;
	limits: ExecutionBudgetLimits;
	startedAt: number;
	deadline?: number;
	modelRequests: number;
	toolCalls: number;
	tokens: number;
	cost: number;
	pending: Record<string, Allowance>;
	exhausted?: string;
}

export class ExecutionBudgetExhaustedError extends Error {
	constructor(readonly reason: string) {
		super(`Execution budget exhausted: ${reason}`);
		this.name = "ExecutionBudgetExhaustedError";
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateLimits(value: unknown): asserts value is ExecutionBudgetLimits {
	if (!record(value)) throw new Error("Invalid execution budget limits");
	for (const [key, limit] of Object.entries(value)) {
		if (
			!["maxModelRequests", "maxToolCalls", "maxTokens", "maxCost", "maxCostPerModelRequest", "timeoutMs"].includes(
				key,
			) ||
			!nonnegative(limit) ||
			(["maxModelRequests", "maxToolCalls", "maxTokens", "timeoutMs"].includes(key) && !Number.isSafeInteger(limit))
		)
			throw new Error(`Invalid execution budget limit: ${key}`);
	}
	if (value.maxCost !== undefined && value.maxCostPerModelRequest === undefined) {
		throw new Error("A cost cap requires a host-supplied maxCostPerModelRequest bound");
	}
}

function parseState(text: string): ExecutionBudgetState {
	const value: unknown = JSON.parse(text);
	if (!record(value)) throw new Error("Invalid execution budget state");
	validateLimits(value.limits);
	if (
		value.version !== 1 ||
		typeof value.id !== "string" ||
		!nonnegative(value.startedAt) ||
		(value.deadline !== undefined && !nonnegative(value.deadline)) ||
		!nonnegative(value.modelRequests) ||
		!Number.isSafeInteger(value.modelRequests) ||
		!nonnegative(value.toolCalls) ||
		!Number.isSafeInteger(value.toolCalls) ||
		!nonnegative(value.tokens) ||
		!nonnegative(value.cost) ||
		(value.exhausted !== undefined && typeof value.exhausted !== "string") ||
		!record(value.pending) ||
		!Object.values(value.pending).every(
			(entry) => record(entry) && nonnegative(entry.tokens) && nonnegative(entry.cost),
		)
	)
		throw new Error("Invalid execution budget state; refusing to reset its allowance");
	return value as unknown as ExecutionBudgetState;
}

/** One account shared by every worker in a session family. Unknown requests stay reserved after restart. */
export class ExecutionBudget implements AgentExecutionGovernor {
	private readonly controller = new AbortController();
	private timer?: ReturnType<typeof setTimeout>;
	private state: ExecutionBudgetState;
	private tail: Promise<unknown> = Promise.resolve();
	readonly path?: string;

	constructor(limits: ExecutionBudgetLimits, path?: string) {
		validateLimits(limits);
		if (path) {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			this.path = realpathIfPresentSync(join(realpathSync(dirname(path)), path.split(/[\\/]/).at(-1)!));
		}
		this.state = {
			version: 1,
			id: randomUUID(),
			limits: { ...limits },
			startedAt: Date.now(),
			modelRequests: 0,
			toolCalls: 0,
			tokens: 0,
			cost: 0,
			pending: {},
		};
		if (limits.timeoutMs !== undefined) this.state.deadline = this.state.startedAt + limits.timeoutMs;
		if (this.path && existsSync(this.path)) this.state = parseState(readFileSync(this.path, "utf8"));
		this.armDeadline();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get cachedState(): ExecutionBudgetState {
		return structuredClone(this.state);
	}

	private armDeadline(): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.state.exhausted) {
			this.controller.abort(new ExecutionBudgetExhaustedError(this.state.exhausted));
			return;
		}
		if (this.state.deadline === undefined) return;
		const remaining = this.state.deadline - Date.now();
		this.timer = setTimeout(
			() => {
				if (this.state.deadline !== undefined && Date.now() < this.state.deadline) {
					this.armDeadline();
					return;
				}
				this.controller.abort(new ExecutionBudgetExhaustedError("deadline"));
				void this.transact((state) => {
					state.exhausted ??= "deadline";
				}).catch(() => undefined);
			},
			Math.min(Math.max(remaining, 0), 2_147_483_647),
		);
		this.timer.unref();
	}

	private transact<T>(update: (state: ExecutionBudgetState) => T): Promise<T> {
		const operation = this.tail.then(async () => {
			let compromised: Error | undefined;
			const release = this.path
				? await lockfile.lock(`${this.path}.transaction`, {
						realpath: false,
						stale: 30_000,
						retries: { retries: 100, minTimeout: 5, maxTimeout: 50 },
						onCompromised: (error) => {
							compromised = error;
						},
					})
				: undefined;
			try {
				const next =
					this.path && existsSync(this.path)
						? parseState(readFileSync(this.path, "utf8"))
						: structuredClone(this.state);
				if (next.deadline !== undefined && Date.now() >= next.deadline) next.exhausted ??= "deadline";
				const result = update(next);
				if (compromised) throw compromised;
				if (this.path)
					writeFileAtomicSync(this.path, JSON.stringify(next), { mode: 0o600, fsync: true, fsyncDir: true });
				this.state = next;
				this.armDeadline();
				return result;
			} catch (error) {
				this.controller.abort(error);
				throw error;
			} finally {
				await release?.();
			}
		});
		this.tail = operation.catch(() => undefined);
		return operation;
	}

	async snapshot(): Promise<ExecutionBudgetState> {
		return this.transact((state) => structuredClone(state));
	}

	private async admit(kind: "model" | "tool", allowance: Allowance): Promise<string> {
		const id = randomUUID();
		const reason = await this.transact((state) => {
			const limits = state.limits;
			const pending = Object.values(state.pending);
			state.exhausted ??=
				kind === "model" && limits.maxModelRequests !== undefined && state.modelRequests >= limits.maxModelRequests
					? "model requests"
					: kind === "tool" && limits.maxToolCalls !== undefined && state.toolCalls >= limits.maxToolCalls
						? "tool calls"
						: limits.maxTokens !== undefined &&
								state.tokens + pending.reduce((sum, entry) => sum + entry.tokens, 0) + allowance.tokens >
									limits.maxTokens
							? "token reservation"
							: limits.maxCost !== undefined &&
									state.cost + pending.reduce((sum, entry) => sum + entry.cost, 0) + allowance.cost >
										limits.maxCost
								? "cost reservation"
								: undefined;
			if (state.exhausted) return state.exhausted;
			if (kind === "model") {
				state.modelRequests++;
				state.pending[id] = allowance;
			} else state.toolCalls++;
			return undefined;
		});
		if (reason) throw new ExecutionBudgetExhaustedError(reason);
		return id;
	}

	async beforeModel(request: {
		model: Model<Api>;
		context: Context;
		maxTokens?: number;
	}): Promise<ModelExecutionReservation> {
		// Context estimates are not upper bounds. Reserve the provider's entire accepted
		// context plus its output ceiling, even when that conservatively denies a small request.
		const limits = (await this.snapshot()).limits;
		const tokens =
			limits.maxTokens === undefined
				? 0
				: request.model.contextWindow + Math.max(request.model.maxTokens, request.maxTokens ?? 0);
		if (!nonnegative(tokens) || !Number.isSafeInteger(tokens))
			throw new Error("No valid model token reservation bound");
		const id = await this.admit("model", { tokens, cost: limits.maxCostPerModelRequest ?? 0 });
		return {
			settle: async (message) => {
				if (!message || message.stopReason === "error" || message.stopReason === "aborted") return;
				const usage = message.usage;
				const actualTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				if (!nonnegative(actualTokens) || !nonnegative(usage.cost.total)) throw new Error("Invalid provider usage");
				await this.transact((state) => {
					const reserved = state.pending[id];
					if (!reserved) return;
					delete state.pending[id];
					state.tokens += actualTokens;
					state.cost += usage.cost.total;
					if (state.limits.maxTokens !== undefined && actualTokens > reserved.tokens)
						state.exhausted ??= "provider exceeded token reservation";
					if (state.limits.maxCost !== undefined && usage.cost.total > reserved.cost)
						state.exhausted ??= "provider exceeded cost reservation";
				});
			},
		};
	}

	async beforeTool(_toolCallId: string, _toolName: string): Promise<void> {
		await this.admit("tool", { tokens: 0, cost: 0 });
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.controller.abort(new Error("Execution budget owner disposed"));
	}
}
