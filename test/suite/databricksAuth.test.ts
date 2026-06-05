import { strict as assert } from 'assert';
import {
  AUTH_ERROR_SIGNATURES,
  isTaggableAuthError,
  isAuthStorageCacheError,
  isRefreshTokenInvalidError,
} from '../../src/utils/databricksAuth';
// Re-exported from the service; asserts the single source is what
// extension.ts imports.
import {
  isAuthStorageCacheError as svcStorageCache,
  isRefreshTokenInvalidError as svcRefreshInvalid,
} from '../../src/services/lakebaseService';

describe('databricksAuth (single source of truth for auth-error classification)', () => {
  describe('isTaggableAuthError', () => {
    for (const sig of AUTH_ERROR_SIGNATURES) {
      it(`matches generic signature: "${sig}"`, () => {
        assert.ok(isTaggableAuthError(`prefix ${sig} suffix`));
      });
    }
    it('does not match an unrelated error', () => {
      assert.ok(!isTaggableAuthError('disk full'));
    });
  });

  describe('isAuthStorageCacheError', () => {
    it('matches the old-CLI-cache rejection', () => {
      assert.ok(isAuthStorageCacheError(
        new Error('stored credentials from older CLI versions are no longer used'),
      ));
    });
    it('accepts a raw string too', () => {
      assert.ok(isAuthStorageCacheError('stored credentials from older CLI versions'));
    });
    it('does not match a refresh-token error', () => {
      assert.ok(!isAuthStorageCacheError(new Error('refresh token is invalid')));
    });
  });

  describe('isRefreshTokenInvalidError (union of lakebase + runner matchers)', () => {
    // The strings each former copy matched; the unified predicate must
    // catch ALL of them so neither caller regresses.
    const shouldMatch = [
      'refresh token is invalid',            // lakebaseService
      'access token could not be retrieved', // lakebaseService
      'cannot get access token',             // runnerService
      'unauthenticated',                     // runnerService
      'Error: Refresh Token Is Invalid',     // case-insensitive
    ];
    for (const m of shouldMatch) {
      it(`matches: "${m}"`, () => {
        assert.ok(isRefreshTokenInvalidError(new Error(m)));
        assert.ok(isRefreshTokenInvalidError(m), 'string form');
      });
    }
    it('does not match the storage-cache error', () => {
      assert.ok(!isRefreshTokenInvalidError(new Error('stored credentials from older CLI versions')));
    });
    it('does not match an unrelated error', () => {
      assert.ok(!isRefreshTokenInvalidError(new Error('connection reset')));
    });
  });

  describe('service re-exports point at the same implementation', () => {
    it('lakebaseService.isAuthStorageCacheError === the util', () => {
      assert.strictEqual(svcStorageCache, isAuthStorageCacheError);
    });
    it('lakebaseService.isRefreshTokenInvalidError === the util', () => {
      assert.strictEqual(svcRefreshInvalid, isRefreshTokenInvalidError);
    });
  });
});
