
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
