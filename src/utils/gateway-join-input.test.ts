import { describe, expect, it } from 'vitest'
import { gatewayJoinInputSchema } from './gateway-join-input'

describe('gateway join input', () => {
    const base = { machineName: 'gateway-vps', gatewayHostname: 'gateway.example.com', tags: ['tag:server'] }
    it('accepts caller-selected tags', () => {
        expect(gatewayJoinInputSchema.safeParse({ ...base, tags: ['tag:web', 'tag:egress'] }).success).toBe(true)
    })
    it.each([[[]], [['server']], [['tag:']], [['tag:invalid tag']]])('rejects invalid tags', tags => {
        expect(gatewayJoinInputSchema.safeParse({ ...base, tags }).success).toBe(false)
    })
})
