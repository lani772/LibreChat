import type { Model } from 'mongoose';
import type { ConnectorInstallationDocument } from '~/types/connectorInstallation';
import connectorInstallationSchema from '~/schema/connectorInstallation';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export function createConnectorInstallationModel(
  mongoose: typeof import('mongoose'),
): Model<ConnectorInstallationDocument> {
  applyTenantIsolation(connectorInstallationSchema);
  return (
    mongoose.models.ConnectorInstallation ??
    mongoose.model<ConnectorInstallationDocument>(
      'ConnectorInstallation',
      connectorInstallationSchema,
    )
  );
}
