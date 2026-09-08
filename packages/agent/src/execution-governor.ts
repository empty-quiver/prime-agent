import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

/** Host-owned admission. A reservation must be durable before it resolves. */
export interface ModelExecutionReservation {
	/** Missing or unsuccessful outcomes retain the reservation as potentially spent. */
	settle(message?: AssistantMessage): Promise<void>;
}

export interface AgentExecutionGovernor {
	readonly signal: AbortSignal;
	beforeModel(request: {
		model: Model<Api>;
		context: Context;
		maxTokens?: number;
	}): Promise<ModelExecutionReservation>;
	beforeTool(toolCallId: string, toolName: string): Promise<void>;
}
