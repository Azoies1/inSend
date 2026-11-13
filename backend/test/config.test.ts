import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { InvalidAmountError, cents } from '../src/money';
import { FakeAdapter } from '../src/payments/adapters/fake/FakeAdapter';
import { AdapterNotImplementedError } from '../src/payments/provider';
import { createProvider } from '../src/payments/registry';

describe('loadConfig', () => {
  it('falls back to local sandbox defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ port: 3000, host: '127.0.0.1', paymentAdapter: 'fake' });
    expect(new URL(config.databaseUrl).hostname).toBe('127.0.0.1');
  });

  it('treats empty values as unset, so a copied .env.example works', () => {
    const config = loadConfig({ PORT: '', HOST: '', DATABASE_URL: '', PAYMENT_ADAPTER: ' ' });
    expect(config).toMatchObject({ port: 3000, paymentAdapter: 'fake' });
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({ PORT: '4100', PAYMENT_ADAPTER: 'zum' });
    expect(config).toMatchObject({ port: 4100, paymentAdapter: 'zum' });
  });

  it('fails loudly on invalid values', () => {
    expect(() => loadConfig({ PAYMENT_ADAPTER: 'stripe' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
  });
});

describe('createProvider', () => {
  it('selects the adapter by name', () => {
    expect(createProvider('fake')).toBeInstanceOf(FakeAdapter);
  });

  it('refuses adapters that are not built yet instead of silently faking them', () => {
    expect(() => createProvider('rtr-sim')).toThrow(AdapterNotImplementedError);
    expect(() => createProvider('zum')).toThrow(AdapterNotImplementedError);
  });
});

describe('cents', () => {
  it('accepts integers and rejects fractional or non-finite amounts', () => {
    expect(cents(185000)).toBe(185000);
    for (const bad of [0.1 + 0.2, 1850.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => cents(bad)).toThrow(InvalidAmountError);
    }
  });
});
