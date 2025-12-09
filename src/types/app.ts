import type { Env } from './env'
import type { SettingsVariables } from '../middleware/settings'

/**
 * Base app context type with Bindings
 */
type BaseAppContext = {
	Bindings: Env
}

/**
 * Composed Variables type from all middlewares
 * Add new middleware Variables types here by intersecting them
 * 
 * Example for adding a new middleware:
 * 1. In your middleware file, export a Variables type:
 *    export type MyMiddlewareVariables = { myVar: string }
 * 
 * 2. Import it here:
 *    import type { MyMiddlewareVariables } from '../middleware/my-middleware'
 * 
 * 3. Add it to the intersection:
 *    type AppVariables = EnvValidationVariables & MyMiddlewareVariables
 */
type AppVariables = SettingsVariables

/**
 * Complete Hono app context type
 * This type is composed from all middleware Variables
 */
export type AppContext = BaseAppContext & {
	Variables: AppVariables
}
