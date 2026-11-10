jest.mock('@librechat/data-schemas', () => ({
  getUserId: jest.fn(() => 'user-a'),
  getTenantId: jest.fn(() => 'tenant-a'),
}));

jest.mock('~/models', () => ({
  listConnectorInstallations: jest.fn(),
}));

jest.mock('~/server/services/initializeMCPs', () => ({
  getGoogleDriveReadOnlyConnector: jest.fn(),
}));

const { getUserId, getTenantId } = require('@librechat/data-schemas');
const db = require('~/models');
const { getGoogleDriveReadOnlyConnector } = require('~/server/services/initializeMCPs');
const GoogleDrive = require('./GoogleDrive');

describe('Google Drive agent tool', () => {
  const drive = {
    listFiles: jest.fn(),
    getFile: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getUserId.mockReturnValue('user-a');
    getTenantId.mockReturnValue('tenant-a');
    getGoogleDriveReadOnlyConnector.mockReturnValue(drive);
  });

  it('fails closed when trusted tenant context is missing', async () => {
    getTenantId.mockReturnValue(undefined);
    await expect(new GoogleDrive()._call({ action: 'search_files' })).resolves.toContain(
      'Google Drive could not complete',
    );
    expect(db.listConnectorInstallations).not.toHaveBeenCalled();
    expect(drive.listFiles).not.toHaveBeenCalled();
  });

  it('fails closed when authenticated principal is missing', async () => {
    getUserId.mockReturnValue(undefined);
    await expect(new GoogleDrive()._call({ action: 'search_files' })).resolves.toContain(
      'Google Drive could not complete',
    );
    expect(db.listConnectorInstallations).not.toHaveBeenCalled();
    expect(drive.listFiles).not.toHaveBeenCalled();
  });

  it('uses the only connected account owned by the trusted principal', async () => {
    db.listConnectorInstallations.mockResolvedValue([{
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      displayName: 'Work Drive',
    }]);
    drive.listFiles.mockResolvedValue({ files: [{ id: 'file-1', name: 'Budget' }] });
    const tool = new GoogleDrive();
    const result = await tool._call({ action: 'search_files', query: "name contains 'Budget'" });
    expect(db.listConnectorInstallations).toHaveBeenCalledWith({
      ownerUserId: 'user-a',
      provider: 'google-workspace',
      state: 'connected',
      limit: 50,
    });
    expect(drive.listFiles).toHaveBeenCalledWith({
      installationId: '507f1f77bcf86cd799439011',
      query: "name contains 'Budget'",
    });
    expect(JSON.parse(result).files[0].name).toBe('Budget');
  });

  it('asks the model to select an account when multiple are connected', async () => {
    db.listConnectorInstallations.mockResolvedValue([
      { _id: { toString: () => 'id-a' }, displayName: 'Personal' },
      { _id: { toString: () => 'id-b' }, displayName: 'Work' },
    ]);
    const result = JSON.parse(await new GoogleDrive()._call({ action: 'search_files' }));
    expect(result.accounts).toHaveLength(2);
    expect(drive.listFiles).not.toHaveBeenCalled();
  });

  it('does not contact Google when the user has no connected account', async () => {
    db.listConnectorInstallations.mockResolvedValue([]);
    const result = JSON.parse(await new GoogleDrive()._call({ action: 'search_files' }));
    expect(result.error).toMatch(/No connected Google Workspace account/);
    expect(drive.listFiles).not.toHaveBeenCalled();
  });

  it('passes explicit installation IDs to the connector authorization boundary', async () => {
    drive.getFile.mockResolvedValue({ id: 'file-1', name: 'Report' });
    const result = await new GoogleDrive()._call({
      action: 'get_file_metadata',
      installationId: '507f1f77bcf86cd799439011',
      fileId: 'file-1',
    });
    expect(drive.getFile).toHaveBeenCalledWith({
      installationId: '507f1f77bcf86cd799439011',
      fileId: 'file-1',
    });
    expect(JSON.parse(result).name).toBe('Report');
  });

  it('does not expose provider errors to the model', async () => {
    db.listConnectorInstallations.mockResolvedValue([{
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      displayName: 'Work Drive',
    }]);
    drive.listFiles.mockRejectedValue(new Error('secret response body'));
    const result = await new GoogleDrive()._call({ action: 'search_files' });
    expect(result).not.toContain('secret response body');
  });
});
