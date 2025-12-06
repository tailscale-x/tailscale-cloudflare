/**
 * Custom error classes for the application
 * These provide type-safe error handling and proper HTTP status code mapping
 */

/**
 * Base application error class
 */
export class AppError extends Error {
	constructor(message: string, public readonly statusCode: number = 500) {
		super(message)
		this.name = this.constructor.name
		// Maintains proper stack trace for where our error was thrown (only available on V8)
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor)
		}
	}
}

/**
 * Validation error for invalid input (e.g., invalid regex pattern)
 * Maps to HTTP 400 Bad Request
 */
export class ValidationError extends AppError {
	constructor(message: string) {
		super(message, 400)
	}
}

/**
 * Configuration error for environment/configuration issues
 * Maps to HTTP 500 Internal Server Error
 */
export class ConfigurationError extends AppError {
	constructor(message: string) {
		super(message, 500)
	}
}

/**
 * API error for external service failures (Tailscale, Cloudflare)
 * Maps to HTTP 502 Bad Gateway
 */
export class ApiError extends AppError {
	constructor(
		message: string,
		public readonly service: string,
		public readonly apiStatusCode?: number
	) {
		super(message, 502)
	}
}

