/**
 * Express namespace augmentation — makes `req.user` available on the base
 * `Request` type so every route can access it without `as any` casts.
 * Imported by `auth.ts`; TypeScript picks it up automatically at compile time.
 */
import type { JwtPayload } from '../auth.js';

declare global {
  namespace Express {
    interface Request {
      /** Populated by `requireAuth` / `optionalAuth` middleware. */
      user?: JwtPayload;
      /** Populated by `requireDocRole` middleware. */
      docRole?: import('../permissions.js').Role;
    }
  }
}
