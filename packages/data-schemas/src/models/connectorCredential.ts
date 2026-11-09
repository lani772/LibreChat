import type { Model } from 'mongoose';
import type { ConnectorCredentialDocument } from '~/types/connectorCredential';
import connectorCredentialSchema from '~/schema/connectorCredential';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export function createConnectorCredentialModel(
  mongoose: typeof import('mongoose'),
): Model<ConnectorCredentialDocument> {
  applyTenantIsolation(connectorCredentialSchema);
  return (
    mongoose.models.ConnectorCredential ??
    mongoose.model<ConnectorCredentialDocument>('ConnectorCredential', connectorCredentialSchema)
  );
}
