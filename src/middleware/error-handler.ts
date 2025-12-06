import type { ErrorHandler } from 'hono'
import { createLogger } from '../utils/logger'
import { AppError, ValidationError, ConfigurationError, ApiError } from '../utils/errors'

const logger = createLogger()

/**
 * Global error handler middleware for Hono
 * Catches all unhandled errors and returns a proper JSON response
 */
export const errorHandler: ErrorHandler = (err, c) => {
	logger.error('Unhandled error in request handler:', err)

	// Handle custom error types
	if (err instanceof ValidationError) {
		return c.json(
			{
				error: err.message,
			},
			err.statusCode as any
		)
	}

	if (err instanceof ConfigurationError) {
		return c.json(
			{
				error: err.message,
			},
			err.statusCode as any
		)
	}

	if (err instanceof ApiError) {
		return c.json(
			{
				error: err.message,
				service: err.service,
				...(err.apiStatusCode && { apiStatusCode: err.apiStatusCode }),
			},
			err.statusCode as any
		)
	}

	if (err instanceof AppError) {
		return c.json(
			{
				error: err.message,
			},
			err.statusCode as any
		)
	}

	// Fallback for unknown errors
	const statusCode = err instanceof Error ? 500 : 500
	const errorMessage = err instanceof Error ? err.message : 'Internal server error'

	return c.json(
		{
			error: errorMessage,
			status: statusCode,
		},
		statusCode
	)
}

