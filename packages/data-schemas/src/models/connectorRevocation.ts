import type { Model } from 'mongoose';
import type { ConnectorRevocationDocument } from '~/types/connectorRevocation';
import connectorRevocationSchema from '~/schema/connectorRevocation';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export function createConnectorRevocationModel(
  mongoose: typeof import('mongoose'),
): Model<ConnectorRevocationDocument> {
  applyTenantIsolation(connectorRevocationSchema);
  return (
    mongoose.models.ConnectorRevocation ??
    mongoose.model<ConnectorRevocationDocument>('ConnectorRevocation', connectorRevocationSchema)
  );
}
