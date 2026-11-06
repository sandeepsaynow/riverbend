import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../../src/platform/config/index.js';

const full = {
  DATABASE_URL: 'postgres://app_user:app_pw@localhost:5432/riverbend',
  DATABASE_ADMIN_URL: 'postgres://app_admin:admin_pw@localhost:5432/riverbend',
  DATABASE_MIGRATOR_URL: 'postgres://riverbend_migrator:mig_pw@localhost:5432/riverbend',
  ADMIN_BOOTSTRAP_TOKEN: 'a-long-random-admin-secret',
};

describe('config refuse-to-start (FR-014 / SC-005)', () => {
  it('loads a fully valid environment', () => {
    const cfg = loadConfig(full);
    expect(cfg.PORT).toBe(8080); // default
    expect(cfg.ADMIN_BOOTSTRAP_TOKEN).toBe(full.ADMIN_BOOTSTRAP_TOKEN);
  });

  it('refuses to start when a required setting is MISSING, naming it', () => {
    const { DATABASE_URL: _omit, ...rest } = full;
    expect(() => loadConfig(rest)).toThrowError(ConfigError);
    try {
      loadConfig(rest);
    } catch (e) {
      expect((e as Error).message).toContain('DATABASE_URL');
    }
  });

  it('treats an EMPTY required setting as missing (FR-021 for the admin token)', () => {
    expect(() => loadConfig({ ...full, ADMIN_BOOTSTRAP_TOKEN: '   ' })).toThrowError(ConfigError);
    try {
      loadConfig({ ...full, ADMIN_BOOTSTRAP_TOKEN: '' });
    } catch (e) {
      expect((e as Error).message).toContain('ADMIN_BOOTSTRAP_TOKEN');
    }
  });

  it('D33: AUTO_PROVISION_SHOPS defaults true and is disabled by false/0 (the api gates boot-time provisioning on it)', () => {
    expect(loadConfig(full).AUTO_PROVISION_SHOPS).toBe(true);           // default on
    expect(loadConfig({ ...full, AUTO_PROVISION_SHOPS: 'false' }).AUTO_PROVISION_SHOPS).toBe(false);
    expect(loadConfig({ ...full, AUTO_PROVISION_SHOPS: '0' }).AUTO_PROVISION_SHOPS).toBe(false);
    expect(loadConfig({ ...full, AUTO_PROVISION_SHOPS: 'true' }).AUTO_PROVISION_SHOPS).toBe(true);
  });

  it('D33: RESEND_INBOUND_DOMAIN is optional (falls back to RESEND_REPLY_DOMAIN in the api)', () => {
    expect(loadConfig(full).RESEND_INBOUND_DOMAIN).toBeUndefined();     // unset → caller falls back
    expect(loadConfig({ ...full, RESEND_INBOUND_DOMAIN: 'karoiechou.resend.app' }).RESEND_INBOUND_DOMAIN).toBe('karoiechou.resend.app');
  });
});
