import { z } from 'zod'

export const gatewayJoinInputSchema = z.object({
    machineName: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Use a valid Tailscale machine name'),
    gatewayHostname: z.string().min(4).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'Use a fully qualified DNS hostname'),
    tags: z.array(z.string().regex(/^tag:[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use tags such as tag:server')).min(1),
})
