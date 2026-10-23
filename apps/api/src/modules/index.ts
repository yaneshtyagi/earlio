import type { FastifyInstance } from 'fastify';
import { complianceRoutes } from './compliance/routes';
import { invoicingRoutes } from './invoicing/routes';
import { termsRoutes } from './terms/routes';
import { insuranceRoutes } from './insurance/routes';
import { marketplaceRoutes } from './marketplace/routes';
import { relationshipRoutes } from './identity/relationship-routes';

/** Later milestones register their route plugins here. */
export async function registerModules(app: FastifyInstance): Promise<void> {
  complianceRoutes(app);
  relationshipRoutes(app);
  invoicingRoutes(app);
  termsRoutes(app);
  insuranceRoutes(app);
  marketplaceRoutes(app);
  // invoicing, terms, insurance, marketplace, settlement ... (added per milestone)
}
