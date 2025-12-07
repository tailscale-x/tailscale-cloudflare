/**
 * Extract filename and line number from stack trace
 */
function getCallerInfo(): { filename: string; lineInfo: string } {
	const stack = new Error().stack
	if (!stack) {
		return { filename: 'unknown', lineInfo: '' }
	}

	const stackLines = stack.split('\n')
	// Skip the first line (Error) and find the first line that's not from logger.ts
	// Typically: Error -> getCallerInfo -> log method -> caller
	for (let i = 1; i < stackLines.length; i++) {
		const line = stackLines[i]
		// Match patterns like: at functionName (file:///path/to/file.ts:10:20)
		// or: at /path/to/file.ts:10:20
		// or: at Object.functionName (file:///path/to/file.ts:10:20)
		const match = line.match(/\((.+?):(\d+):(\d+)\)|at (.+?):(\d+):(\d+)/)
		if (match) {
			const filePath = match[1] || match[4]
			const lineNum = match[2] || match[5]
			
			if (filePath && 
				!filePath.includes('logger.ts') && 
				!filePath.includes('node_modules')) {
				// Extract just the filename from the path
				// Handle both file:// URLs and regular paths
				const cleanPath = filePath.replace(/^file:\/\/\/?/, '')
				const filename = cleanPath.split('/').pop()?.split('\\').pop() || cleanPath
				return { filename, lineInfo: `:${lineNum}` }
			}
		}
	}

	return { filename: 'unknown', lineInfo: '' }
}

/**
 * Format log message according to spec
 * Format: ${timestamp} ${level} [${filename}${lineInfo}] ${message}${stack}
 */
function formatLog(level: string, message: string, error?: unknown): string {
	const { filename, lineInfo } = getCallerInfo()
	const timestamp = new Date().toISOString()
	const levelUpper = level.toUpperCase()
	
	let formattedMessage = message
	let stack = ''
	
	// Handle error objects
	if (error !== undefined) {
		if (error instanceof Error) {
			if (error.stack) {
				stack = `\n${error.stack}`
			} else {
				formattedMessage = `${message} ${error.message || String(error)}`
			}
		} else {
			formattedMessage = `${message} ${String(error)}`
		}
	}
	
	return `${timestamp} ${levelUpper} [${filename}${lineInfo}] ${formattedMessage}${stack}`
}

/**
 * Log levels in order of severity (from least to most severe)
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

/**
 * Numeric values for log levels (higher = more severe)
 */
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
	DEBUG: 0,
	INFO: 1,
	WARN: 2,
	ERROR: 3,
}

/**
 * Parse log level string to LogLevel type
 * Defaults to 'INFO' if invalid
 */
function parseLogLevel(level: string | undefined): LogLevel {
	if (!level) return 'INFO'
	const upper = level.toUpperCase() as LogLevel
	if (upper in LOG_LEVEL_VALUES) {
		return upper
	}
	return 'INFO'
}

/**
 * Simple logger interface
 */
interface Logger {
	debug(message: string, ...args: unknown[]): void
	info(message: string, ...args: unknown[]): void
	warn(message: string, ...args: unknown[]): void
	error(message: string, ...args: unknown[]): void
}

/**
 * Simple logger implementation for Cloudflare Workers
 * Format: ${timestamp} ${level} [${filename}${lineInfo}] ${message}${stack}
 */
class SimpleLogger implements Logger {
	private readonly minLevel: number

	constructor(logLevel?: string) {
		const level = parseLogLevel(logLevel)
		this.minLevel = LOG_LEVEL_VALUES[level]
	}

	private shouldLog(level: LogLevel): boolean {
		return LOG_LEVEL_VALUES[level] >= this.minLevel
	}

	debug(message: string, ...args: unknown[]): void {
		if (!this.shouldLog('DEBUG')) return
		const formatted = formatLog('debug', message, args.length > 0 ? args[0] : undefined)
		console.log(formatted)
	}

	info(message: string, ...args: unknown[]): void {
		if (!this.shouldLog('INFO')) return
		const formatted = formatLog('info', message, args.length > 0 ? args[0] : undefined)
		console.log(formatted)
	}

	warn(message: string, ...args: unknown[]): void {
		if (!this.shouldLog('WARN')) return
		const formatted = formatLog('warn', message, args.length > 0 ? args[0] : undefined)
		console.warn(formatted)
	}

	error(message: string, ...args: unknown[]): void {
		if (!this.shouldLog('ERROR')) return
		const formatted = formatLog('error', message, args.length > 0 ? args[0] : undefined)
		console.error(formatted)
	}
}

/**
 * Create a logger instance with custom formatting
 * Format: ${timestamp} ${level} [${filename}${lineInfo}] ${message}${stack}
 * @param logLevel Optional log level (DEBUG, INFO, WARN, ERROR). Defaults to 'INFO' if not provided or invalid.
 */
export function createLogger(logLevel?: string): Logger {
	return new SimpleLogger(logLevel)
}
