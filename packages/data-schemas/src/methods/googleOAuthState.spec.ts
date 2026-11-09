import { tenantStorage } from '~/config/tenantContext';
import { createGoogleOAuthStateMethods } from './googleOAuthState';

describe('Google OAuth state persistence methods', () => {
  const tenantId = 'tenant-a';
  const principalId = 'user-a';
  const installationId = '64b000000000000000000001';
  const stateHash = 'A'.repeat(43);
  const input = () => ({
    stateHash,
    tenantId,
    principalId,
    installationId,
    redirectUri: 'https://app.example.test/api/connectors/google-workspace/callback',
    encryptedCodeVerifier: JSON.stringify({
      version: 'gcm1',
      nonce: '11'.repeat(12),
      tag: '22'.repeat(16),
      ciphertext: '33'.repeat(24),
    }),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  function setup() {
    const create = jest.fn().mockResolvedValue({});
    const exec = jest.fn().mockResolvedValue({
      stateHash,
      tenantId,
      principalId,
      installationId,
      redirectUri: input().redirectUri,
      encryptedCodeVerifier: input().encryptedCodeVerifier,
      expiresAt: input().expiresAt,
    });
    const lean = jest.fn().mockReturnValue({ exec });
    const select = jest.fn().mockReturnValue({ lean });
    const findOneAndDelete = jest.fn().mockReturnValue({ select });
    const mongoose = {
      models: { GoogleOAuthState: { create, findOneAndDelete } },
      isValidObjectId: jest.fn().mockReturnValue(true),
    } as unknown as typeof import('mongoose');
    return {
      methods: createGoogleOAuthStateMethods(mongoose),
      create,
      findOneAndDelete,
      select,
      lean,
      exec,
    };
  }

  it('creates state only when its tenant and principal match trusted context', async () => {
    const { methods, create } = setup();
    await tenantStorage.run({ tenantId, userId: principalId }, async () => {
      await methods.createGoogleOAuthState(input());
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      stateHash,
      tenantId,
      principalId,
      installationId,
      encryptedCodeVerifier: expect.any(String),
    }));
  });

  it('rejects a caller-supplied tenant or principal mismatch', async () => {
    const { methods, create } = setup();
    await tenantStorage.run({ tenantId, userId: principalId }, async () => {
      await expect(methods.createGoogleOAuthState({
        ...input(),
        tenantId: 'tenant-b',
      })).rejects.toThrow('trusted request context');
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('atomically consumes only an unexpired hash and returns no document internals', async () => {
    const { methods, findOneAndDelete, select, lean, exec } = setup();
    const result = await methods.consumeGoogleOAuthState(stateHash);
    expect(findOneAndDelete).toHaveBeenCalledWith({
      stateHash,
      expiresAt: { $gt: expect.any(Date) },
    });
    expect(select).toHaveBeenCalledWith(
      '+encryptedCodeVerifier stateHash tenantId principalId installationId redirectUri expiresAt',
    );
    expect(lean).toHaveBeenCalled();
    expect(exec).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ stateHash, tenantId, principalId }));
    expect(result).not.toHaveProperty('_id');
  });

  it('does not query the database for malformed hashes', async () => {
    const { methods, findOneAndDelete } = setup();
    await expect(methods.consumeGoogleOAuthState('not-a-state-hash')).resolves.toBeNull();
    expect(findOneAndDelete).not.toHaveBeenCalled();
  });
});
