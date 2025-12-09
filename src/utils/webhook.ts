// Webhook Validation Utility

import { createLogger } from './logger'

const logger = createLogger()

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false
	}

	let result = 0
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return result === 0
}

/**
 * Validate Tailscale webhook signature (if secret is provided)
 * Uses HMAC-SHA256 for signature validation
 */
export async function validateWebhookSignature(
	payload: string,
	signature: string | null,
	secret: string | undefined
): Promise<boolean> {
	// If no secret is configured, skip validation
	if (!secret) {
		return true
	}

	// If secret is configured but no signature provided, reject
	if (!signature) {
		return false
	}

	try {
		// Generate HMAC-SHA256 signature
		const encoder = new TextEncoder()
		const keyData = encoder.encode(secret)
		const messageData = encoder.encode(payload)

		const key = await crypto.subtle.importKey(
			'raw',
			keyData,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		)

		const signatureBuffer = await crypto.subtle.sign('HMAC', key, messageData)

		// Convert signature to hex string
		const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('')

		// Use constant-time comparison to prevent timing attacks
		return constantTimeEqual(signature.toLowerCase(), expectedSignature.toLowerCase())
	} catch (error) {
		logger.error('Webhook signature validation error:', error)
		return false
	}
}

/**
 * Extract webhook URL from a request by normalizing to the /webhook path.
 */
export function extractWebhookUrlFromRequest(request: Request): string {
	const url = new URL(request.url)
	const baseUrl = `${url.protocol}//${url.host}`
	return `${baseUrl}/webhook`
}
