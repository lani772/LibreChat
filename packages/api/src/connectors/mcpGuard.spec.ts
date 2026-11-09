import type { ConnectorInstallationDocument } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '../mcp/types';
import { createConnectorMCPAuthorizationGuard } from './mcpGuard';

const config = (overrides: Partial<ParsedServerConfig> = {}) =>
  ({ dbId: '507f1f77bcf86cd799439011', source: 'user', ...overrides }) as ParsedServerConfig;

describe('createConnectorMCPAuthorizationGuard', () => {
  it('does nothing for an ordinary MCP server without a database record ID', async () => {
    const find = jest.fn();
    const authorize = jest.fn();
    await createConnectorMCPAuthorizationGuard({
      findInstallationByMCPServerId: find,
      authorizeInstallation: authorize,
    })(config({ dbId: undefined }));
    expect(find).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it('leaves an unbound ordinary MCP server unchanged', async () => {
    const authorize = jest.fn();
    await createConnectorMCPAuthorizationGuard({
      findInstallationByMCPServerId: jest.fn().mockResolvedValue(null),
      authorizeInstallation: authorize,
    })(config());
    expect(authorize).not.toHaveBeenCalled();
  });

  it('authorizes using the installation linked to the trusted MCP database ID', async () => {
    const installation = { _id: { toString: () => 'installation-id' } } as Pick<
      ConnectorInstallationDocument,
      '_id'
    >;
    const find = jest.fn().mockResolvedValue(installation);
    const authorize = jest.fn().mockResolvedValue(undefined);
    await createConnectorMCPAuthorizationGuard({
      findInstallationByMCPServerId: find,
      authorizeInstallation: authorize,
    })(config());
    expect(find).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
    expect(authorize).toHaveBeenCalledWith('installation-id');
  });

  it('propagates lookup errors instead of treating an outage as an unbound server', async () => {
    const authorize = jest.fn();
    const guard = createConnectorMCPAuthorizationGuard({
      findInstallationByMCPServerId: jest.fn().mockRejectedValue(new Error('database offline')),
      authorizeInstallation: authorize,
    });
    await expect(guard(config())).rejects.toThrow('database offline');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('propagates authorization denials', async () => {
    const guard = createConnectorMCPAuthorizationGuard({
      findInstallationByMCPServerId: jest.fn().mockResolvedValue({
        _id: { toString: () => 'installation-id' },
      }),
      authorizeInstallation: jest.fn().mockRejectedValue(new Error('denied')),
    });
    await expect(guard(config())).rejects.toThrow('denied');
  });
});
