import type { FastifyInstance } from 'fastify';
import { complianceRoutes } from './compliance/routes';
import { invoicingRoutes } from './invoicing/routes';
import { termsRoutes } from './terms/routes';
import { insuranceRoutes } from './insurance/routes';
import { marketplaceRoutes } from './marketplace/routes';
import { settlementRoutes } from './settlement/routes';
import { recoveryRoutes } from './recovery/routes';
import { disputeRoutes } from './invoicing/dispute-routes';
import { notifyRoutes } from './notify/routes';
import { governanceRoutes } from './governance/routes';
import { integrationRoutes } from './integration/routes';
import { demoRoutes } from '../demo/routes';
import { analyticsRoutes } from './analytics/routes';
import { relationshipRoutes } from './identity/relationship-routes';

/** Later milestones register their route plugins here. */
export async function registerModules(app: FastifyInstance): Promise<void> {
  complianceRoutes(app);
  relationshipRoutes(app);
  invoicingRoutes(app);
  termsRoutes(app);
  insuranceRoutes(app);
  marketplaceRoutes(app);
  settlementRoutes(app);
  notifyRoutes(app);
  disputeRoutes(app);
  recoveryRoutes(app);
  governanceRoutes(app);
  analyticsRoutes(app);
  integrationRoutes(app);
  demoRoutes(app);
  // invoicing, terms, insurance, marketplace, settlement ... (added per milestone)
}
