/** A local error does not prove that an external operation failed to commit. */
export class UnknownOperationError extends Error {
	readonly kind = "operation_unknown";
	readonly outcome = "unknown";
	readonly retrySafe = false;
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "UnknownOperationError";
	}
}
